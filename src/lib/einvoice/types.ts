import { AppError } from "@/lib/enforcement/errors";

/**
 * e-Fatura / e-Arşiv — the integrator-independent contract.
 *
 * An e-fatura never goes straight to the GİB: it is submitted through a private
 * integrator (özel entegratör), and every one of them exposes a different API.
 * What does NOT vary is the document itself — UBL-TR 1.2 — and the states it
 * moves through. Those live here; the integrator is a port with one
 * implementation per provider, added when one is chosen.
 *
 * The split matters because the expensive, rule-heavy part (building a valid
 * UBL-TR invoice from our data) is the part that is the same regardless of who
 * transmits it. Picking a provider later should mean writing one adapter, not
 * revisiting how an invoice is expressed.
 */

/**
 * Which document a supply produces.
 *
 * The rule is the customer's registration, not our preference: a buyer enrolled
 * in the GİB e-fatura user list MUST receive an e-fatura, and everyone else gets
 * an e-arşiv. Getting this backwards is a rejected document, so it is resolved
 * from a lookup rather than chosen by hand — see `EInvoiceIntegrator.isRegistered`.
 */
export type EInvoiceKind = "efatura" | "earsiv";

/**
 * UBL profile.
 *
 *   TEMELFATURA   — basic: the buyer cannot formally reject it
 *   TICARIFATURA  — commercial: the buyer may accept or reject within 8 days
 *   EARSIVFATURA  — e-arşiv, for buyers outside the e-fatura system
 */
export type EInvoiceProfile = "TEMELFATURA" | "TICARIFATURA" | "EARSIVFATURA";

/** `cbc:InvoiceTypeCode` — what kind of supply this documents. */
export type EInvoiceTypeCode = "SATIS" | "IADE" | "TEVKIFAT" | "ISTISNA" | "OZELMATRAH" | "IHRACKAYITLI";

/** A party on the invoice — us (supplier) or the customer. */
export interface UblParty {
  /** Registered name for a legal entity. */
  name: string;
  /** VKN (10 digits) or TCKN (11 digits). Length decides `schemeID`. */
  taxNumber: string;
  /** Vergi dairesi — required for a VKN, absent for an individual. */
  taxOffice?: string;
  street?: string;
  /** İlçe. */
  district?: string;
  /** İl. */
  city?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
}

export interface UblLine {
  /** 1-based position on the invoice. */
  index: number;
  name: string;
  quantity: number;
  /** UN/ECE Rec 20 code — "C62" is the general "piece". */
  unitCode?: string;
  unitPrice: number;
  /** Line net, after any discount. */
  lineAmount: number;
  /** KDV percentage on this line. */
  vatRate: number;
  vatAmount: number;
}

export interface UblInvoice {
  /**
   * Invoice number in the statutory format: 3-letter series + 4-digit year +
   * 9-digit sequence, e.g. "AUL2026000000001". Exactly 16 characters — the GİB
   * rejects anything else, so it is validated rather than assumed.
   */
  id: string;
  /** ETTN — the document's UUID. Assigned once and never reused. */
  uuid: string;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS
  profile: EInvoiceProfile;
  typeCode: EInvoiceTypeCode;
  currencyCode: string;
  supplier: UblParty;
  customer: UblParty;
  lines: UblLine[];
  /** Sum of line nets — the VAT base. */
  lineExtensionAmount: number;
  taxExclusiveAmount: number;
  taxInclusiveAmount: number;
  /** What the customer actually pays (excludes VAT withheld under tevkifat). */
  payableAmount: number;
  /** Total KDV calculated, before withholding. */
  vatTotal: number;
  /** KDV withheld by the buyer, if any. */
  withholdingAmount?: number;
  /** Withholding ratio in tenths (5 = 5/10), for the tevkifat block. */
  withholdingRatioTenths?: number;
  notes?: string[];
}

/** The identifiers a transmitter needs alongside the document itself. */
export interface EInvoiceRef {
  /** Statutory number (16 chars). */
  documentNumber: string;
  /** ETTN. */
  uuid: string;
  kind: EInvoiceKind;
  profile: EInvoiceProfile;
}

/** What an integrator reports back about a submitted document. */
export type EInvoiceStatus = "queued" | "sent" | "accepted" | "rejected" | "cancelled" | "error";

export interface EInvoiceSendResult {
  status: EInvoiceStatus;
  /** The integrator's own reference, for later status polls. */
  externalId?: string;
  message?: string;
}

/**
 * The port every integrator implements.
 *
 * Deliberately small: submit a document, ask about one, and answer whether a tax
 * number is enrolled in the e-fatura system. Everything else — building the XML,
 * numbering, state — is ours and stays ours.
 */
export interface EInvoiceIntegrator {
  /** Provider name, for logs and the settings screen. */
  readonly name: string;

  /**
   * Is this taxpayer registered for e-fatura?
   *
   * Decides `efatura` vs `earsiv`. Implementations are expected to cache: the
   * GİB user list changes daily, not per request.
   */
  isRegistered(taxNumber: string): Promise<boolean>;

  /**
   * Submit a UBL-TR document.
   *
   * Takes the serialised XML plus the few identifiers a transmitter needs — not
   * the whole `UblInvoice`. The document is the payload; re-deriving it from a
   * model would let the two disagree, and what was stored is what was sent.
   */
  send(xml: string, ref: EInvoiceRef): Promise<EInvoiceSendResult>;

  /** Current status of a previously submitted document. */
  status(externalId: string): Promise<EInvoiceSendResult>;

  /** Cancel an e-arşiv invoice (e-fatura cannot be cancelled, only reversed). */
  cancel?(externalId: string, reason: string): Promise<EInvoiceSendResult>;
}

/**
 * A configuration problem, not a server fault.
 *
 * Surfaced as a 422 with a client-safe message so the operator reads "no
 * integrator is configured" instead of "an unexpected error occurred" — the
 * whole point is that the reason is actionable.
 */
export class EInvoiceError extends AppError {
  constructor(message: string) {
    super("EINVOICE", 422, message);
  }
}

/**
 * Placeholder used until a provider is chosen.
 *
 * It fails loudly rather than pretending to succeed: a silent no-op here would
 * mean invoices marked sent that the tax office never received, which is worse
 * than not being wired up at all. Everything up to transmission — building,
 * validating and storing the document — still works, so the rest of the system
 * can be finished and tested without a provider.
 */
export class UnconfiguredIntegrator implements EInvoiceIntegrator {
  readonly name = "unconfigured";

  private fail(): never {
    throw new EInvoiceError(
      "no e-invoice integrator is configured — set one up in Settings before sending (the document was built and stored, only transmission is unavailable)",
    );
  }

  // Parameters are declared even though nothing reads them: the class has to be
  // callable exactly like a real provider, so a caller written against the port
  // compiles against this one too.
  isRegistered(_taxNumber: string): Promise<boolean> {
    // Cannot be known without a provider. Treating everyone as unregistered
    // would quietly route e-fatura customers to e-arşiv, so refuse instead.
    this.fail();
  }
  send(_xml: string, _ref: EInvoiceRef): Promise<EInvoiceSendResult> {
    this.fail();
  }
  status(_externalId: string): Promise<EInvoiceSendResult> {
    this.fail();
  }
}

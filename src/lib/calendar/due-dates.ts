/**
 * Operational due dates on the calendar.
 *
 * The calendar was a standalone diary: whatever someone typed into it. Meanwhile
 * every date that actually governs the business already existed on a document —
 * when a purchase order is expected, when an invoice must be collected, when a
 * supplier bill must be paid — and none of it was visible anywhere except by
 * opening the document. "What is due this week" was a question the system held
 * the answer to and could not be asked.
 *
 * This projects those dates onto `calendarEvent`. Two rules keep the projection
 * from fighting the person using it:
 *
 *  - Generated events are marked (`generatedFrom`) and only ever rewritten by
 *    the generator. A hand-written event is never touched, moved or deleted by
 *    a sync, because losing something a person typed is far worse than showing a
 *    due date twice.
 *  - The document is the source of truth. Editing the calendar entry does not
 *    move the invoice's due date; the next run puts it back. The alternative —
 *    letting a diary entry silently change a payment term — is not a feature.
 *
 * Settled documents are removed from the calendar rather than left as noise: a
 * paid invoice is not owed anything, and a calendar full of things that already
 * happened is one nobody reads.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { logger } from "@/lib/observability/logger";

/** One kind of due date we project, and how to read it off its document. */
interface Projection {
  /** Source entity. */
  entity: string;
  /** `generatedFrom` marker — also the key that makes regeneration idempotent. */
  kind: string;
  /** Field holding the date. */
  dateField: string;
  /** Field holding the human-facing document number. */
  numberField: string;
  /** `calendarEvent.type` for these — drives the colour on the calendar. */
  eventType: "deadline" | "reminder" | "event";
  /** Statuses that still need attention. Anything else is removed. */
  openStatuses: readonly string[];
  /** Status field name (documents use `status`; lifecycle ones use `stage`). */
  statusField: string;
  title: (doc: EntityRecord) => string;
}

const PROJECTIONS: Projection[] = [
  {
    entity: "purchaseOrder",
    kind: "purchaseOrder.expected",
    dateField: "expectedDate",
    numberField: "number",
    eventType: "event",
    // A received or cancelled order is not still expected.
    openStatuses: ["draft", "submitted", "approved", "partial", "ordered"],
    statusField: "status",
    title: (d) => `Sipariş teslim: ${String(d.number ?? d.id)}`,
  },
  {
    entity: "invoice",
    kind: "invoice.due",
    dateField: "dueDate",
    numberField: "number",
    eventType: "deadline",
    // `paid` and `void` are done; everything else is still collectible.
    openStatuses: ["draft", "sent", "partial", "overdue", "issued"],
    statusField: "status",
    title: (d) => `Tahsilat vadesi: ${String(d.number ?? d.id)}`,
  },
  {
    entity: "vendorBill",
    kind: "vendorBill.due",
    dateField: "dueDate",
    numberField: "number",
    eventType: "deadline",
    openStatuses: ["draft", "received", "approved", "partial", "overdue"],
    statusField: "status",
    title: (d) => `Ödeme vadesi: ${String(d.number ?? d.id)}`,
  },
];

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
}

/**
 * Rebuild the generated calendar entries.
 *
 * Deliberately full-sweep rather than incremental. The set of open documents is
 * small (a settled one drops out), and a sweep is self-correcting: a missed
 * event, a date edited directly in the database, a run that died halfway — all
 * converge on the next pass. An incremental version would need its own change
 * log to be as reliable, which is more machinery to be wrong.
 */
export async function syncDueDates(ctx: RequestContext): Promise<SyncResult> {
  const qe = await getQueryEngine();
  const result: SyncResult = { created: 0, updated: 0, removed: 0 };

  for (const p of PROJECTIONS) {
    // Existing generated events for this projection, keyed by the document they
    // came from. Read in full: `listComplete` raises rather than truncating, so
    // a set larger than one page can never leave stale events behind that this
    // run simply did not see — which would look exactly like a phantom due date.
    const existing = await qe.listComplete(ctx, "calendarEvent", {
      filters: [{ field: "generatedFrom", op: "eq", value: p.kind }],
    });
    // Keyed on `refId` alone, which is safe ONLY because `existing` is already
    // narrowed to this one projection. Record ids are per-table integers, so
    // invoice #1 and purchase order #1 share a `refId` — merging these loops
    // into one pass over all generated events would silently make each
    // projection delete the other's entries.
    const byRef = new Map<string, EntityRecord>();
    for (const e of existing) byRef.set(String(e.refId ?? ""), e);

    const docs = await qe.listComplete(ctx, p.entity, {
      filters: [{ field: p.statusField, op: "in", value: [...p.openStatuses] }],
    });

    const seen = new Set<string>();
    for (const doc of docs) {
      const date = doc[p.dateField];
      // A document with no due date is not overdue; it is unscheduled. Inventing
      // a date for it would create a deadline nobody agreed to.
      if (!date) continue;
      const id = String(doc.id);
      seen.add(id);

      const desired = {
        title: p.title(doc),
        date: String(date).slice(0, 10),
        allDay: true,
        type: p.eventType,
        status: "planned",
        refType: p.entity,
        refId: id,
      };
      // `generatedFrom` is read-only to clients, so it goes through the computed
      // channel — the same route document numbers and totals take. That is what
      // stops a person marking their own event as generated and having a later
      // sweep delete it.
      const marker = { generatedFrom: p.kind };

      const current = byRef.get(id);
      if (!current) {
        await qe.createWithComputed(ctx, "calendarEvent", desired, marker);
        result.created += 1;
        continue;
      }
      // Only write when something actually differs, so an unchanged document
      // does not bump a version and produce an audit entry every single run.
      const changed =
        current.title !== desired.title ||
        String(current.date ?? "").slice(0, 10) !== desired.date ||
        current.type !== desired.type;
      if (changed) {
        await qe.patchComputed(ctx, "calendarEvent", String(current.id), { ...desired, ...marker });
        result.updated += 1;
      }
    }

    // Anything generated for a document that is no longer open (paid, cancelled,
    // received) or has lost its date.
    for (const [refId, event] of byRef) {
      if (seen.has(refId)) continue;
      await qe.remove(ctx, "calendarEvent", String(event.id));
      result.removed += 1;
    }
  }

  logger.info("calendar due dates synced", { ...result });
  return result;
}

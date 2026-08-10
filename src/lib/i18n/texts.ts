/**
 * Texts the backend WRITES — in the organisation's language.
 *
 * Error messages localize per REQUEST (`lib/i18n/errors.ts`), because an error
 * answers one caller. The texts here are different: notification rows, tasks
 * created by workflows/automations, ops-alert titles. They are STORED and read
 * later by whoever opens the screen, so they follow the org's working language
 * (`AULA_DEFAULT_LOCALE`, "tr" unless configured otherwise) rather than the
 * locale of whichever request happened to trigger them.
 *
 * Before this module every one of these was written in English — including
 * task RECORDS ("Kick off onboarding for won deal") sitting as data on the
 * Tasks screen of a Turkish install.
 */
import { env } from "@/lib/config/env";
import { interpolate } from "@aula/contracts/i18n/errors";

type OrgText = { en: string; tr: string; de: string };

const TEXTS: Record<string, OrgText> = {
  // ---- notifications (web bell + mobile push) -------------------------------
  "notif.quoteSent.subject": { en: "Quote sent", tr: "Teklif gönderildi", de: "Angebot gesendet" },
  "notif.quoteSent.body": {
    en: "Quote {number} was emailed to the customer.",
    tr: "{number} numaralı teklif müşteriye e-postayla gönderildi.",
    de: "Angebot {number} wurde dem Kunden per E-Mail gesendet.",
  },
  "notif.invoiceSent.subject": { en: "Invoice sent", tr: "Fatura gönderildi", de: "Rechnung gesendet" },
  "notif.invoiceSent.body": {
    en: "Invoice {number} was emailed to the customer.",
    tr: "{number} numaralı fatura müşteriye e-postayla gönderildi.",
    de: "Rechnung {number} wurde dem Kunden per E-Mail gesendet.",
  },
  "notif.dealWon.subject": { en: "Deal won 🎉", tr: "Fırsat kazanıldı 🎉", de: "Geschäft gewonnen 🎉" },
  "notif.dealWon.body": {
    en: "A deal was marked won ({id}).",
    tr: "Bir fırsat kazanıldı olarak işaretlendi ({id}).",
    de: "Ein Geschäft wurde als gewonnen markiert ({id}).",
  },
  "notif.poSubmitted.subject": {
    en: "Purchase order needs approval",
    tr: "Satınalma siparişi onay bekliyor",
    de: "Bestellung wartet auf Genehmigung",
  },
  "notif.poSubmitted.body": {
    en: "PO {number} is waiting for your approval.",
    tr: "{number} numaralı satınalma siparişi onayınızı bekliyor.",
    de: "Bestellung {number} wartet auf Ihre Genehmigung.",
  },
  "notif.poApproved.subject": {
    en: "Purchase order approved",
    tr: "Satınalma siparişi onaylandı",
    de: "Bestellung genehmigt",
  },
  "notif.poApproved.body": {
    en: "PO {number} was approved and is ready to receive.",
    tr: "{number} numaralı satınalma siparişi onaylandı; mal kabulüne hazır.",
    de: "Bestellung {number} wurde genehmigt und kann empfangen werden.",
  },
  "notif.poRejected.subject": {
    en: "Purchase order rejected",
    tr: "Satınalma siparişi reddedildi",
    de: "Bestellung abgelehnt",
  },
  "notif.poRejected.body": {
    en: "PO {number} was rejected.",
    tr: "{number} numaralı satınalma siparişi reddedildi.",
    de: "Bestellung {number} wurde abgelehnt.",
  },
  "notif.poRejectedReason.body": {
    en: "PO {number} was rejected: {reason}",
    tr: "{number} numaralı satınalma siparişi reddedildi: {reason}",
    de: "Bestellung {number} wurde abgelehnt: {reason}",
  },
  "notif.goodsReceived.subject": { en: "Goods received", tr: "Mal kabul edildi", de: "Ware eingegangen" },
  "notif.goodsReceived.body": {
    en: "Goods receipt {number} was posted.",
    tr: "{number} numaralı mal kabulü işlendi.",
    de: "Wareneingang {number} wurde gebucht.",
  },
  "notif.goodsReceivedForPo.body": {
    en: "Goods receipt {number} was posted for PO {po}.",
    tr: "{number} numaralı mal kabulü, {po} numaralı sipariş için işlendi.",
    de: "Wareneingang {number} wurde für Bestellung {po} gebucht.",
  },

  // ---- auto-created task records -------------------------------------------
  "task.dealWonKickoff.subject": {
    en: "Kick off onboarding for won deal",
    tr: "Kazanılan fırsat için başlangıç sürecini başlat",
    de: "Onboarding für gewonnenes Geschäft starten",
  },
  "task.dealWonKickoff.notes": {
    en: "Auto-created when deal {id} was won.",
    tr: "{id} numaralı fırsat kazanılınca otomatik oluşturuldu.",
    de: "Automatisch erstellt, als Geschäft {id} gewonnen wurde.",
  },
  "task.automation.subject": { en: "Automation follow-up", tr: "Otomasyon takibi", de: "Automatisierungs-Follow-up" },
  "task.automation.notes": {
    en: "Auto-created by automation.",
    tr: "Otomasyon tarafından otomatik oluşturuldu.",
    de: "Automatisch von einer Automatisierung erstellt.",
  },
  "task.automationFor.notes": {
    en: "Auto-created by automation for {entity} {id}.",
    tr: "{entity} {id} kaydı için otomasyon tarafından oluşturuldu.",
    de: "Automatisch von einer Automatisierung für {entity} {id} erstellt.",
  },

  // ---- ops alerts (notification bell) --------------------------------------
  "alert.poOverdue.title": {
    en: "Purchase order {number} is {days} day(s) past its expected date",
    tr: "{number} numaralı satınalma siparişi beklenen tarihi {days} gün geçti",
    de: "Bestellung {number} ist {days} Tag(e) über dem erwarteten Datum",
  },
  "alert.transferStuck.title": {
    en: "Transfer {number} has been in transit {days} day(s)",
    tr: "{number} numaralı transfer {days} gündür yolda",
    de: "Umlagerung {number} ist seit {days} Tag(en) unterwegs",
  },
  "alert.countWriteOff.title": {
    en: "Stock count {number} wrote off {value} across {lines} line(s)",
    tr: "{number} numaralı sayım, {lines} satırda toplam {value} zayi yazdı",
    de: "Inventur {number} hat {value} über {lines} Position(en) abgeschrieben",
  },
  "alert.tillShort.title": {
    en: "Till {number} closed short by {amount}",
    tr: "{number} numaralı kasa {amount} eksikle kapandı",
    de: "Kasse {number} schloss mit {amount} Fehlbetrag",
  },
  "alert.tillOver.title": {
    en: "Till {number} closed over by {amount}",
    tr: "{number} numaralı kasa {amount} fazlayla kapandı",
    de: "Kasse {number} schloss mit {amount} Überschuss",
  },
  "alert.billVariance.title": {
    en: "Vendor bill {number} differs from the receipt by {amount}",
    tr: "{number} numaralı tedarikçi faturası, mal kabulünden {amount} sapıyor",
    de: "Eingangsrechnung {number} weicht um {amount} vom Wareneingang ab",
  },

  // ---- entity export ---------------------------------------------------------
  "export.recordsMeta": { en: "{count} records · {date}", tr: "{count} kayıt · {date}", de: "{count} Datensätze · {date}" },
  "export.noRecords": { en: "No records.", tr: "Kayıt yok.", de: "Keine Datensätze." },
  "export.yes": { en: "Yes", tr: "Evet", de: "Ja" },
  "export.no": { en: "No", tr: "Hayır", de: "Nein" },
};

/** The organisation's working language. */
export function orgLocale(): "en" | "tr" | "de" {
  return env.AULA_DEFAULT_LOCALE;
}

/** An org-language text by key, `{param}` interpolated. */
export function orgText(key: keyof typeof TEXTS & string, params?: Record<string, string | number>): string {
  const entry = TEXTS[key];
  if (!entry) return key;
  return interpolate(entry[orgLocale()], params);
}

/** A request-language text by key — for surfaces that DO answer one caller (exports). */
export function localeText(
  locale: string,
  key: keyof typeof TEXTS & string,
  params?: Record<string, string | number>,
): string {
  const entry = TEXTS[key];
  if (!entry) return key;
  const lang = locale === "tr" || locale === "de" ? locale : "en";
  return interpolate(entry[lang], params);
}

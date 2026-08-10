/**
 * Error localization at the serialization boundary.
 *
 * The backend throws in English — one language to write, log, grep and test.
 * The catalogue that decides what the USER reads lives in
 * `packages/contracts/src/i18n/errors.ts`, shared with both apps; this module
 * applies it to a serialized payload using the request's locale.
 *
 * Two things happen here and nowhere else:
 *  - `error.message` is replaced with its localized form (keyed template or
 *    exact-text match; anything unmatched stays English rather than going vague).
 *  - each validation detail's `message` is localized from its issue key.
 *
 * `err.notFound` interpolates an entity machine name ("invoice"); it is mapped
 * through the shared entity-label catalogue so the sentence reads
 * "Fatura bulunamadı" rather than "invoice bulunamadı".
 */
import type { Request } from "express";
import {
  localizeDetailMessage,
  localizeErrorMessage,
  normalizeMessageLocale,
} from "@aula/contracts/i18n/errors";
import { actionWord, entityWord, enumWord, fieldWord } from "@aula/contracts/i18n/labels";
import type { AppError, SerializedError } from "@/lib/enforcement/errors";

/** The request's locale: an already-resolved string, or headers to read it from. */
function resolveLocale(localeOrReq: string | Request): string {
  if (typeof localeOrReq === "string") return localeOrReq;
  const explicit = localeOrReq.get("x-locale");
  if (explicit) return explicit;
  const accept = localeOrReq.get("accept-language");
  if (accept) return accept.split(",")[0]?.trim().split("-")[0] || "en";
  return "en";
}

/**
 * A hand-serialized error body in the request's locale — for the login route,
 * which writes its 401/429 responses directly instead of throwing (the flow
 * has non-error outcomes like `twoFactorRequired` in the same branch).
 */
export function localizedErrorBody(req: Request, code: string, message: string): { error: { code: string; message: string } } {
  const locale = normalizeMessageLocale(resolveLocale(req));
  return { error: { code, message: localizeErrorMessage({ message }, locale) } };
}

/** Serialize an AppError with its message(s) rendered in the request's locale. */
export function localizeAppError(
  err: AppError,
  localeOrReq: string | Request,
  correlationId?: string,
): SerializedError {
  const locale = normalizeMessageLocale(resolveLocale(localeOrReq));
  const payload = err.serialize(correlationId);

  // Templates interpolate machine words — an entity name in `err.notFound`, a
  // lifecycle state in `err.invalidTransition`, a field in `err.uniqueClash`.
  // Translate them BY PARAM NAME so the localized sentence never embeds
  // "draft" or "invoice" verbatim. Unmatched words pass through: a
  // half-translated sentence beats a hidden error.
  const params = err.messageParams ? { ...err.messageParams } : undefined;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== "string") continue;
      if (name === "entity") params[name] = entityWord(value, locale);
      else if (name === "field") params[name] = fieldWord(value, locale);
      else if (name === "action") params[name] = actionWord(value, locale);
      else if (name === "status" || name === "state" || name === "from" || name === "to" || name === "type") {
        params[name] = enumWord(value, locale);
      }
    }
  }

  payload.error.message = localizeErrorMessage(
    { message: err.message, messageKey: err.messageKey, messageParams: params, expose: err.expose },
    locale,
  );
  if (payload.error.details) {
    payload.error.details = payload.error.details.map((d) => ({
      ...d,
      message: localizeDetailMessage(d, locale),
    }));
  }
  return payload;
}

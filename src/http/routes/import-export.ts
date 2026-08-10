/**
 * Bulk data in and out: CSV/Excel export, import templates, imports and report
 * rendering.
 */

import { type Router } from "express";
import { assertKnownEntity, runApi, setApiHeaders, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { metadata } from "@/lib/metadata";
import {
  exportCsv,
  importCsv,
  importXlsx,
  buildImportTemplate,
  parseImportFile,
} from "@/lib/integrations/import-export";
import { startImportJob, getImportJob, toView } from "@/lib/integrations/import-jobs";
import { exportXlsx, exportPdf } from "@/lib/integrations/export-formats";
import { renderReportXlsx, type ReportPayload } from "@/lib/integrations/report-export";
import { importSchema, parseBody, reportExportSchema } from "@/lib/http/body";
import { NotFoundError } from "@/lib/enforcement/errors";
import { assertSettings } from "./shared";

export function registerImportExportRoutes(r: Router): void {
  // ---- import / export (CSV · Excel · PDF) -----------------------------
  r.get("/export/:entity", runApi(async (rc, req, res) => {
    assertKnownEntity(pathParam(req, "entity"));
    const entity = pathParam(req, "entity");
    const format = String(req.query.format ?? "csv").toLowerCase();
    const domain = await getDomainService();
    setApiHeaders(res, rc.correlationId);

    if (format === "xlsx" || format === "excel") {
      const buf = await exportXlsx(rc, entity, metadata, domain);
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename="${entity}.xlsx"`);
      res.status(200).send(buf);
      return;
    }
    if (format === "pdf") {
      const buf = await exportPdf(rc, entity, metadata, domain);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `attachment; filename="${entity}.pdf"`);
      res.status(200).send(buf);
      return;
    }
    const csv = await exportCsv(rc, entity, metadata, domain);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${entity}.csv"`);
    res.status(200).send(csv);
  }));

  // Empty import template (one header row of the entity's writable fields), as a
  // real .xlsx workbook (default) or CSV — the file users fill and re-import.
  r.get("/import/:entity/template", runApi(async (rc, req, res) => {
    assertSettings(rc, "settings.import", "execute");
    assertKnownEntity(pathParam(req, "entity"));
    const format = String(req.query.format ?? "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx";
    const { buffer, contentType, ext } = await buildImportTemplate(pathParam(req, "entity"), metadata, format);
    setApiHeaders(res, rc.correlationId);
    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${pathParam(req, "entity")}-template.${ext}"`);
    res.status(200).send(buffer);
  }));

  // Render a report (sent pre-localized by the client) to a styled Excel workbook.
  // PDF export is the browser's print-to-PDF on the client (full Unicode + theme).
  r.post(
    "/reports/export",
    runApi(async (rc, req, res) => {
      const body = parseBody(req, reportExportSchema);
      const fileName = String(body.fileName || "report").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "report";
      // The schema checks the envelope — a title and an array of sections — and
      // the renderer interprets what is inside them. Describing every section
      // variant here would mean editing two files to add a column to a report,
      // and the renderer already skips what it does not recognise.
      const buf = await renderReportXlsx(body.payload as unknown as ReportPayload);
      setApiHeaders(res, rc.correlationId);
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename="${fileName}.xlsx"`);
      res.status(200).send(buf);
    }),
  );

  r.post(
    "/import/:entity",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.import", "execute");
        assertKnownEntity(pathParam(req, "entity"));
        const body = parseBody(req, importSchema);
        const domain = await getDomainService();
        // Accept either a CSV string or a base64 .xlsx workbook; `aliases` maps the
        // user's (localized) column headers back to field names.
        if (body.xlsx) return importXlsx(rc, pathParam(req, "entity"), body.xlsx, metadata, domain, body.aliases);
        return importCsv(rc, pathParam(req, "entity"), body.csv ?? "", metadata, domain, body.aliases);
      },
      { mutating: true },
    ),
  );

  // Background import: parse the file (fail fast on corrupt uploads), register a
  // job and return its id immediately. Large imports (20k+ rows) must not block
  // the request/response — a proxy/DB timeout would abort them mid-write — so the
  // rows are processed in the background and the client polls the GET below.
  r.post(
    "/import/:entity/job",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.import", "execute");
        assertKnownEntity(pathParam(req, "entity"));
        const body = parseBody(req, importSchema);
        const domain = await getDomainService();
        const rows = await parseImportFile(body);
        const job = startImportJob(rc, pathParam(req, "entity"), rows, metadata, domain, body.aliases);
        return toView(job);
      },
      { mutating: true, status: 202 },
    ),
  );

  // Poll an import job's progress / final result (scoped to the caller's tenant).
  r.get(
    "/import/:entity/job/:id",
    runApi(async (rc, req) => {
      assertKnownEntity(pathParam(req, "entity"));
      const job = getImportJob(rc, pathParam(req, "id"));
      if (!job) throw new NotFoundError("import job", pathParam(req, "id"));
      return toView(job);
    }),
  );

}

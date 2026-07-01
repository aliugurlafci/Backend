import {
  renderEntityXlsx,
  renderEntityPdf,
  renderTemplateXlsx,
  renderReport,
  parseXlsxRows,
} from "@/lib/integrations/render-pool";

async function main() {
  const mode = process.env.AULA_RENDER_WORKERS === "0" ? "inline" : "worker";

  const xlsx = await renderEntityXlsx({
    sheetName: "Accounts",
    columns: [
      { header: "ID", key: "id", width: 20 },
      { header: "Name", key: "name", width: 20 },
    ],
    rows: [{ id: "1", name: "Acme" }, { id: "2", name: "Globex" }],
  });

  const pdf = await renderEntityPdf({
    title: "Accounts",
    count: 2,
    dateStr: "2026-07-01",
    cols: [{ label: "ID" }, { label: "Name" }],
    rows: [["1", "Acme"], ["2", "Globex"]],
  });

  const report = await renderReport({
    title: "Sales Report",
    sections: [
      { title: "Deals", columns: [{ label: "Stage" }, { label: "Value", kind: "currency" }], rows: [["Won", 1000]], total: ["", 1000] },
    ],
    currency: "USD",
  });

  const tpl = await renderTemplateXlsx({ sheetName: "Tpl", headers: ["Name", "Email"] });
  const parsed = await parseXlsxRows(tpl);

  const roundTripOk = JSON.stringify(parsed) === JSON.stringify([["Name", "Email"]]);
  console.log(
    `[${mode}] xlsx=${xlsx.length}B pdf=${pdf.length}B report=${report.length}B tpl=${tpl.length}B ` +
      `parse=${JSON.stringify(parsed)} roundTrip=${roundTripOk ? "OK" : "FAIL"}`,
  );
  process.exit(xlsx.length > 0 && pdf.length > 0 && report.length > 0 && roundTripOk ? 0 : 1);
}

main().catch((e) => {
  console.error("render-check error:", e);
  process.exit(2);
});

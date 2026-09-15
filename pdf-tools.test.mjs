// pdf-tools.test.mjs — unit tests for the PDF-reading tools (2026-07-20):
//   looksLikePdf (magic sniff), pdfUrlFromViewer (viewer-URL unwrap), and an
//   end-to-end extractDocumentText round-trip on a hand-built uncompressed PDF.
// Run: node pdf-tools.test.mjs   Author: iDevOpsLLC
import { looksLikePdf, pdfUrlFromViewer, extractDocumentText } from "./extract.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const enc = new TextEncoder();

console.log("— looksLikePdf (magic %PDF-) —");
t("real PDF bytes → true", looksLikePdf(enc.encode("%PDF-1.4\n...")));
t("HTML bytes → false", !looksLikePdf(enc.encode("<!doctype html><html>")));
t("empty → false", !looksLikePdf(enc.encode("")));
t("too-short '%PD' → false", !looksLikePdf(enc.encode("%PD")));
t("null → false", !looksLikePdf(null));

console.log("— pdfUrlFromViewer (unwrap / detect) —");
t("chrome-extension viewer URL → unwrapped https .pdf",
  pdfUrlFromViewer("chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/https://downloads.docs.servicenow.com/pdf/enus/servicenow-australia-api-reference-enus.pdf")
  === "https://downloads.docs.servicenow.com/pdf/enus/servicenow-australia-api-reference-enus.pdf");
t("direct https .pdf → itself", pdfUrlFromViewer("https://x.com/a/b.pdf") === "https://x.com/a/b.pdf");
t("http .pdf with query → itself", pdfUrlFromViewer("http://x.com/f.pdf?v=2") === "http://x.com/f.pdf?v=2");
t("edge-extension viewer URL → unwrapped", !!pdfUrlFromViewer("edge-extension://abc/https://x.com/f.pdf"));
t("plain HTML url → null", pdfUrlFromViewer("https://x.com/page.html") === null);
t("non-pdf extensionless url → null", pdfUrlFromViewer("https://x.com/docs") === null);
t("empty → null", pdfUrlFromViewer("") === null);

console.log("— extractDocumentText round-trip (uncompressed PDF) —");
{
  const body = "Hello GlideRecordSecure enforces ACLs on read operations.";
  // Minimal single-object PDF with an UNCOMPRESSED content stream (no /Filter),
  // which extractPdf reads raw; the (literal) Tj is what pdfStreamToText pulls.
  const pdf = `%PDF-1.4
4 0 obj
<< /Length 90 >>
stream
BT /F1 24 Tf 100 700 Td (${body}) Tj ET
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
  const bytes = enc.encode(pdf);
  t("crafted bytes sniff as PDF", looksLikePdf(bytes));
  const res = await extractDocumentText(bytes, ".pdf");
  t("extractor returns format=pdf", res && res.format === "pdf", JSON.stringify(res).slice(0, 120));
  t("extracted text contains the embedded sentence",
    !!(res && res.text && res.text.includes("GlideRecordSecure enforces ACLs")),
    res && JSON.stringify(res.text));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

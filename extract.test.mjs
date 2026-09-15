// extract.test.mjs — PDF text-layer extractor regressions.
// 2026-08-15 (live a-live-run): fetch_page on hillsdaleinv.com/…/The_Three_Types_of_Backtests.pdf
// never returned — the TJ-array regex in pdfStreamToText backtracked exponentially on an
// array NOT followed by ` TJ` (Word exports split a page's content stream mid-operator:
// stream A ends `…(y )]`, stream B starts `  TJ`). Synchronous → pinned the MV3 service
// worker → no deadline/keepalive could fire → silent run death mid-sub-agent.
// Run: node extract.test.mjs   Author: iDevOpsLLC
import { extractDocumentText } from "./extract.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

// Minimal uncompressed PDF whose page content is split across N streams.
function pdfWithStreams(streams) {
  const enc = new TextEncoder();
  const objs = streams.map((s, i) => `${i + 1} 0 obj\n<< /Length ${enc.encode(s).length} >>\nstream\n${s}\nendstream\nendobj\n`);
  return enc.encode("%PDF-1.4\n" + objs.join("") + "trailer\n<< >>\n%%EOF\n");
}

// The REAL 45-fragment TJ array from the live PDF (stream #7 of The_Three_Types_of_Backtests.pdf),
// exactly as Word emitted it, with NO ` TJ` after it (the operator sat in stream #8). On the old
// regex this took ~×4 longer per 2 extra fragments (24 frags = 280 ms → 45 frags = days).
// Kept verbatim: purely synthetic arrays did NOT reproduce the blow-up.
const REAL_FRAGS = "(Dr)5(a)4(ga)4(n )-19(S)-3(e)4(stovi)-4(c)4( )-19(is )-22(a)4( )-19(lea)6(d)-9( )-19(qua)4(nt )-21(re)7(se)3(a)4(r)-6(c)4(he)4(r )-16(a)4(nd )-19(de)-5(ve)4(loper)5( )-19(a)4(t )-21(the )-17(Abu )-17(Dha)6(bi)-11( )-19(I)13(nve)4(stm)-4(e)4(nt )-21(Author)3(it)-3(y )";
// (An earlier complete `[( )] TJ … ET` block is required, as in the real stream — without any
// Tj/TJ in the stream pdfStreamToText early-returns and the regex is never run.)
const openArray = `BT\r\n/F2 12 Tf\r\n1 0 0 1 72.024 335.81 Tm\r\n0 g\r\n0 G\r\n[( )] TJ\r\nET\r\nQ\r\n` +
  `BT\r\n/F2 12 Tf\r\n1 0 0 1 72.024 222.77 Tm\r\n0 g\r\n0 G\r\n[${REAL_FRAGS}]  `;

console.log("— pdfStreamToText: pathological TJ array must fail FAST, not hang —");
{
  const t0 = Date.now();
  const r = await extractDocumentText(pdfWithStreams([openArray]), ".pdf");
  const ms = Date.now() - t0;
  t("unterminated `[…]` (no TJ) returns within 2s", ms < 2000, `${ms}ms`);
  t("…and yields no fabricated text (null or short)", r.text == null || r.text.length < 20, JSON.stringify(r.text).slice(0, 80));
}

console.log("— extractPdf: text object split across two content streams is stitched —");
{
  const a = `BT\n/F1 12 Tf\n1 0 0 1 72 700 Tm\n[(Dr)5(a)4(ga)4(n )-19(S)-3(e)4(stovi)-4(c)4( is a lead quant)]  `;
  const b = `  TJ\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([a, b]), ".pdf");
  t("split line recovered", !!r.text && /Dragan Sestovic is a lead quant/.test(r.text), JSON.stringify(r.text));
}

console.log("— extractPdf: ordinary single-stream page still extracts —");
{
  const s = `BT\n/F1 12 Tf\n1 0 0 1 72 700 Tm\n[(Hello)-600(World)] TJ\n0 -14 Td\n(Second line) Tj\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([s]), ".pdf");
  t("TJ array + Tj literal both shown", !!r.text && /Hello World/.test(r.text) && /Second line/.test(r.text), JSON.stringify(r.text));
}

console.log("— pdfStreamToText: nested balanced parens inside a literal —");
{
  const s = `BT\n/F1 12 Tf\n1 0 0 1 72 700 Tm\n[(Alpha \\(see (note) here\\) omega)] TJ\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([s]), ".pdf");
  t("one nesting level survives", !!r.text && /Alpha \(see \(note\) here\) omega/.test(r.text), JSON.stringify(r.text));
}

console.log("— extractPdf: carry does not swallow a stream that legitimately closes —");
{
  const a = `BT\n(First page line) Tj\nET\n`;
  const b = `BT\n(Second page line) Tj\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([a, b]), ".pdf");
  t("both independent streams extracted", !!r.text && /First page line/.test(r.text) && /Second page line/.test(r.text), JSON.stringify(r.text));
}

console.log("— extractPdf: text object left open at EOF is still salvaged —");
{
  const a = `BT\n(Dangling text object at end of file) Tj\n`;
  const r = await extractDocumentText(pdfWithStreams([a]), ".pdf");
  t("unterminated final stream flushed", !!r.text && /Dangling text object at end of file/.test(r.text), JSON.stringify(r.text));
}

console.log("— pdfStreamToText: two/three nesting levels of unescaped parens —");
{
  const s = `BT\n/F1 12 Tf\n1 0 0 1 72 700 Tm\n[(alpha (beta (gamma (delta) gamma) beta) alpha)] TJ\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([s]), ".pdf");
  t("three nesting levels survive", !!r.text && /alpha \(beta \(gamma \(delta\) gamma\) beta\) alpha/.test(r.text), JSON.stringify(r.text));
}

console.log("— extractPdf: binary stream containing a stray `BT` is NOT carried onto real text —");
{
  const junk = "\x00\x91\xd2\x07 BT \xfe\x03\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b\x8c\x8d\x8e\x8f\x90\x91\x92\x93\x94\x95\x96\x97\x98\x99";
  const page = `BT\n/F1 12 Tf\n1 0 0 1 72 700 Tm\n(Real page text stays intact here) Tj\nET\n`;
  const r = await extractDocumentText(pdfWithStreams([junk, page]), ".pdf");
  t("real page text intact after a binary predecessor", !!r.text && /Real page text stays intact here/.test(r.text), JSON.stringify(r.text));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

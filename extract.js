// extract.js — pull READABLE TEXT out of binary document files (PDF, DOCX, XLSX,
// PPTX, RTF) and prepare image files for the vision model, so read_file works on
// every common file type — not just text/code. NO external libraries (MV3 CSP
// blocks CDNs, same constraint as export.js): the ZIP reader and PDF text
// extractor are hand-rolled on top of the browser-native DecompressionStream.
// Office files are ZIP archives of XML; PDFs hold text in (usually FlateDecoded)
// content streams. Scanned/image-only PDFs have no text layer — callers get null
// and should suggest opening the file + capture_screenshot instead.
// Author: iDevOpsLLC

// ---- shared helpers ---------------------------------------------------------

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = new TextDecoder("utf-8");
function latin1(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return s;
}

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Collapse extraction whitespace noise without destroying table-ish layout.
function tidy(text) {
  return String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- minimal ZIP reader (OOXML containers are ZIP archives) -----------------
// Parses the central directory (local headers can carry zeroed sizes with data
// descriptors, so central-directory sizes are authoritative). No ZIP64 — office
// documents are far below 4GB.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function zipCentralEntries(bytes) {
  // EOCD signature 0x06054b50, scanned from the end (comment can pad up to 64KB).
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record).");
  const count = u16(bytes, eocd + 10);
  let off = u32(bytes, eocd + 16);
  const entries = [];
  for (let n = 0; n < count && off + 46 <= bytes.length; n++) {
    if (u32(bytes, off) !== 0x02014b50) break;
    const method = u16(bytes, off + 10);
    const csize = u32(bytes, off + 20);
    const nameLen = u16(bytes, off + 28);
    const extraLen = u16(bytes, off + 30);
    const commentLen = u16(bytes, off + 32);
    const localOff = u32(bytes, off + 42);
    const name = latin1(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipEntryBytes(bytes, entry) {
  const lo = entry.localOff;
  if (u32(bytes, lo) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for "${entry.name}".`);
  const nameLen = u16(bytes, lo + 26);
  const extraLen = u16(bytes, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;                       // stored
  if (entry.method === 8) return inflate(data, "deflate-raw"); // deflated
  throw new Error(`Unsupported ZIP compression method ${entry.method} for "${entry.name}".`);
}

async function zipReadText(bytes, entries, name) {
  const e = entries.find((x) => x.name === name);
  return e ? utf8.decode(await zipEntryBytes(bytes, e)) : null;
}

// ---- DOCX (word/document.xml) -----------------------------------------------

function docxXmlToText(xml) {
  const rx = /<\/w:p>|<w:tab[^>]*\/>|<w:br[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m, out = "";
  while ((m = rx.exec(xml))) {
    if (m[1] != null) out += decodeXml(m[1]);
    else if (m[0].startsWith("</w:p")) out += "\n";
    else out += m[0].startsWith("<w:tab") ? "\t" : "\n";
  }
  return out;
}

async function extractDocx(bytes) {
  const entries = zipCentralEntries(bytes);
  const main = await zipReadText(bytes, entries, "word/document.xml");
  if (!main) throw new Error("No word/document.xml inside — is this a real .docx?");
  let text = docxXmlToText(main);
  // Headers/footers often carry letterhead/contact info worth reading.
  for (const e of entries) {
    if (/^word\/(header|footer)\d*\.xml$/.test(e.name)) {
      const part = docxXmlToText(utf8.decode(await zipEntryBytes(bytes, e)));
      if (part.trim()) text += `\n[${/header/.test(e.name) ? "Header" : "Footer"}] ${part.trim()}\n`;
    }
  }
  // Flag embedded pictures — a "contacts" doc can be one big pasted screenshot;
  // without this note the model would summarize the stub text as the whole doc.
  const images = entries.filter((e) => /^word\/media\//.test(e.name)).length;
  if (images) text += `\n[Note: the document embeds ${images} image(s); image content is NOT extracted — only the text above.]`;
  return tidy(text);
}

// ---- XLSX (sharedStrings + worksheets) ---------------------------------------

const MAX_XLSX_ROWS_PER_SHEET = 500;

function xlsxCellValue(cellAttrs, cellInner, shared) {
  const t = /(?:^|\s)t="([^"]+)"/.exec(cellAttrs)?.[1] || "";
  if (t === "inlineStr") {
    return decodeXml((cellInner.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => x.replace(/<[^>]*>/g, "")).join(""));
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(cellInner)?.[1];
  if (v == null) return "";
  if (t === "s") { const i = parseInt(v, 10); return shared[i] != null ? shared[i] : ""; }
  if (t === "b") return v === "1" ? "TRUE" : "FALSE";
  return decodeXml(v);
}

async function extractXlsx(bytes) {
  const entries = zipCentralEntries(bytes);
  const sharedXml = await zipReadText(bytes, entries, "xl/sharedStrings.xml");
  const shared = [];
  if (sharedXml) {
    for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => x.replace(/<[^>]*>/g, "")).join("")));
    }
  }
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
  if (!sheets.length) throw new Error("No worksheets found inside — is this a real .xlsx?");
  const parts = [];
  for (const sh of sheets) {
    const xml = utf8.decode(await zipEntryBytes(bytes, sh));
    const rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
    const lines = [];
    for (const row of rows.slice(0, MAX_XLSX_ROWS_PER_SHEET)) {
      const cells = [];
      const cellRx = /<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRx.exec(row))) cells.push(cm[1] != null ? "" : xlsxCellValue(cm[2] || "", cm[3] || "", shared));
      if (cells.some((c) => String(c).trim() !== "")) lines.push(cells.join("\t"));
    }
    let block = `=== Sheet ${sh.name.match(/\d+/)[0]} ===\n` + lines.join("\n");
    if (rows.length > MAX_XLSX_ROWS_PER_SHEET) block += `\n[... ${rows.length - MAX_XLSX_ROWS_PER_SHEET} more rows truncated]`;
    parts.push(block);
  }
  return tidy(parts.join("\n\n"));
}

// ---- PPTX (ppt/slides/slideN.xml) --------------------------------------------

async function extractPptx(bytes) {
  const entries = zipCentralEntries(bytes);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
  if (!slides.length) throw new Error("No slides found inside — is this a real .pptx?");
  const parts = [];
  for (const sl of slides) {
    const xml = utf8.decode(await zipEntryBytes(bytes, sl));
    const rx = /<\/a:p>|<a:t>([\s\S]*?)<\/a:t>/g;
    let m, text = "";
    while ((m = rx.exec(xml))) text += m[1] != null ? decodeXml(m[1]) : "\n";
    parts.push(`=== Slide ${sl.name.match(/\d+/)[0]} ===\n` + text.trim());
  }
  return tidy(parts.join("\n\n"));
}

// ---- PDF text layer -----------------------------------------------------------
// Digitally-generated PDFs keep text in content streams (usually FlateDecode =
// zlib) as (string) Tj / [array] TJ operators. This extracts those in document
// order with newline heuristics on Td/TD/T*/ET. Scanned PDFs (page images, no
// text operators) yield nothing → return null so the caller can advise the
// screenshot route. CID/Type0-encoded strings without a ToUnicode map may decode
// imperfectly; garbage-heavy segments are filtered out.

function pdfDecodeLiteral(s) {
  // s includes the surrounding parens.
  let out = "", i = 1;
  const end = s.length - 1;
  while (i < end) {
    const c = s[i];
    if (c !== "\\") { out += c; i++; continue; }
    const n = s[i + 1];
    if (n >= "0" && n <= "7") {
      let oct = "", j = i + 1;
      while (j < end && oct.length < 3 && s[j] >= "0" && s[j] <= "7") { oct += s[j]; j++; }
      out += String.fromCharCode(parseInt(oct, 8)); i = j; continue;
    }
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (n === "\n" || n === "\r") { i += 2; if (n === "\r" && s[i] === "\n") i++; continue; } // line continuation
    out += map[n] != null ? map[n] : n;
    i += 2;
  }
  return out;
}

function pdfDecodeHex(s) {
  const hex = s.slice(1, -1).replace(/\s+/g, "");
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) bytes.push(parseInt(hex[hex.length - 1] + "0", 16));
  // UTF-16BE detection: explicit BOM, or the 00-interleaved pattern of Latin text.
  const looks16 = (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes.length >= 4 && bytes.length % 2 === 0 && bytes.filter((_, i) => i % 2 === 0).every((b) => b === 0));
  if (looks16) {
    let out = "";
    for (let i = bytes[0] === 0xfe ? 2 : 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return bytes.map((b) => String.fromCharCode(b)).join("");
}

function pdfStreamToText(stream) {
  if (!/\bBT\b/.test(stream) || !(/\bTj\b|\bTJ\b|'/.test(stream))) return "";
  // Position-tracking pass: PDFs (esp. Word exports) place each fragment with its
  // own Tm/Td — even mid-word ("$1," "6" "0" "0.00") — so separators must come
  // from GEOMETRY, not from the operators themselves. Track the text cursor
  // (Tm absolute, Td/TD relative to the line origin) plus a crude advance width
  // (0.5em/char), then at each show: y changed → newline; x gap → space; else join.
  // REGEX SAFETY (2026-08-15, live a-live-run: fetch_page on a 445 KB PDF pinned
  // the service worker for good — run died silently mid-sub-agent). The TJ-array
  // alternative used a catch-all `[^\]]` that OVERLAPPED the literal `\(…\)`
  // alternative, so an array that is NOT followed by ` TJ` (Word exports split a
  // page's content stream mid-operator: `…(y )]` | next stream `  TJ`) made the
  // engine try every 2^n split of the fragments before failing. Synchronous, so
  // no deadline/keepalive could ever fire. Now: the catch-all excludes ( ) < >
  // (each has exactly one alternative that can consume it) and literals accept
  // one nesting level of balanced parens — no ambiguity, linear failure.
  // (…) literal with up to THREE nested balanced (…) levels — each level's
  // alternatives are disjoint by first char (\\ vs ( vs other), so still linear.
  let LIT = "\\((?:\\\\.|[^\\\\()])*\\)";
  for (let d = 0; d < 3; d++) LIT = "\\((?:\\\\.|" + LIT + "|[^\\\\()])*\\)";
  const rx = new RegExp(
    "(" + LIT + ")\\s*(Tj|'|\")" +
    "|(<[0-9A-Fa-f\\s]*>)\\s*(Tj|'|\")" +
    "|\\[((?:" + LIT + "|<[0-9A-Fa-f\\s]*>|[^\\]()<>])*)\\]\\s*TJ" +
    "|(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(Td|TD)" +
    "|((?:-?[\\d.]+\\s+){5}-?[\\d.]+)\\s+Tm" +
    "|\\/[^\\s/]+\\s+(-?[\\d.]+)\\s+Tf" +
    "|T\\*", "g");
  let m, out = "";
  let tfSize = 10, tmScale = 1;       // effective em = Tf size × Tm d-scale (crude but adequate)
  let size = 10;
  let lineX = null, lineY = null;     // line-origin (Td offsets apply here)
  let x = null, y = null;             // current draw position
  let prevEndX = null, prevY = null;  // where the previous shown text ENDED
  const width = (s) => s.length * size * 0.5;

  const show = (str, forceNewline) => {
    if (!str) return;
    let sep = "";
    if (out) {
      if (forceNewline || prevY == null || y == null || Math.abs(y - prevY) > Math.max(1, size * 0.3)) sep = "\n";
      else if (x != null && prevEndX != null && x - prevEndX > Math.max(1.5, size * 0.25)) sep = " ";
    }
    if (sep === "\n" && out.endsWith("\n")) sep = "";
    if (sep === " " && /\s$/.test(out)) sep = "";
    out += sep + str;
    if (x != null) { prevEndX = x + width(str); x = prevEndX; } else prevEndX = null;
    prevY = y;
  };

  while ((m = rx.exec(stream))) {
    if (m[1] != null) show(pdfDecodeLiteral(m[1]), m[2] === "'" || m[2] === '"');
    else if (m[3] != null) show(pdfDecodeHex(m[3]), m[4] === "'" || m[4] === '"');
    else if (m[5] != null) {
      // TJ array: kern numbers adjust x (units are -1/1000 em); pieces then join
      // or gap naturally through the same geometry rule.
      const irx = new RegExp(LIT + "|<[0-9A-Fa-f\\s]*>|-?[\\d.]+", "g"); // same LIT → same nesting depth as rx
      let im;
      while ((im = irx.exec(m[5]))) {
        const tok = im[0];
        if (tok[0] === "(") show(pdfDecodeLiteral(tok));
        else if (tok[0] === "<") show(pdfDecodeHex(tok));
        else if (x != null) x -= (parseFloat(tok) / 1000) * size;
      }
    }
    else if (m[8] === "Td" || m[8] === "TD") {
      lineX = (lineX ?? 0) + parseFloat(m[6]);
      lineY = (lineY ?? 0) + parseFloat(m[7]);
      x = lineX; y = lineY;
    }
    else if (m[9] != null) {
      const n = m[9].trim().split(/\s+/).map(parseFloat);
      lineX = x = n[4]; lineY = y = n[5];
      tmScale = Math.abs(n[3]) || 1; // d component scales the em box
      size = Math.max(4, tfSize * tmScale);
    }
    else if (m[10] != null) { const s = parseFloat(m[10]); if (s > 0) { tfSize = s; size = Math.max(4, tfSize * tmScale); } }
    else { // T* — next line (leading unknown): force a line break at next show
      y = y == null ? null : y - Math.max(2, size * 1.1);
      lineY = y; x = lineX;
    }
  }
  return out;
}

// Drop segments that decoded to mostly non-printable garbage (CID fonts).
function pdfFilterGarbage(text) {
  return text.split("\n").filter((line) => {
    if (!line.trim()) return true;
    const printable = (line.match(/[\x20-\x7e\t -￿]/g) || []).length;
    return printable / line.length >= 0.7;
  }).join("\n");
}

async function extractPdf(bytes) {
  const bin = latin1(bytes);
  if (!bin.startsWith("%PDF")) throw new Error("Not a PDF (missing %PDF header).");
  let out = "";
  const streamRx = /stream\r?\n/g;
  let sm;
  // SPLIT TEXT OBJECTS (2026-08-15): a page's content can be split across several
  // streams at ANY byte (Word exports: stream A ends `…(y )]`, stream B starts
  // `  TJ`). Parsing each stream alone drops that whole line. If a stream leaves a
  // text object OPEN (last BT after last ET), carry it into the next stream and
  // parse the pair together. Bounded so a corrupt file can't grow it forever.
  let carry = "";
  const CARRY_CAP = 2 * 1024 * 1024;
  const lastOp = (str, op) => { const r = new RegExp("\\b" + op + "\\b", "g"); let i = -1, m; while ((m = r.exec(str))) i = m.index; return i; };
  const looksLikeContentStream = (str) => {
    const sample = str.slice(0, 4000);
    let printable = 0;
    for (let i = 0; i < sample.length; i++) { const c = sample.charCodeAt(i); if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) printable++; }
    return sample.length > 0 && printable / sample.length >= 0.9;
  };
  const flush = (content) => {
    const t = pdfStreamToText(content);
    if (t.trim()) out += t + "\n";
  };
  while ((sm = streamRx.exec(bin))) {
    const dataStart = sm.index + sm[0].length;
    const endIdx = bin.indexOf("endstream", dataStart);
    if (endIdx < 0) break;
    let dataEnd = endIdx;
    while (dataEnd > dataStart && (bin[dataEnd - 1] === "\n" || bin[dataEnd - 1] === "\r")) dataEnd--;
    const dictStart = Math.max(0, bin.lastIndexOf("<<", sm.index) - 0);
    const dict = bin.slice(dictStart, sm.index);
    const slice = bytes.subarray(dataStart, dataEnd);
    let content = null;
    if (/\/FlateDecode/.test(dict)) {
      try { content = latin1(await inflate(slice, "deflate")); }
      catch { try { content = latin1(await inflate(slice, "deflate-raw")); } catch { content = null; } }
    } else if (!/\/Filter/.test(dict)) {
      content = bin.slice(dataStart, dataEnd);
    } // other filters (DCTDecode images etc.) are skipped
    if (content) {
      if (carry) { content = carry + "\n" + content; carry = ""; }
      // Only ASCII-looking page content may be carried — a binary font/ICC/XMP
      // stream can contain a stray `BT` and must not be glued onto real text.
      if (content.length < CARRY_CAP && looksLikeContentStream(content) && lastOp(content, "BT") > lastOp(content, "ET")) {
        carry = content; // text object still open — finish it with the next stream
      } else {
        flush(content);
      }
    }
    streamRx.lastIndex = endIdx + 9;
  }
  if (carry) flush(carry); // unterminated at EOF — salvage what it has
  const text = tidy(pdfFilterGarbage(out));
  return text.length >= 20 ? text : null; // null = no usable text layer (scanned?)
}

// ---- RTF (best-effort control-word strip) -------------------------------------

function extractRtf(bytes) {
  let s = latin1(bytes);
  // Drop header groups that hold no body text (fonts, colors, styles, metadata).
  s = s.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|\*)(?:[^{}]|\{[^{}]*\})*\}/g, "");
  s = s.replace(/\\par[d]?\b/g, "\n").replace(/\\tab\b/g, "\t").replace(/\\line\b/g, "\n")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, n) => String.fromCharCode(((+n) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "");
  return tidy(s);
}

// ---- public API ----------------------------------------------------------------

export const EXTRACTABLE_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".rtf"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
export function imageMime(ext) { return IMAGE_MIME[ext] || "application/octet-stream"; }

// PDF magic-number sniff — a real PDF starts with the bytes "%PDF-". Lets a
// URL/stream reader route by CONTENT, not by a .pdf extension it may not have.
export function looksLikePdf(bytes) {
  return !!bytes && bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

// A browser PDF-viewer tab wraps the real document URL:
//   chrome-extension://<id>/https://host/file.pdf   (Chrome/Adobe/Edge/Firefox)
// A direct http(s) .pdf URL is already fetchable. Returns the https URL to fetch,
// or null when this isn't a PDF URL (so callers fall back to normal handling).
export function pdfUrlFromViewer(url) {
  const s = String(url || "");
  const m = s.match(/^(?:chrome|edge|moz)-extension:\/\/[^/]+\/(https?:\/\/.+?\.pdf(?:[?#].*)?)$/i);
  if (m) return m[1];
  if (/^https?:\/\/[^\s]+\.pdf(?:[?#].*)?$/i.test(s)) return s;
  return null;
}

// GARBLE DETECTOR — a PDF whose embedded subset fonts have no usable /ToUnicode
// cmap decodes into control-char mojibake, not text (live conv 2026-07-23: a
// HealthScan PDF came out as "(5%G%C>%:>;…" and was returned as ok,
// confusing the model for a whole run). Real extracted text is overwhelmingly
// letters/digits/punctuation; garbled output is dense in C0 control chars and
// thin on alphanumerics. Treat garble as NO usable text so callers report it
// honestly and route to read_pdf (desktop-server PyMuPDF+OCR) instead.
export function looksGarbledText(text) {
  const s = String(text || "");
  if (s.length < 80) return false; // too short to judge — let it through
  const sample = s.slice(0, 4000);
  let ctrl = 0, alnum = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) alnum++;
  }
  return ctrl / sample.length > 0.02 || alnum / sample.length < 0.35;
}

// Extract readable text from a binary document. Returns { text, format } —
// text === null means a PDF with no text layer (scanned/image-only) OR whose
// text layer decoded to unreadable mojibake (non-standard font encoding).
export async function extractDocumentText(bytes, ext) {
  switch (ext) {
    case ".pdf": {
      const text = await extractPdf(bytes);
      return { text: looksGarbledText(text) ? null : text, format: "pdf" };
    }
    case ".docx": return { text: await extractDocx(bytes), format: "docx" };
    case ".xlsx": return { text: await extractXlsx(bytes), format: "xlsx" };
    case ".pptx": return { text: await extractPptx(bytes), format: "pptx" };
    case ".rtf": return { text: extractRtf(bytes), format: "rtf" };
    default: throw new Error(`No extractor for "${ext}".`);
  }
}

// Downscale an image and return JPEG base64 for the vision model (same ~1440px
// budget as vision.js shrinkForVision). Falls back to the raw bytes when decode
// fails (the vision model may still accept them).
const MAX_VISION_WIDTH = 1440;
function bytesToBase64(buf) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(bin);
}
export async function imageToVisionBase64(bytes, ext) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: imageMime(ext) }));
    const scale = bmp.width > MAX_VISION_WIDTH ? MAX_VISION_WIDTH / bmp.width : 1;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return bytesToBase64(bytes);
  }
}

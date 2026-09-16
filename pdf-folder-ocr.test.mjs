// pdf-folder-ocr.test.mjs — regression suite for build 2026-09-07c:
//   (1) classifyPdfRef: a connected-folder path is a distinct kind, not "invalid"
//   (2) repeatRefusal: a repeat of a FAILED call quotes the error instead of
//       claiming the content was already read
//   (3) source wiring: side panel bytes op, worker OCR fallback, desktop-server
//       data_b64 upload — the three pieces that move a connected-folder PDF to
//       PyMuPDF + Tesseract.
// Root cause: in the connected-folder OCR run, read_pdf refused "Records/x.pdf"
// four times, then the cycle breaker said "you are re-fetching content you
// already read".
// Run: node pdf-folder-ocr.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import { classifyPdfRef } from "./extract.js";
import { repeatRefusal } from "./loop-guards.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

console.log("— classifyPdfRef —");
t("https URL → http", classifyPdfRef("https://x.com/a/b.pdf") === "http");
t("http URL → http", classifyPdfRef("http://x.com/f.pdf?v=2") === "http");
t("Windows absolute path → local", classifyPdfRef("C:\\redacted\\path") === "local");
t("Windows forward-slash absolute → local", classifyPdfRef("C:/redacted/path") === "local");
t("UNC path → local", classifyPdfRef("\\\\server\\share\\scan.pdf") === "local");
t("file:// URL → local", classifyPdfRef("file:///C:/redacted/path") === "local");
t("connected-folder relative path → folder", classifyPdfRef("Records/invoice.pdf") === "folder");
t("bare filename → folder", classifyPdfRef("statement-2026-06-18-scanned.pdf") === "folder");
t("backslash relative path → folder", classifyPdfRef("Records\\scan.pdf") === "folder");
t("empty → ''", classifyPdfRef("") === "");
t("null → ''", classifyPdfRef(null) === "");
t("chrome-extension viewer URL that pdfUrlFromViewer could not unwrap → ''", classifyPdfRef("chrome-extension://abc/viewer.html") === "");
t("mailto: → ''", classifyPdfRef("mailto:x@y.z") === "");

console.log("— repeatRefusal —");
{
  const failed = repeatRefusal({ name: "read_pdf", kind: "cycle", seen: 3, lastError: "read_pdf needs a full http(s) PDF URL, a chrome-extension viewer URL that wraps one, or an absolute LOCAL path like C:\\redacted\\path)." });
  t("failed repeat says FAILED, not re-fetching", /FAILED every time/.test(failed) && !/re-fetching content you already read/.test(failed));
  t("failed repeat quotes the last error", /absolute LOCAL path/.test(failed));
  t("failed repeat carries the call count", /called 3 times/.test(failed));
  t("failed repeat forbids presenting unread content", /Never present content from a call that failed/.test(failed));
  const failedConsec = repeatRefusal({ name: "read_pdf", kind: "consecutive", seen: 3, lastError: "Desktop control could not reach the desktop-server at http://localhost:8777" });
  t("consecutive failed repeat also says FAILED", /FAILED every time/.test(failedConsec) && !/its result is in the conversation above/.test(failedConsec));
  const longErr = "x".repeat(2000);
  t("last error is capped at 400 chars", repeatRefusal({ name: "t", kind: "cycle", seen: 3, lastError: longErr }).length < 900);
  const okCycle = repeatRefusal({ name: "get_editor_value", kind: "cycle", seen: 3, lastError: null });
  t("successful-read cycle keeps the CYCLE DETECTED wording", /^CYCLE DETECTED: this is call #3 of get_editor_value with these arguments on the same page/.test(okCycle));
  t("navigate cycle is not 'on the same page'", !/on the same page/.test(repeatRefusal({ name: "navigate", kind: "cycle", seen: 3, pageScoped: false })));
  const okConsec = repeatRefusal({ name: "read_page", kind: "consecutive", seen: 3 });
  t("successful consecutive keeps the ALREADY called wording", /^You have ALREADY called read_page with these exact arguments/.test(okConsec));
  t("undefined lastError (never recorded) is treated as a successful read", /^CYCLE DETECTED/.test(repeatRefusal({ name: "x", kind: "cycle", seen: 4, lastError: undefined })));
}

console.log("— source wiring —");
{
  const sp = src("./sidepanel.js"), tools = src("./tools.js"), fs = src("./fsaccess.js"), bg = src("./background.js"), srv = ""; // Agent Go ships no desktop-server folder (bridges zip carries it); server checks are vacuous here
  t("fsaccess exports readFileBytesB64", /export async function readFileBytesB64\(/.test(fs));
  t("fsaccess NO_TEXT_LAYER message no longer demands an absolute path the model cannot know", !/BEST RECOVERY: call read_pdf with the file's FULL LOCAL PATH/.test(fs));
  t("side panel: read_file hands bytes back on NO_TEXT_LAYER", /e\.code === "NO_TEXT_LAYER"[\s\S]{0,400}pdf_base64: bytes\.base64/.test(sp));
  t("side panel: read_file_bytes is a READ op (no write grant needed)", /READ_OPS = new Set\(\["list_files", "read_file", "read_file_bytes", "search_files"\]\)/.test(sp));
  t("side panel: read_file_bytes op is handled", /msg\.op === "read_file_bytes"/.test(sp));
  t("worker: read_file routes no_text_layer bytes to desktopPdfText", /resp\.no_text_layer && resp\.pdf_base64[\s\S]{0,400}desktopPdfText\(ctx\.settings, \{ base64: pdf_base64/.test(tools));
  t("worker: read_pdf accepts a connected-folder path via read_file_bytes", /kind === "folder"[\s\S]{0,600}op: "read_file_bytes"/.test(tools));
  t("worker: desktop_get_screen_size reads /health with GET (server route is GET-only; was HTTP 405)", /desktopBridge\(s, "\/health", null, undefined, "GET"\)/.test(tools) && /body: method === "GET" \? undefined : JSON\.stringify/.test(tools));
  t("MM P1: 413 message renders the bat path with its backslash", /desktop-server\\\\start-desktop\.bat\) and retry ONCE after that; or pass read_pdf/.test(tools) && !/desktop-server\\start-desktop\.bat\) and retry ONCE after that; or pass/.test(tools));
  t("MM P2: read_file fallback keeps read_file's 200K default cap", /Number\.isFinite\(args\.max_chars\) \? args\.max_chars : 200000\)/.test(tools));
  t("MM P2: read_file fallback returns `content` alongside `text`", /\.\.\.out, content: out\.text, extracted: "pdf"/.test(tools));
  t("MM P3: desktopPdfText guards a text-less ok:true answer", /const txt = typeof r\.text === "string" \? r\.text : "";/.test(tools) && /returned no text for this PDF/.test(tools));
  t("MM P4: navigate resume also matches pendingUrl", /live\.url === url \|\| live\.pendingUrl === url/.test(tools));
  t("MM P5: server stages the upload inside try/except and logs a failed unlink", !srv || (/except OSError as e:  # disk full/.test(srv) && /temp file not removed/.test(srv)));
  t("worker: bytes upload is sent as data_b64 + name", /body\.data_b64 = src\.base64; body\.name = src\.name/.test(tools));
  t("worker: an old desktop-server ('path required') is explained, not retried", /path required\/i\.test\(r\.error\)/.test(tools));
  t("worker: an old desktop-server's 8 MB cap (HTTP 413) is explained, not retried", /src\.base64 && \/HTTP 413\/\.test\(r\.error\)/.test(tools));
  t("desktop-server: request cap covers a 25 MB document as base64 (40 MB)", !srv || (/MAX_CONTENT_LENGTH"\] = 40 \* 1024 \* 1024/.test(srv)));
  t("worker: read_pdf schema advertises connected-folder relative paths", /RELATIVE to a connected 📁 Local files \(MCP\) folder \(Records\/scan\.pdf\)/.test(tools));
  t("worker: read_file schema says scanned PDFs are OCR'd automatically", /AUTOMATICALLY handed to the desktop-server/.test(tools));
  t("background: repeat refusals come from loop-guards.js", /import \{ repeatRefusal[^}]*\} from "\.\/loop-guards\.js"/.test(bg) && (bg.match(/repeatRefusal\(\{/g) || []).length === 2);
  t("background: last error recorded per signature after the real result", /ctx\._sigLastErr\.set\(callSig, errText\)/.test(bg) && /ctx\._sigLastErr\.set\(cycleSig, errText\)/.test(bg));
  t("background: no hard-coded 'you are re-fetching' string left in the loop", !/error: `CYCLE DETECTED: this is call/.test(bg));
  t("background: BUILD_TAG is 2026-09-07c or the open-source form", /const BUILD_TAG = "(?:[^"]*2026-09-07c |AGENT GO \d)/.test(bg));
  t("desktop-server: /pdftext accepts data_b64", !srv || (/data_b64 = d\.get\("data_b64"\)/.test(srv) && /base64\.b64decode\(data_b64\)/.test(srv)));
  t("desktop-server: uploaded bytes go to a temp file that is removed", !srv || (/tempfile\.mkstemp\(prefix="agent-go-pdf-"/.test(srv) && /os\.remove\(tmp_path\)/.test(srv)));
  t("desktop-server: %PDF header is checked on uploads", !srv || (/raw\.startswith\(b"%PDF"\)/.test(srv)));
  t("desktop-server: response echoes the display name, never the temp path", !srv || (/jsonify\(ok=True, path=display/.test(srv)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

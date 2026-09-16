// tool-result-cap.test.mjs — what the MODEL receives from a tool result.
//
// Live run (owner export 2026-09-08 02:14, contract review): read_pdf extracted
// all 9 pages of vendor-msa.pdf (16,454 chars) and answered "COMPLETE document —
// you now have every page". background.js then stored the result into the model's
// history with a flat `.slice(0, 8000)` that had been there since the first
// commit: the model saw pages 1-4 cut mid-sentence, no marker, and the COMPLETE
// note itself was cut off. It said so, re-called with a larger max_chars (which
// cannot help — the cut is downstream), and the same-file short-circuit told it
// the document was complete. Every reading tool was capped the same way.
//
// Pinned here:
//   1. TOOL_RESULT_MAX_CHARS is 16000 (owner: "double it").
//   2. capToolPayload passes short payloads through byte-for-byte.
//   3. A long payload is cut at the cap AND carries a tail marker naming the
//      total, saying the rest was NOT read, and that max_chars will not help.
//   4. A 9-page synthetic PDF payload shaped like read_pdf's result reaches the
//      model with at least 8 page headers (was 4) and the cut announced.
//   5. background.js routes every tool push through capToolPayload; no bare
//      `.slice(0, 8000)` on a tool message survives.
// Run: node tool-result-cap.test.mjs   Author: iDevOpsLLC

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + (typeof extra === "string" ? extra : JSON.stringify(extra)))); };

const { capToolPayload, TOOL_RESULT_MAX_CHARS } = await import("./loop-guards.js");

console.log("\n1. the cap");
ok("TOOL_RESULT_MAX_CHARS is 16000", TOOL_RESULT_MAX_CHARS === 16000, TOOL_RESULT_MAX_CHARS);

console.log("\n2. short payloads pass through untouched");
{
  const s = JSON.stringify({ ok: true, text: "x".repeat(15900) });
  ok("15.9K-char payload returned as-is", capToolPayload(s) === s);
  ok("exactly-at-cap payload returned as-is", capToolPayload("y".repeat(16000)) === "y".repeat(16000));
  ok("empty / null → empty string", capToolPayload("") === "" && capToolPayload(null) === "");
}

console.log("\n3. a long payload is cut AND the cut is announced");
{
  const s = "z".repeat(45210);
  const out = capToolPayload(s);
  ok("first 16000 chars kept verbatim", out.startsWith("z".repeat(16000)) && out[16000] === "\n");
  ok("marker names the total and the delivered count", /was 45210 chars/.test(out) && /first 16000 were delivered/.test(out));
  ok("marker says the rest was NOT read", /rest was NOT read/.test(out));
  ok("marker says a larger max_chars will not help", /max_chars will NOT help/i.test(out));
  ok("marker forbids reporting it as complete", /Never report a cut document as complete/.test(out));
  ok("custom max honoured", capToolPayload("q".repeat(100), 40).startsWith("q".repeat(40) + "\n") && /was 100 chars/.test(capToolPayload("q".repeat(100), 40)));
}

console.log("\n4. the 9-page MSA shape: the model now sees most of the document, and knows about the rest");
{
  // Same shape and key order as desktopPdfText's result; page sizes mirror the real file.
  const sizes = [3068, 2091, 2176, 1993, 1898, 3096, 364, 729, 1048];
  const text = sizes.map((n, i) => `\n--- page ${i + 1} of 9 ---\n` + "Contract text. ".repeat(Math.ceil(n / 15)).slice(0, n)).join("");
  const payload = JSON.stringify({ path: "Contracts/vendor-msa.pdf", format: "pdf", pages: 9, chars: sizes.reduce((a, b) => a + b, 0), text, truncated: false, note: "COMPLETE document — you now have every page; extract what you need from this text, do NOT re-read it." });
  ok("payload is bigger than the cap (so this case is meaningful)", payload.length > 16000, payload.length);
  const old = payload.slice(0, 8000);
  const now = capToolPayload(payload);
  const pagesOld = (old.match(/--- page (\d+) of 9 ---/g) || []).length;
  const pagesNow = (now.match(/--- page (\d+) of 9 ---/g) || []).length;
  ok(`old cap delivered 4 page headers (got ${pagesOld})`, pagesOld === 4);
  ok(`new cap delivers at least 8 page headers (got ${pagesNow})`, pagesNow >= 8);
  ok("old cap carried no warning at all", !/EXTENSION CUT|trimmed|truncated/i.test(old));
  ok("new cap announces the cut with the real total", new RegExp("EXTENSION CUT: this tool result was " + payload.length + " chars").test(now));
}

console.log("\n5. background.js wiring");
{
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  ok("imports capToolPayload from loop-guards", /import \{[^}]*capToolPayload[^}]*\} from "\.\/loop-guards\.js"/.test(bg));
  ok("no bare .slice(0, 8000) left on any tool message", !/content: [^\n]*\.slice\(0, 8000\)/.test(bg));
  ok("main tool push goes through capToolPayload", /content: capToolPayload\(toolPayload\)/.test(bg));
  ok("rejection push goes through capToolPayload", /content: capToolPayload\(JSON\.stringify\(rejection\)\)/.test(bg));
  ok("spawn_subagent push goes through capToolPayload", /name: "spawn_subagent", content: capToolPayload\(JSON\.stringify\(result\)\)/.test(bg));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

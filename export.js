// export.js — export an assistant response to clipboard / .md / .docx / .pdf.
// Self-contained: no external libraries, no extra permissions. .docx is real
// OOXML packed into a STORE (uncompressed) zip; .pdf is hand-built with the
// standard Helvetica/Courier fonts and canvas-measured word wrapping.
// Author: iDevOpsLLC

// ---------- shared: download + clipboard ----------
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is blocked.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// A filesystem-safe base name: timestamp + a short slug of the response.
export function exportBaseName(text) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const slug = String(text || "")
    .replace(/[`*#>_\-\[\]()]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  return `local-claude-${ts}${slug ? "-" + slug : ""}`;
}

// ---------- markdown -> block model ----------
// runs: [{ text, bold, italic, code, link, strike }]
function parseInline(text) {
  const runs = [];
  const src = String(text);
  let buf = "";
  const flush = () => { if (buf) { runs.push({ text: buf }); buf = ""; } };
  for (let k = 0; k < src.length; ) {
    const ch = src[k];
    if (ch === "!" && src[k + 1] === "[") {
      const m = /^!\[([^\]]*)\]\([^)]*\)/.exec(src.slice(k));
      if (m) { flush(); runs.push({ text: m[1] ? `[Image: ${m[1]}]` : "[Image]" }); k += m[0].length; continue; }
    }
    if (ch === "`") {
      const end = src.indexOf("`", k + 1);
      if (end > k) { flush(); runs.push({ text: src.slice(k + 1, end), code: true }); k = end + 1; continue; }
    }
    if (ch === "~" && src[k + 1] === "~") {
      const end = src.indexOf("~~", k + 2);
      if (end > k) { flush(); runs.push({ text: src.slice(k + 2, end), strike: true }); k = end + 2; continue; }
    }
    if (ch === "*" && src[k + 1] === "*") {
      const end = src.indexOf("**", k + 2);
      if (end > k) { flush(); runs.push({ text: src.slice(k + 2, end), bold: true }); k = end + 2; continue; }
    }
    if (ch === "*") {
      const end = src.indexOf("*", k + 1);
      if (end > k) { flush(); runs.push({ text: src.slice(k + 1, end), italic: true }); k = end + 1; continue; }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\((https?:[^)]+)\)/.exec(src.slice(k));
      if (m) { flush(); runs.push({ text: m[1], link: m[2] }); k += m[0].length; continue; }
    }
    buf += ch;
    k++;
  }
  flush();
  return runs.length ? runs : [{ text: "" }];
}
// Strip inline markdown to plain text (used for table cells + docx table headers).
function stripInline(t) {
  return String(t == null ? "" : t)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}
function tableCells(row) {
  let t = String(row).trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((s) => s.trim());
}
function isTableSep(line) {
  const t = String(line).trim();
  if (!/\|/.test(t) && !/^:?-{2,}:?$/.test(t)) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

function parseBlocks(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: "para", runs: parseInline(para.join(" ")) }); para = []; }
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ type: "code", lines: code });
      continue;
    }
    // table: a pipe row immediately followed by a |---|---| separator row
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const header = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes("|")) { rows.push(tableCells(lines[i])); i++; }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); blocks.push({ type: "hr" }); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ type: "heading", level: Math.min(h[1].length, 6), runs: parseInline(h[2]) }); i++; continue; }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flushPara(); blocks.push({ type: "quote", runs: parseInline(quote[1]) }); i++; continue; }
    // A numbered ALL-CAPS line ("1. REVIEW SUMMARY", "5. PRODUCTION ARTIFACTS")
    // is a SECTION HEADING, not an ordered-list item (real list items contain
    // lowercase words). Rendered as a level-2 heading with an underline rule.
    const sec = line.match(/^\s*(\d+)[.)]\s+([A-Z0-9][A-Z0-9 /&()'.,:+-]{2,60})\s*$/);
    if (sec && !/[a-z]/.test(sec[2])) { flushPara(); blocks.push({ type: "heading", level: 2, runs: parseInline(`${sec[1]}. ${sec[2].trim()}`) }); i++; continue; }
    // Leading-indent level for nested lists (2 spaces or 1 tab = 1 level, ≤4).
    const indentOf = (l) => Math.min(4, Math.floor(l.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length / 2));
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) { flushPara(); blocks.push({ type: "bullet", ordered: false, task: true, checked: /[xX]/.test(task[1]), indent: indentOf(line), runs: parseInline(task[2]) }); i++; continue; }
    const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
    if (bullet) { flushPara(); blocks.push({ type: "bullet", ordered: false, indent: indentOf(line), runs: parseInline(bullet[1]) }); i++; continue; }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) { flushPara(); blocks.push({ type: "bullet", ordered: true, marker: ol[1], indent: indentOf(line), runs: parseInline(ol[2]) }); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

// ---------- .md ----------
export function downloadMarkdown(text, base) {
  triggerDownload(new Blob([String(text == null ? "" : text)], { type: "text/markdown;charset=utf-8" }), base + ".md");
}

// ---------- code artifacts ----------
// A phase-engine code review (and many normal answers) embeds the deliverable's
// real payload — the remediated script — inside a fenced ``` block, often with a
// `/* File: name.js */` header. Extracting each block as its OWN downloadable
// file (Tier 3 "artifacts") means the user gets the corrected code as a real
// .js they can import, not buried in a markdown section.
const LANG_EXT = {
  js: "js", javascript: "js", ts: "ts", typescript: "ts", jelly: "xml",
  xml: "xml", html: "html", json: "json", py: "py", python: "py",
  sh: "sh", bash: "sh", sql: "sql", css: "css", java: "java", groovy: "groovy",
  yaml: "yaml", yml: "yaml", ps1: "ps1", powershell: "ps1"
};

function sniffExt(lang, code) {
  if (lang && LANG_EXT[lang.toLowerCase()]) return LANG_EXT[lang.toLowerCase()];
  // ServiceNow / JS heuristics (the common case here): server or client script.
  if (/\b(function\s*\(|var\s+\w+\s*=|current\.|g_form\.|gs\.\w+\(|GlideRecord|\(function\s+executeRule)/.test(code)) return "js";
  if (/^\s*</.test(code) && /<\/\w+>/.test(code)) return "xml";
  if (/^\s*[{[]/.test(code) && /[}\]]\s*$/.test(code)) return "json";
  return "txt";
}

function slugFile(s) {
  return String(s).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

// Windows-reserved / dotfile basenames that shouldn't become a download name.
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// Returns [{ filename, code, lang }] for every substantive fenced block.
// Caps (MM 16z-audit P2): ≤2MB input, ≤25 artifacts, ≤500KB each — a giant or
// adversarial deliverable can't spawn thousands of buttons or huge blobs.
export function extractCodeArtifacts(text) {
  const src = String(text || "").slice(0, 2 * 1024 * 1024);
  const out = [];
  const seen = new Set();
  const re = /```([A-Za-z0-9+#_-]*)\r?\n([\s\S]*?)```/g;
  let m, i = 0;
  while ((m = re.exec(src))) {
    if (out.length >= 25) break;
    const lang = m[1] || "";
    let code = m[2].replace(/\s+$/, "");
    if (code.trim().length < 40) continue; // skip trivial snippets (inline examples)
    if (code.length > 500 * 1024) code = code.slice(0, 500 * 1024); // per-artifact cap (P2)
    i++;
    // Prefer an explicit filename the model wrote: `/* File: X */`, `// File: X`,
    // or `# File: X` on (usually) the first line.
    let name = null;
    const fileHdr = code.match(/^\s*(?:\/\*+|\/\/|#)\s*File:\s*([^\s*][^\n*]*?)\s*(?:\*+\/)?\s*$/m);
    if (fileHdr) name = slugFile(fileHdr[1]);
    const ext = sniffExt(lang, code);
    if (!name || RESERVED_BASE.test(name)) name = `artifact-${i}.${ext}`; // reserved/dotfile → safe default (P2)
    else if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) name += "." + ext;
    // De-dup filenames within one deliverable.
    let final = name, n = 2;
    while (seen.has(final)) { final = name.replace(/(\.[^.]+)?$/, `-${n}$1`); n++; }
    seen.add(final);
    out.push({ filename: final, code, lang });
  }
  return out;
}

export function downloadArtifact(code, filename) {
  triggerDownload(new Blob([String(code == null ? "" : code)], { type: "text/plain;charset=utf-8" }), filename);
}

// A compact, self-contained record of a phase run for audit/handoff: the plan,
// the evidence ledger with citation ids, each gate verdict, and the final
// deliverable — one markdown file. `meta` is the engine's phaseArtifact payload.
export function buildPhaseRunReport(meta) {
  const m = meta || {};
  const L = [];
  // Collapse any multi-line / whitespace-heavy raw value onto ONE readable line.
  const oneLine = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  // ServiceNow classic URLs run 300-600 chars of encoded sysparm_* params — keep the
  // record target (+ short sys_id) and drop the query tail so the ledger stays scannable.
  const shortUrl = (u) => {
    const s = oneLine(u);
    const path = s.replace(/^https?:\/\/[^/]+/, "");
    const hit = path.match(/([^/?]+\.do)/i);
    const sid = path.match(/sys_id(?:=|%3D)([^&%]+)/i);
    if (hit) return `…/${hit[1]}${sid ? `?sys_id=${sid[1].slice(0, 12)}…` : ""}`;
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  };
  const finalGate = (m.gates || []).find((g) => g.phase === "final");
  const resultReason = finalGate && finalGate.reason ? oneLine(finalGate.reason) : "";

  L.push(`# Phase run report — ${m.readiness || "?"}`);
  if (m.task) L.push(`\n**Task:** ${oneLine(m.task)}`);
  if (m.roster) L.push(`\n**Models:** ${m.roster}`);
  L.push(`\n**Result:** ${m.readiness === "GO" ? "✅ GO" : "🛑 " + (m.readiness || "?")}${resultReason ? " — " + resultReason : ""}`);

  // READABILITY (user: the report was "unreadable"): lead with the decision-relevant
  // content — the deliverable and the gate verdicts. The raw evidence ledger (dozens of
  // page/element dumps) is an AUDIT APPENDIX at the BOTTOM now; it used to come first, so
  // you had to scroll past all of it to reach the actual answer.
  if (m.deliverable) L.push(`\n## Final deliverable\n\n${m.deliverable}`);

  if (Array.isArray(m.gates) && m.gates.length) {
    L.push(`\n## Gate verdicts\n`);
    m.gates.forEach((g) => L.push(`- **${g.phase}** — ${g.readiness}${g.model ? ` (${g.model})` : ""}${g.reason ? `: ${oneLine(g.reason)}` : ""}`));
  }
  if (Array.isArray(m.plan) && m.plan.length) {
    L.push(`\n## Plan\n`);
    m.plan.forEach((s) => L.push(`- **${s.id}** ${oneLine(s.title || "")}${s.depends_on?.length ? ` _(depends: ${s.depends_on.join(", ")})_` : ""}`));
  }
  if (Array.isArray(m.ledger) && m.ledger.length) {
    L.push(`\n## Evidence ledger (audit trail — provenance for [E#.O#] citations)\n`);
    m.ledger.forEach((e) => {
      L.push(`- **${e.id}** \`${e.tool}\`${e.success ? "" : " (FAILED)"}${e.scope?.url ? ` — ${shortUrl(e.scope.url)}` : ""}`);
      const obs = e.observations || [];
      // Cap at 12 compact, single-line observations per entry (was 40 raw 120-char dumps,
      // often multi-line page text). Enough to back the citations without a wall of noise.
      obs.slice(0, 12).forEach((o, k) => {
        const raw = String(o.value == null ? "" : o.value);
        const val = oneLine(raw).slice(0, 80);
        const ell = (oneLine(raw).length > 80 || o.truncated) ? "…" : "";
        L.push(`  - \`[${e.id}.O${k + 1}]\` ${o.path} = ${val}${ell}`);
      });
      if (obs.length > 12) L.push(`  - _…and ${obs.length - 12} more observation(s)_`);
    });
  }
  return L.join("\n");
}

// ---------- .docx (OOXML in a STORE zip) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const local = new Uint8Array(
      [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0))
    );
    chunks.push(local, nameBytes, data);
    central.push(
      new Uint8Array(
        [].concat(
          u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
          u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
        )
      ),
      nameBytes
    );
    offset += local.length + nameBytes.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
  const all = [...chunks, ...central, eocd];
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
// Shared PROFESSIONAL theme for .docx and .pdf (hex, no leading #). Industry best
// practice for business briefs/reports: ONE accent colour (a deep Office blue) used
// only to mark STRUCTURE (headings, rules, links, table header), neutral greys for
// everything else, and semantic PASS/FAIL green/red used sparingly. Bold body text
// is NOT recoloured — bold is weight, not colour. Typography: Georgia body (serif —
// authority + easy long-form reading for legal/compliance briefs) + Calibri headings
// (clean sans) + Consolas for code; all ship with Windows/Office (no embedding).
const DOCX = {
  accent: "1F4E79",
  heading: "1F4E79", link: "1F4E79", codeBar: "1F4E79", listDot: "1F4E79", tHeaderBg: "1F4E79",
  ink: "212121", bold: "212121", firstCol: "212121", code: "24292E",
  codeFill: "F2F2F2", ruleSoft: "D9D9D9", tBorder: "D9D9D9",
  quote: "5A5A5A", muted: "5A5A5A",
  pass: "1E7A46", fail: "B42318",
  tHeaderText: "FFFFFF", tAltBg: "F5F7FA",
  fontBody: "Calibri", fontHead: "Calibri", fontMono: "Consolas" // sans body+headings, mono code (industry-standard doc)
};
// Split a plain run so verdict badges (PASS / FAIL / CRITICAL) render bold + colored.
function expandBadges(run) {
  if (run.code || run.link) return [run];
  const parts = String(run.text).split(/\b(PASS|FAIL|CRITICAL)\b/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    if (i % 2 === 1) out.push({ text: parts[i], bold: true, color: parts[i] === "PASS" ? DOCX.pass : DOCX.fail });
    else out.push({ ...run, text: parts[i] });
  }
  return out.length ? out : [run];
}
function runsToXml(runs, extra) {
  extra = extra || {};
  const out = [];
  for (const r0 of runs) {
    for (const r of expandBadges(r0)) {
      const props = [];
      if (r.code) props.push(`<w:rFonts w:ascii="${DOCX.fontMono}" w:hAnsi="${DOCX.fontMono}"/>`);
      else if (extra.font) props.push(`<w:rFonts w:ascii="${extra.font}" w:hAnsi="${extra.font}"/>`);
      if (r.bold || extra.bold) props.push("<w:b/>");
      if (r.italic || extra.italic) props.push("<w:i/>");
      if (r.strike) props.push("<w:strike/>");
      if (extra.sz) props.push(`<w:sz w:val="${extra.sz}"/><w:szCs w:val="${extra.sz}"/>`);
      if (r.link) props.push('<w:u w:val="single"/>');
      // Bold is conveyed by weight, NOT colour — never recolour bold body text.
      const color = r.code ? DOCX.code : r.link ? DOCX.link
        : r.color || extra.color || "";
      if (color) props.push(`<w:color w:val="${color}"/>`);
      const rpr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
      out.push(`<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`);
    }
  }
  return out.join("");
}
function docxTableXml(b) {
  const cols = b.header.length || 1;
  const border = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${DOCX.tBorder}"/>`).join("")}</w:tblBorders>`;
  // measured column widths (percent of a 5000-unit table)
  const maxLens = [];
  for (let c = 0; c < cols; c++) {
    let m = stripInline(b.header[c] || "").length;
    for (const r of b.rows) m = Math.max(m, stripInline(r[c] || "").length);
    maxLens.push(m + 2);
  }
  const totLen = maxLens.reduce((a, v) => a + v, 0) || 1;
  const pct = maxLens.map((l) => Math.max(400, Math.round((l / totLen) * 5000)));
  const grid = `<w:tblGrid>${pct.map((p) => `<w:gridCol w:w="${Math.round((p / 5000) * 9360)}"/>`).join("")}</w:tblGrid>`;
  const cell = (text, ci, isHeader, alt) => {
    const shd = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="${DOCX.tHeaderBg}"/>`
      : alt ? `<w:shd w:val="clear" w:color="auto" w:fill="${DOCX.tAltBg}"/>` : "";
    const runs = isHeader
      ? `<w:r><w:rPr><w:rFonts w:ascii="${DOCX.fontHead}" w:hAnsi="${DOCX.fontHead}"/><w:b/><w:color w:val="${DOCX.tHeaderText}"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEsc(stripInline(text))}</w:t></w:r>`
      : runsToXml(parseInline(text || ""), ci === 0 ? { bold: true, color: DOCX.firstCol, sz: 18 } : { sz: 18 });
    return `<w:tc><w:tcPr><w:tcW w:w="${pct[ci]}" w:type="pct"/>${shd}</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${runs}</w:p></w:tc>`;
  };
  const headerRow = `<w:tr>${b.header.map((h, ci) => cell(h, ci, true, false)).join("")}</w:tr>`;
  const bodyRows = b.rows.map((r, ri) =>
    `<w:tr>${b.header.map((_, ci) => cell(r[ci] || "", ci, false, ri % 2 === 1)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>${grid}${headerRow}${bodyRows}</w:tbl><w:p/>`;
}
function blocksToBodyXml(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "heading") {
      const sz = b.level === 1 ? 34 : b.level === 2 ? 30 : b.level === 3 ? 26 : 22;
      const bdr = b.level <= 2
        ? `<w:pBdr><w:bottom w:val="single" w:sz="${b.level === 1 ? 12 : 4}" w:space="2" w:color="${b.level === 1 ? DOCX.heading : DOCX.ruleSoft}"/></w:pBdr>`
        : "";
      out.push(`<w:p><w:pPr><w:spacing w:before="240" w:after="80"/>${bdr}</w:pPr>${runsToXml(b.runs, { bold: true, sz, color: DOCX.heading, font: DOCX.fontHead })}</w:p>`);
    } else if (b.type === "hr") {
      out.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${DOCX.ruleSoft}"/></w:pBdr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>`);
    } else if (b.type === "quote") {
      out.push(`<w:p><w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${DOCX.quote}"/></w:pBdr></w:pPr>${runsToXml(b.runs, { italic: true, color: DOCX.quote })}</w:p>`);
    } else if (b.type === "table") {
      out.push(docxTableXml(b));
    } else if (b.type === "bullet") {
      const marker = b.task ? (b.checked ? "☑ " : "☐ ") : b.ordered ? `${b.marker}. ` : "• ";
      const lead = 360 + (b.indent || 0) * 360; // nested lists indent 360 twips/level
      out.push(`<w:p><w:pPr><w:ind w:left="${lead}" w:hanging="360"/><w:spacing w:after="40"/></w:pPr>${runsToXml([{ text: marker, color: DOCX.listDot }].concat(b.runs))}</w:p>`);
    } else if (b.type === "code") {
      // Shaded panel with a left accent bar; per-line paragraphs stack into one block.
      const lines = b.lines.length ? b.lines : [""];
      for (const ln of lines) out.push(`<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="${DOCX.codeFill}"/><w:spacing w:after="0"/><w:ind w:left="120"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="4" w:color="${DOCX.codeBar}"/></w:pBdr></w:pPr>${runsToXml([{ text: ln || " ", code: true }])}</w:p>`);
    } else {
      out.push(`<w:p>${runsToXml(b.runs)}</w:p>`);
    }
  }
  if (!out.length) out.push("<w:p/>");
  return out.join("");
}
// Build the raw .docx bytes (OOXML in a STORE zip) from markdown text. Separated
// from downloadDocx so the agent's create_document tool can SAVE the bytes to the
// connected folder (via fsaccess.writeFileBytes) instead of triggering a download.
export function buildDocxBytes(text) {
  const enc = new TextEncoder();
  const body = blocksToBodyXml(parseBlocks(text));
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body +
    '<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  // Document defaults set the whole-document typography once: Calibri 11pt body in
  // near-black ink at 1.15 line spacing with 7pt paragraph spacing. Without a styles
  // part Word falls back to Times New Roman 10pt — this is the body-font control.
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${DOCX.fontBody}" w:hAnsi="${DOCX.fontBody}" w:cs="${DOCX.fontBody}"/>` +
    `<w:color w:val="${DOCX.ink}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults></w:styles>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(documentRels) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
    { name: "word/styles.xml", data: enc.encode(stylesXml) }
  ]);
}
export function downloadDocx(text, base) {
  triggerDownload(new Blob([buildDocxBytes(text)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), base + ".docx");
}

// ---------- .pdf (hand-built, standard fonts, canvas-measured wrapping) ----------
let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  return _measureCtx;
}
// Map common Unicode punctuation into WinAnsi; drop anything else to '?'.
const WINANSI = { "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "…": 0x85, " ": 0x20, "→": 0x3e };
function winAnsi(text) {
  let out = "";
  for (const ch of String(text)) {
    const cc = ch.codePointAt(0);
    if (cc < 256) out += String.fromCharCode(cc);
    else if (WINANSI[ch] != null) out += String.fromCharCode(WINANSI[ch]);
    else out += "?";
  }
  return out;
}
function pdfEsc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
// Page geometry + a print-legible PROFESSIONAL palette matching the .docx theme:
// ONE accent (deep Office blue #1F4E79) for headings/rules/links/table header,
// near-black body ink, neutral greys, and semantic PASS/FAIL only. Bold is weight,
// not colour. RGB components are 0..1 for PDF ops.
const PDF = {
  // Letter LANDSCAPE (default since 2026-08-18; matches the .docx sectPr).
  pageW: 792, pageH: 612, margin: 54,
  contentTop: 612 - 66,   // leave room for the running header
  contentBottom: 58,      // leave room for the running footer
  col: {
    body:      [0.129, 0.129, 0.129],   // #212121 near-black
    h1:        [0.122, 0.306, 0.475],   // #1F4E79 accent
    h2:        [0.122, 0.306, 0.475],
    h3:        [0.122, 0.306, 0.475],
    bold:      [0.129, 0.129, 0.129],   // bold = weight, not colour
    code:      [0.141, 0.161, 0.180],   // #24292E near-black code
    codeBg:    [0.949, 0.949, 0.949],   // #F2F2F2
    codeBar:   [0.122, 0.306, 0.475],   // accent
    quote:     [0.353, 0.353, 0.353],   // #5A5A5A muted grey
    muted:     [0.47, 0.47, 0.47],
    ruleSoft:  [0.851, 0.851, 0.851],   // #D9D9D9
    bullet:    [0.122, 0.306, 0.475],   // accent bullet marker
    link:      [0.122, 0.306, 0.475],   // accent
    pass:      [0.118, 0.478, 0.275],   // #1E7A46 restrained green
    fail:      [0.706, 0.145, 0.094],   // #B42318 restrained red
    tHeadBg:   [0.122, 0.306, 0.475],   // accent
    tHeadText: [1, 1, 1],
    tAltBg:    [0.961, 0.969, 0.980],   // #F5F7FA
    tBorder:   [0.851, 0.851, 0.851],   // #D9D9D9
    firstCol:  [0.129, 0.129, 0.129]    // ink (first column is bold, not coloured)
  }
};

// Standard-14 font faces (no embedding): regular, bold, courier, oblique, bold-oblique.
function fontKeyFor(st) {
  if (st.code) return "F3";
  if (st.bold && st.italic) return "F5";
  if (st.bold) return "F2";
  if (st.italic) return "F4";
  return "F1";
}
function canvasFontFor(st, size) {
  if (st.code) return `${size}px "Courier New", monospace`;
  return `${st.bold ? "bold " : ""}${st.italic ? "italic " : ""}${size}px Helvetica, Arial, sans-serif`;
}
function segColor(st, defColor) {
  if (st.bullet) return PDF.col.bullet;
  if (st.badge) return st.badge === "PASS" ? PDF.col.pass : PDF.col.fail;
  if (st.code) return PDF.col.code;
  if (st.link) return PDF.col.link;
  // Bold is conveyed by weight (a bold font face), NOT colour — keep the paragraph's
  // own colour so bold body text stays near-black instead of an accent tint.
  return defColor;
}
function sameStyle(a, b) {
  return !!a.code === !!b.code && !!a.bold === !!b.bold && !!a.italic === !!b.italic &&
    !!a.link === !!b.link && !!a.bullet === !!b.bullet && (a.badge || "") === (b.badge || "");
}
// Split a plain run so verdict badges (PASS / FAIL / CRITICAL) render bold + colored.
function splitBadges(run) {
  if (run.code || run.link || run.bullet) return [run];
  const parts = String(run.text).split(/\b(PASS|FAIL|CRITICAL)\b/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    if (i % 2 === 1) out.push({ ...run, text: parts[i], bold: true, badge: parts[i] });
    else out.push({ ...run, text: parts[i] });
  }
  return out.length ? out : [run];
}
// Wrap a run list into lines of merged style segments, measuring each run with the
// face it will actually render with. `forceBold` is used by headings.
function wrapRuns(runs, size, maxWidth, forceBold) {
  const ctx = measureCtx();
  const atoms = [];
  for (const r0 of runs) {
    const r = forceBold ? { ...r0, bold: true } : r0;
    for (const sub of splitBadges(r)) {
      for (const p of String(sub.text).split(/(\s+)/)) {
        if (p === "") continue;
        atoms.push({ text: p, isSpace: /^\s+$/.test(p), st: sub, w: 0 });
      }
    }
  }
  const measure = (a) => { ctx.font = canvasFontFor(a.st, size); return ctx.measureText(a.text).width; };
  const lines = [];
  let line = [], w = 0;
  const trimTrailing = () => { while (line.length && line[line.length - 1].isSpace) { w -= line[line.length - 1].w; line.pop(); } };
  for (const a of atoms) {
    a.w = measure(a);
    if (a.isSpace) {
      if (!line.length) continue;
      if (w + a.w > maxWidth) { trimTrailing(); lines.push(line); line = []; w = 0; continue; }
      line.push(a); w += a.w; continue;
    }
    if (a.w > maxWidth && !line.length) {
      // token longer than a full line — hard-break by character
      ctx.font = canvasFontFor(a.st, size);
      let piece = "";
      for (const ch of a.text) {
        if (piece && ctx.measureText(piece + ch).width > maxWidth) {
          lines.push([{ text: piece, st: a.st, w: ctx.measureText(piece).width }]);
          piece = ch;
        } else piece += ch;
      }
      if (piece) { line = [{ text: piece, st: a.st, w: ctx.measureText(piece).width }]; w = ctx.measureText(piece).width; }
      continue;
    }
    if (w + a.w > maxWidth && line.length) { trimTrailing(); lines.push(line); line = [a]; w = a.w; }
    else { line.push(a); w += a.w; }
  }
  trimTrailing();
  if (line.length) lines.push(line);
  // merge neighboring atoms that share a style into single draw segments
  return lines.map((ln) => {
    const segs = [];
    for (const a of ln) {
      const last = segs[segs.length - 1];
      if (last && sameStyle(last.st, a.st)) { last.text += a.text; last.w += a.w; }
      else segs.push({ text: a.text, st: a.st, w: a.w });
    }
    return segs;
  });
}
// Turn parsed markdown blocks into a flat list of flow items: styled wrappable lines
// plus spacers. buildPdfBytes paginates these and paints backgrounds/rules per page.
function layoutBlocks(blocks, maxWidth) {
  const items = [];
  const emit = (segLines, o) => {
    (segLines.length ? segLines : [[]]).forEach((segs, idx) => {
      items.push({
        segs, size: o.size, lh: o.lh, defColor: o.defColor,
        x: idx === 0 ? o.x0 : o.x1,
        gapBefore: idx === 0 ? o.gapBefore : 0,
        isCode: !!o.isCode, quote: !!o.quote,
        ruleAfter: idx === segLines.length - 1 ? o.ruleAfter || null : null
      });
    });
  };
  for (const b of blocks) {
    if (b.type === "heading") {
      const size = b.level === 1 ? 16 : b.level === 2 ? 13 : b.level === 3 ? 11.5 : 10.5;
      const defColor = PDF.col.h1;
      const ruleAfter = b.level === 1 ? { color: PDF.col.h1, thick: 1.4 }
        : b.level === 2 ? { color: PDF.col.ruleSoft, thick: 0.7 } : null;
      emit(wrapRuns(b.runs, size, maxWidth, true), {
        kind: "heading", size, lh: size * 1.32, defColor,
        x0: PDF.margin, x1: PDF.margin, gapBefore: b.level === 1 ? 16 : 12, ruleAfter
      });
      items.push({ spacer: ruleAfter ? 7 : 3 });
    } else if (b.type === "hr") {
      items.push({ hr: true, gapBefore: 6, size: 0, lh: 8, x: PDF.margin, defColor: PDF.col.body, segs: [] });
    } else if (b.type === "quote") {
      emit(wrapRuns(b.runs, 10.5, maxWidth - 20, false), {
        kind: "quote", size: 10.5, lh: 10.5 * 1.4, defColor: PDF.col.quote,
        x0: PDF.margin + 14, x1: PDF.margin + 14, gapBefore: 4, quote: true
      });
    } else if (b.type === "table") {
      items.push({ spacer: 6 });
      items.push({ table: b });
      items.push({ spacer: 6 });
    } else if (b.type === "bullet") {
      const marker = b.task ? (b.checked ? "[x]  " : "[ ]  ") : b.ordered ? `${b.marker}. ` : "•  ";
      const ind = (b.indent || 0) * 16; // nested lists indent 16pt/level
      const runs = [{ text: marker, bullet: true }].concat(b.runs);
      emit(wrapRuns(runs, 11, maxWidth - 14 - ind, false), {
        kind: "bullet", size: 11, lh: 11 * 1.4, defColor: PDF.col.body,
        x0: PDF.margin + ind, x1: PDF.margin + 14 + ind, gapBefore: 2
      });
    } else if (b.type === "code") {
      const cl = b.lines.length ? b.lines : [""];
      items.push({ spacer: 5 });
      cl.forEach((raw) => {
        // A wrapped code line keeps the original's leading indent on its
        // continuation so the code stays readable when it exceeds the width.
        const lead = (raw.match(/^\s*/)[0] || "").length;
        const contIndent = Math.min(lead + 2, 24);
        emit(wrapRuns([{ text: raw || " ", code: true }], 9, maxWidth - 16, false), {
          kind: "code", size: 9, lh: 9 * 1.5, defColor: PDF.col.code,
          x0: PDF.margin + 8, x1: PDF.margin + 8 + contIndent * 4.6, gapBefore: 0, isCode: true
        });
      });
      items.push({ spacer: 6 });
    } else {
      emit(wrapRuns(b.runs, 11, maxWidth, false), {
        kind: "para", size: 11, lh: 11 * 1.45, defColor: PDF.col.body,
        x0: PDF.margin, x1: PDF.margin, gapBefore: 5
      });
    }
  }
  return items;
}
// Build the raw .pdf bytes (hand-built, standard fonts) from markdown text.
// Separated from downloadPdf so create_document can save the bytes to the
// connected folder instead of triggering a download.
// ---- page-painting helpers (all coordinates in PDF user space, origin bottom-left) ----
function colorOp(c) { return `${c[0]} ${c[1]} ${c[2]} rg`; }
function rectOp(x, y, w, h, c) {
  return `${colorOp(c)} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`;
}
function textOp(fontKey, size, color, x, y, text) {
  return `BT /${fontKey} ${size} Tf ${colorOp(color)} 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfEsc(winAnsi(text))}) Tj ET`;
}
function labelWidth(text, size) {
  const ctx = measureCtx();
  ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  return ctx.measureText(text).width;
}
function pdfDateLabel() {
  const d = new Date();
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
// Paint one page: background layer (code panels, heading rules, link underlines, header/
// footer rules) first, then the text on top.
function renderPageStream(lines, pageIdx, total, dateLabel) {
  const { pageW, pageH, margin, col } = PDF;
  const maxW = pageW - 2 * margin;
  const bg = [], fg = [];

  // Code-block panels: fill a soft rounded-look rectangle + accent left bar behind each
  // run of consecutive code lines on this page.
  for (let i = 0; i < lines.length;) {
    if (!lines[i].isCode) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].isCode) j++;
    const top = lines[i].baseline + lines[i].size * 0.82 + 4;
    const bot = lines[j].baseline - lines[j].size * 0.28 - 4;
    bg.push(rectOp(margin - 8, bot, maxW + 16, top - bot, col.codeBg));
    bg.push(rectOp(margin - 8, bot, 3, top - bot, col.codeBar));
    i = j + 1;
  }

  // Blockquote left bars behind runs of consecutive quote lines.
  for (let i = 0; i < lines.length;) {
    if (!lines[i].quote) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].quote) j++;
    const top = lines[i].baseline + lines[i].size * 0.82 + 2;
    const bot = lines[j].baseline - lines[j].size * 0.28 - 2;
    bg.push(rectOp(margin, bot, 2.5, top - bot, col.quote));
    i = j + 1;
  }

  // Text, tables (pre-rendered draw payloads), rules, underlines.
  for (const ln of lines) {
    if (ln.draw) {
      for (const r of ln.draw.rects) bg.push(rectOp(r[0], r[1], r[2], r[3], r[4]));
      for (const t of ln.draw.texts) fg.push(textOp(t[0], t[1], t[2], t[3], t[4], t[5]));
      continue;
    }
    if (ln.hr) { bg.push(rectOp(margin, ln.baseline + 3, maxW, 0.5, col.ruleSoft)); continue; }
    let x = ln.x;
    for (const seg of ln.segs) {
      fg.push(textOp(fontKeyFor(seg.st), ln.size, segColor(seg.st, ln.defColor), x, ln.baseline, seg.text));
      if (seg.st.link) bg.push(rectOp(x, ln.baseline - 1.6, seg.w, 0.6, col.link));
      x += seg.w;
    }
    if (ln.ruleAfter) bg.push(rectOp(margin, ln.baseline - ln.size * 0.3, maxW, ln.ruleAfter.thick, ln.ruleAfter.color));
  }

  // Running header: brand label (left) + date (right) above a hairline rule.
  bg.push(rectOp(margin, pageH - 52, maxW, 0.6, col.ruleSoft));
  fg.push(textOp("F2", 8, col.muted, margin, pageH - 46, "Agent Go — Export"));
  fg.push(textOp("F1", 8, col.muted, margin + maxW - labelWidth(dateLabel, 8), pageH - 46, dateLabel));

  // Running footer: hairline rule + centered page number.
  bg.push(rectOp(margin, 48, maxW, 0.6, col.ruleSoft));
  const foot = `Page ${pageIdx + 1} of ${total}`;
  fg.push(textOp("F1", 8, col.muted, margin + (maxW - labelWidth(foot, 8)) / 2, 36, foot));

  return bg.join("\n") + "\n" + fg.join("\n");
}
export function buildPdfBytes(text) {
  const { pageW, pageH, margin, contentTop, contentBottom, col } = PDF;
  const maxW = pageW - 2 * margin;
  const items = layoutBlocks(parseBlocks(text), maxW);

  // Paginate: assign each drawable line a page + top-anchored baseline.
  const pages = [[]];
  let y = contentTop;

  // Lay out a markdown table row-by-row: measure columns, wrap cells, draw a blue
  // header, alternating row shading, and cell borders (mirrors the Master-Mind table).
  const placeTable = (tb) => {
    const ctx = measureCtx();
    const cols = tb.header.length || 1;
    const tf = 8, lineH = 10, padX = 3, padY = 3, startX = margin, tableW = maxW;
    const cellFont = (bold) => `${bold ? "bold " : ""}${tf}px Helvetica, Arial, sans-serif`;
    const wrapCell = (textv, w, bold) => {
      ctx.font = cellFont(bold);
      const words = String(stripInline(textv)).split(/\s+/).filter(Boolean);
      const out = []; let cur = "";
      for (const wd of words) {
        const t = cur ? cur + " " + wd : wd;
        if (ctx.measureText(t).width <= w || !cur) cur = t;
        else { out.push(cur); cur = wd; }
      }
      if (cur) out.push(cur);
      return out.length ? out : [""];
    };
    // natural widths → normalized to the table width
    const nat = [];
    for (let c = 0; c < cols; c++) {
      ctx.font = cellFont(true);
      let m = ctx.measureText(stripInline(tb.header[c] || "")).width;
      for (const r of tb.rows) { ctx.font = cellFont(c === 0); m = Math.max(m, ctx.measureText(stripInline(r[c] || "")).width); }
      nat.push(m + padX * 2 + 2);
    }
    const totNat = nat.reduce((a, v) => a + v, 0) || 1;
    let colW = nat.map((w) => Math.max(34, (w / totNat) * tableW));
    const assigned = colW.reduce((a, v) => a + v, 0) || 1;
    colW = colW.map((w) => (w * tableW) / assigned);
    const colX = (ci) => { let x = startX; for (let k = 0; k < ci; k++) x += colW[k]; return x; };
    const drawRow = (cells, isHeader, alt) => {
      const wrapped = []; let maxLines = 1;
      for (let c = 0; c < cols; c++) {
        const ls = wrapCell(cells[c] || "", colW[c] - padX * 2, isHeader || c === 0);
        wrapped.push(ls); if (ls.length > maxLines) maxLines = ls.length;
      }
      const rowH = maxLines * lineH + padY * 2;
      if (y - rowH < contentBottom) { pages.push([]); y = contentTop; if (!isHeader) drawRow(tb.header, true, false); }
      const rowTop = y, rowBot = y - rowH;
      const rects = [], texts = [];
      if (isHeader) rects.push([startX, rowBot, tableW, rowH, col.tHeadBg]);
      else if (alt) rects.push([startX, rowBot, tableW, rowH, col.tAltBg]);
      rects.push([startX, rowTop - 0.15, tableW, 0.3, col.tBorder]);       // top border
      rects.push([startX, rowBot - 0.15, tableW, 0.3, col.tBorder]);       // bottom border
      for (let v = 0; v <= cols; v++) {                                    // column separators
        const vx = v === cols ? startX + tableW : colX(v);
        rects.push([vx - 0.15, rowBot, 0.3, rowH, col.tBorder]);
      }
      for (let c = 0; c < cols; c++) {
        const cx = colX(c) + padX, ls = wrapped[c];
        const color = isHeader ? col.tHeadText : c === 0 ? col.firstCol : col.body;
        const fk = isHeader || c === 0 ? "F2" : "F1";
        for (let l = 0; l < ls.length; l++) texts.push([fk, tf, color, cx, rowTop - padY - tf * 0.8 - l * lineH, ls[l]]);
      }
      pages[pages.length - 1].push({ draw: { rects, texts } });
      y -= rowH;
    };
    drawRow(tb.header, true, false);
    tb.rows.forEach((r, ri) => drawRow(r, false, ri % 2 === 1));
  };

  for (const it of items) {
    if (it.spacer) { y -= it.spacer; continue; }
    if (it.table) { placeTable(it.table); continue; }
    y -= it.gapBefore || 0;
    if (y - it.lh < contentBottom) { pages.push([]); y = contentTop; }
    pages[pages.length - 1].push({ ...it, baseline: y - it.size });
    y -= it.lh;
  }

  const dateLabel = pdfDateLabel();
  const total = pages.length;

  // Objects: 1 Catalog, 2 Pages, 3-7 Fonts, then per page {page, content}.
  const objs = [];
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>";
  let n = 8;
  const pageMeta = pages.map(() => ({ pageNum: n++, contentNum: n++ }));
  objs[1] = `<< /Type /Pages /Count ${total} /Kids [${pageMeta.map((p) => p.pageNum + " 0 R").join(" ")}] >>`;
  pages.forEach((linesOnPage, pi) => {
    const { pageNum, contentNum } = pageMeta[pi];
    const stream = renderPageStream(linesOnPage, pi, total, dateLabel);
    objs[pageNum - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objs[contentNum - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // Serialize with a cross-reference table (byte offsets == char offsets, all < 256).
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
export function downloadPdf(text, base) {
  triggerDownload(new Blob([buildPdfBytes(text)], { type: "application/pdf" }), base + ".pdf");
}

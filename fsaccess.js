// fsaccess.js — local filesystem access for the agent, via the File System Access
// API. A Chrome MV3 extension is sandboxed and CANNOT read arbitrary OS paths, so
// the user grants ONE root folder through a native picker (a gesture, in the side
// panel); we persist that FileSystemDirectoryHandle in IndexedDB and the agent's
// read tools (list_files / read_file) operate strictly WITHIN it. This is the
// browser-native equivalent of master-mind's server-side MCP filesystem mount:
// "Local File Paths" = the granted root, "Filesystem Access" = the read tools.
// Author: iDevOpsLLC
//
// Permission model: requestPermission() needs a user gesture, so it runs in the
// side panel (ensureReadPermission). Once granted, the grant is shared across the
// extension origin's contexts for the session, so the service worker (where tools
// execute) can queryPermission() === "granted" and read. After a browser restart
// the grant returns to "prompt" until the user re-connects the folder in the panel.

import { EXTRACTABLE_EXTENSIONS, IMAGE_EXTENSIONS, extractDocumentText, imageToVisionBase64, imageMime } from "./extract.js";

const DB_NAME = "localllm-fs";
const STORE = "handles";
const ROOT_KEY = "root";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(key, val) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));
}
function idbDel(key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// MULTI-ROOT (2026-07-22): the agent can hold UP TO 3 connected folders at once
// (e.g. "SN_REF" + "Project Files" + a docs folder). Handles are stored as an
// ARRAY under ROOTS_KEY; a path is routed to a folder by PREFIXING it with the
// folder name (read_file "Project Files/README.md"). Backward-compatible: a single
// legacy "root" handle migrates into the array on first read; one folder needs no
// prefix, so nothing changes for single-folder users.
const ROOTS_KEY = "roots";
export const MAX_ROOTS = 6;              // DEFAULT cap — user-configurable in Settings (settings.maxRoots)
export const HARD_MAX_ROOTS = 20;        // absolute ceiling regardless of the setting

export async function getRootHandles() {
  const arr = await idbGet(ROOTS_KEY);
  if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
  const legacy = await idbGet(ROOT_KEY);   // migrate the pre-multi single handle
  return legacy ? [legacy] : [];
}
export function saveRootHandles(handles) { return idbPut(ROOTS_KEY, (handles || []).slice(0, HARD_MAX_ROOTS)); }

// Add/replace a folder by NAME (re-picking the same folder refreshes its grant).
// `max` is the runtime cap (from settings.maxRoots); clamped to [1, HARD_MAX_ROOTS].
// Returns { ok, roots, reason, max }.
export async function addRootHandle(handle, max = MAX_ROOTS) {
  const cap = Math.max(1, Math.min(Number(max) || MAX_ROOTS, HARD_MAX_ROOTS));
  const arr = await getRootHandles();
  const i = arr.findIndex((h) => h.name === handle.name);
  if (i >= 0) arr[i] = handle;                                   // same folder re-picked
  else if (arr.length >= cap) return { ok: false, roots: arr, max: cap, reason: `max ${cap} folders connected — disconnect one first, or raise the limit in Settings` };
  else arr.push(handle);
  await saveRootHandles(arr);
  await idbDel(ROOT_KEY);                                        // retire the legacy key once we use the array
  return { ok: true, roots: arr, max: cap };
}
export async function removeRootHandleByName(name) {
  const arr = (await getRootHandles()).filter((h) => h.name !== name);
  await saveRootHandles(arr);
  await idbDel(ROOT_KEY);
  return arr;
}
export async function clearAllRoots() { await idbDel(ROOTS_KEY); await idbDel(ROOT_KEY); }

// Route a (possibly folder-prefixed) path to ONE connected root. With a single
// folder, no prefix needed. With multiple, the path MUST start with (or contain)
// a folder name, else we throw a clear, actionable error. The chosen root's op
// then strips the prefix via stripRootPrefix, so callers pass the ORIGINAL path.
export function pickRoot(roots, relPath) {
  if (!roots || !roots.length) throw new Error("No local folder is connected.");
  if (roots.length === 1) return roots[0];
  const segs = String(relPath || "").split(/[\/\\]+/).filter((s) => s && s !== ".");
  const lower = segs.map((s) => s.toLowerCase());
  for (const r of roots) if (segs.length && lower[0] === r.name.toLowerCase()) return r;   // prefix segment
  for (const r of roots) if (lower.includes(r.name.toLowerCase())) return r;               // absolute path
  throw new Error(`Ambiguous path — ${roots.length} folders are connected. PREFIX the path with the folder name, one of: ${roots.map((r) => `"${r.name}"`).join(", ")}. E.g. "${roots[0].name}/${segs.join("/") || "subpath"}".`);
}

// Legacy single-handle shims (kept so callers not yet migrated keep working):
// getRootHandle returns the FIRST connected folder; clearRootHandle clears ALL.
export function saveRootHandle(handle) { return idbPut(ROOT_KEY, handle); }
export async function getRootHandle() { return (await getRootHandles())[0] || null; }
export function clearRootHandle() { return clearAllRoots(); }

// Second, independent handle: the conversation-log folder (conv-log.js).
// Separate key so connecting/disconnecting it never disturbs the agent's
// Local-files MCP root above.
const CONVLOG_KEY = "convlog";
export function saveConvLogHandle(handle) { return idbPut(CONVLOG_KEY, handle); }
export function getConvLogHandle() { return idbGet(CONVLOG_KEY); }
export function clearConvLogHandle() { return idbDel(CONVLOG_KEY); }

// Prompt Builder save-folder handle (its own key, same lifecycle as conv-log:
// granted once via the native picker, persists in IndexedDB, permission drops
// back to "prompt" after a Chrome restart and re-granting needs a gesture).
const PROMPTS_KEY = "promptFolder";
export function savePromptFolderHandle(handle) { return idbPut(PROMPTS_KEY, handle); }
export function getPromptFolderHandle() { return idbGet(PROMPTS_KEY); }
export function clearPromptFolderHandle() { return idbDel(PROMPTS_KEY); }

// queryPermission only (no gesture) — safe to call from the service worker.
// mode: "read" | "readwrite". A readwrite grant also satisfies "read".
export async function hasPermission(handle, mode = "read") {
  if (!handle || !handle.queryPermission) return false;
  try { return (await handle.queryPermission({ mode })) === "granted"; }
  catch { return false; }
}
export const hasReadPermission = (h) => hasPermission(h, "read");
export const hasWritePermission = (h) => hasPermission(h, "readwrite");

// requestPermission needs a user gesture → call ONLY from the side panel.
export async function ensurePermission(handle, mode = "read") {
  if (!handle) return false;
  if ((await handle.queryPermission({ mode })) === "granted") return true;
  return (await handle.requestPermission({ mode })) === "granted";
}
export const ensureReadPermission = (h) => ensurePermission(h, "read");
export const ensureReadWritePermission = (h) => ensurePermission(h, "readwrite");

// ---- master-mind FilesystemToolExecutor parity: containment + hardening ----
// Mirrors src/modules/master-mind/services/filesystem-tool-definitions.js so the
// extension's "Filesystem (MCP)" tools behave like master-mind's: skip vendor/build
// dirs, block sensitive files, only read known text/code types, cap sizes.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", "target", "vendor", "tmp", "logs",
  "__pycache__", ".tox", ".venv", "venv", ".eggs"
]);
const BLOCKED_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|crt|cer|asc)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^\.?(npmrc|netrc|git-credentials|aws)$/i,
  /^service[_-]?account.*\.json$/i,
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
];
const EXTENSIONLESS_ALLOWLIST = new Set([
  "dockerfile", "makefile", "license", "readme", "changelog",
  "procfile", "gemfile", "rakefile", "jenkinsfile", "gulpfile", "gruntfile"
]);
const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".java", ".cs", ".go", ".rb", ".php",
  ".swift", ".kt", ".rs", ".c", ".cpp", ".h", ".hpp", ".dart", ".lua", ".r", ".sql",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".svg",
  ".sh", ".bash", ".ps1", ".bat", ".graphql", ".gql", ".proto", ".tf"
]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}
function isBlockedFilename(name) { return BLOCKED_FILENAME_PATTERNS.some((p) => p.test(name)); }
function isAllowedFile(name) {
  const ext = extOf(name);
  if (ext) return ALLOWED_EXTENSIONS.has(ext);
  return EXTENSIONLESS_ALLOWLIST.has(name.toLowerCase());
}

// How read_file treats a filename: "text" (read as-is), "extract" (binary
// document — text extracted via extract.js), "image" (described by the vision
// model), "blocked" (sensitive — .env/keys stay blocked regardless of type),
// "unsupported" (no way to read meaningfully, e.g. .db/.zip/.exe/legacy .doc).
export function readCategory(name) {
  if (isBlockedFilename(name)) return "blocked";
  if (isAllowedFile(name)) return "text";
  const ext = extOf(name);
  if (EXTRACTABLE_EXTENSIONS.has(ext)) return "extract";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unsupported";
}

const MAX_FILE_BYTES = 1024 * 1024;         // 1 MB/file for TEXT files (master-mind parity)
const MAX_BINARY_BYTES = 25 * 1024 * 1024;  // 25 MB for extractable documents / images
const MAX_RESPONSE_CHARS = 200000;          // 200K chars/response
const MAX_DIR_ENTRIES = 2000;
const MAX_RECURSIVE_DEPTH = 8;

// Models often pass an ABSOLUTE path (e.g. "C:\\redacted\\path") even though
// the API is root-relative. If the connected root's folder name appears as a
// segment, take everything AFTER it (the relative path). A drive-letter path that
// doesn't contain the root name is genuinely outside the sandbox → error.
function stripRootPrefix(rootName, relPath) {
  const segs = String(relPath || "").split(/[\/\\]+/).filter((s) => s && s !== ".");
  // Case-insensitive to match pickRoot (Windows paths arrive in whatever case the
  // model copied from the task text).
  const want = String(rootName || "").toLowerCase();
  let idx = -1;
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].toLowerCase() === want) { idx = i; break; }
  if (idx >= 0) return segs.slice(idx + 1).join("/");
  if (/^[a-zA-Z]:$/.test(segs[0] || "")) {
    throw new Error(`"${relPath}" is outside the connected folder "${rootName}". Pass a path relative to it (e.g. "${segs[segs.length - 1] || "."}").`);
  }
  return relPath;
}

// Split a relative path into clean segments; reject absolute paths and any ".."
// traversal (the API also forbids escaping the root, but we fail loudly/early).
function splitPath(relPath) {
  const parts = String(relPath || "").split(/[\/\\]+/).filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("Path traversal ('..') is not allowed — paths are relative to the connected root.");
  return parts;
}

async function dirAt(root, parts, create = false) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, create ? { create: true } : undefined);
  return dir;
}

// List a directory (relative to root; "" = root). recursive walks subfolders
// (depth ≤ 8, ≤ 2000 entries), skipping vendor/build dirs. Returns a formatted
// text listing (dirs first) with sizes + a [blocked] flag for unreadable files —
// matching master-mind's fs_list_directory output.
export async function listDir(root, relPath = "", recursive = false) {
  const base = splitPath(stripRootPrefix(root.name, relPath));
  const dir = await dirAt(root, base);
  const baseStr = base.join("/") || ".";
  const out = [];
  const counter = { n: 0, truncated: false };
  await walkDir(dir, baseStr, out, recursive, 0, counter);
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));

  const dirs = out.filter((e) => e.type === "directory");
  const files = out.filter((e) => e.type === "file");
  let text = `Directory: ${baseStr}${recursive ? " (recursive)" : ""}\nDirectories: ${dirs.length} | Files: ${files.length}\n`;
  if (counter.truncated) text += `[Listing truncated at ${MAX_DIR_ENTRIES} entries]\n`;
  text += "\n";
  for (const e of out) {
    if (e.type === "directory") text += `  [DIR]  ${e.name}/\n`;
    else text += `  [FILE] ${e.name} (${humanSize(e.size)})${e.readable ? "" : " [blocked]"}\n`;
  }
  return { content: text, count: out.length, truncated: counter.truncated };
}

async function walkDir(dirHandle, relBase, out, recursive, depth, counter) {
  if (counter.n >= MAX_DIR_ENTRIES) { counter.truncated = true; return; }
  if (recursive && depth > MAX_RECURSIVE_DEPTH) return;
  const kids = [];
  for await (const [name, h] of dirHandle.entries()) kids.push([name, h]);
  kids.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, h] of kids) {
    if (counter.n >= MAX_DIR_ENTRIES) { counter.truncated = true; return; }
    const rel = relBase === "." ? name : `${relBase}/${name}`;
    if (h.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      out.push({ name: rel, type: "directory" });
      counter.n++;
      if (recursive) await walkDir(h, rel, out, true, depth + 1, counter);
    } else {
      let size = 0;
      try { size = (await h.getFile()).size; } catch {}
      const cat = readCategory(name);
      const readable = cat === "text" ? size <= MAX_FILE_BYTES
        : (cat === "extract" || cat === "image") ? size <= MAX_BINARY_BYTES
        : false;
      out.push({ name: rel, type: "file", size, readable });
      counter.n++;
    }
  }
}

function humanSize(bytes) {
  if (bytes == null) return "?";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

// Apply optional 1-indexed start_line/end_line slicing + the response char cap.
function sliceAndCap(raw, opts, size) {
  const cap = Number.isFinite(opts.maxChars) ? opts.maxChars : MAX_RESPONSE_CHARS;
  const start = opts.startLine, end = opts.endLine;
  let content = raw, totalLines = null, lineRange = null;
  if (start != null || end != null) {
    const lines = raw.split("\n");
    totalLines = lines.length;
    let s = start ? Math.max(1, start) : 1;
    let e = end ? Math.min(totalLines, end) : totalLines;
    if (s > totalLines) s = totalLines;
    if (e < s) e = s;
    content = lines.slice(s - 1, e).join("\n");
    lineRange = { start: s, end: e, total: totalLines };
  }
  let truncated = false;
  if (content.length > cap) { content = content.slice(0, cap) + `\n\n[...truncated at ${cap.toLocaleString()} chars; file is ${size.toLocaleString()} bytes. Use start_line/end_line.]`; truncated = true; }
  return { content, totalLines, lineRange, truncated };
}

// Read a file (relative to root). Text/code files are read as-is; binary
// documents (.pdf/.docx/.xlsx/.pptx/.rtf) get their TEXT extracted (extract.js);
// image files return { image, base64 } for the caller to describe via the vision
// model. Honors blocked-filename rules, per-category size caps, and optional
// 1-indexed start_line/end_line partial reads capped to MAX_RESPONSE_CHARS.
export async function readFileText(root, relPath, opts = {}) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a file path relative to the connected root.");
  const basename = parts[parts.length - 1];
  const cat = readCategory(basename);
  if (cat === "blocked") { const e = new Error("Access to sensitive files is blocked: " + basename); e.code = "BLOCKED_FILENAME"; throw e; }
  if (cat === "unsupported") {
    const ext = extOf(basename) || "(no extension)";
    const legacy = /^\.(doc|xls|ppt)$/.test(ext) ? ` Legacy binary Office files can't be parsed — re-save it as ${ext}x.` : "";
    const e = new Error(`File type not supported for reading: ${ext}. Readable: text/code files, .pdf/.docx/.xlsx/.pptx/.rtf (text extracted), and images (described).${legacy}`);
    e.code = "UNSUPPORTED_TYPE"; throw e;
  }

  const dir = await dirAt(root, parts.slice(0, -1));
  const fh = await dir.getFileHandle(basename);
  const file = await fh.getFile();
  const maxBytes = cat === "text" ? MAX_FILE_BYTES : MAX_BINARY_BYTES;
  if (file.size > maxBytes) {
    const e = new Error(`File exceeds the ${Math.round(maxBytes / 1024 / 1024) || 1}MB ${cat === "text" ? "text-file" : "document"} limit (${(file.size / 1024 / 1024).toFixed(1)}MB).${cat === "text" ? " Use start_line/end_line for a partial read." : ""}`);
    e.code = "FILE_TOO_LARGE"; throw e;
  }

  if (cat === "image") {
    const ext = extOf(basename);
    const base64 = await imageToVisionBase64(new Uint8Array(await file.arrayBuffer()), ext);
    return { image: true, base64, mime: imageMime(ext), name: basename, size: file.size };
  }

  let raw, extracted;
  if (cat === "extract") {
    const res = await extractDocumentText(new Uint8Array(await file.arrayBuffer()), extOf(basename));
    if (res.text == null) {
      const e = new Error("This PDF's text could not be extracted by the in-panel reader (scanned/image-only, or a font encoding it can't decode).");
      e.code = "NO_TEXT_LAYER"; throw e;
    }
    raw = res.text;
    extracted = res.format;
  } else {
    raw = await file.text();
  }

  const sliced = sliceAndCap(raw, opts, file.size);
  const out = { content: sliced.content, name: basename, size: file.size, totalLines: sliced.totalLines, lineRange: sliced.lineRange, truncated: sliced.truncated };
  if (extracted) { out.extracted = extracted; out.note = `Text extracted from the binary .${extracted} file (layout is approximate).`; }
  return out;
}

// Raw bytes of a connected-folder file as base64 (2026-09-07c). Used to hand a
// PDF the in-panel extractor cannot read (scanned pages, undecodable fonts) to
// the desktop-server's PyMuPDF + Tesseract path: the File System Access API
// hides the folder's disk path, so the bytes are the only thing that can travel.
// Same blocked-name and 25 MB rules as readFileText.
export async function readFileBytesB64(root, relPath) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a file path relative to the connected root.");
  const basename = parts[parts.length - 1];
  if (readCategory(basename) === "blocked") { const e = new Error("Access to sensitive files is blocked: " + basename); e.code = "BLOCKED_FILENAME"; throw e; }
  const dir = await dirAt(root, parts.slice(0, -1));
  const fh = await dir.getFileHandle(basename);
  const file = await fh.getFile();
  if (file.size > MAX_BINARY_BYTES) {
    const e = new Error(`File exceeds the ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)}MB document limit (${(file.size / 1024 / 1024).toFixed(1)}MB).`);
    e.code = "FILE_TOO_LARGE"; throw e;
  }
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || "").replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error || new Error("could not read the file's bytes"));
    fr.readAsDataURL(file);
  });
  return { base64, name: basename, size: file.size, ext: extOf(basename) };
}

// Write text to a file (relative to root), creating the file and any missing
// parent folders. Overwrites existing content. Requires readwrite permission.
export async function writeFileText(root, relPath, content) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a file path relative to the connected root.");
  const dir = await dirAt(root, parts.slice(0, -1), true); // create missing parent dirs
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fh.createWritable();
  const text = String(content ?? "");
  await writable.write(text);
  await writable.close();
  return { name: fh.name, bytes: text.length };
}

// Write BINARY bytes (Uint8Array) to a file (relative to root), creating the file
// and any missing parent folders. Used for generated .docx / .pdf documents (which
// are binary), where writeFileText would corrupt the bytes via string coercion.
// Requires readwrite permission.
export async function writeFileBytes(root, relPath, bytes) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a file path relative to the connected root.");
  if (!(bytes instanceof Uint8Array)) throw new Error("writeFileBytes requires a Uint8Array.");
  const dir = await dirAt(root, parts.slice(0, -1), true); // create missing parent dirs
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
  return { name: fh.name, bytes: bytes.length };
}

// ---- edit_file: surgical exact-match find/replace --------------------------
// Safer than write_file for editing an existing file: the model supplies only
// the snippet to change, not the whole file (a small model rewriting an 800-line
// file to change 3 lines is where corruption happens). Fails LOUDLY when the
// old text isn't found or is ambiguous, so a bad edit never silently wrecks the
// file. Text files only (uses the same read/allow rules). Returns a unified-ish
// diff summary for the approval card.
export async function editFile(root, relPath, oldText, newText, opts = {}) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a file path relative to the connected root.");
  const basename = parts[parts.length - 1];
  if (readCategory(basename) !== "text") throw new Error(`edit_file only edits text/code files (got ${extOf(basename) || "no extension"}). Use write_file for a full rewrite, or move_file for binaries.`);
  if (oldText == null || oldText === "") throw new Error("edit_file requires non-empty old_text to locate the edit.");

  const dir = await dirAt(root, parts.slice(0, -1));
  const fh = await dir.getFileHandle(basename); // throws if missing — edit_file never creates files
  const file = await fh.getFile();
  if (file.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${Math.round(MAX_FILE_BYTES / 1024)}KB — too large to edit safely in one call.`);
  const original = await file.text();

  const os = String(oldText), ns = String(newText ?? "");
  // Count occurrences without regex (old text may contain regex metachars).
  let count = 0, idx = original.indexOf(os);
  while (idx !== -1) { count++; idx = original.indexOf(os, idx + os.length); }
  if (count === 0) throw new Error("old_text was not found in the file. Read the file first and copy the EXACT text (including whitespace/indentation) you want to replace.");
  if (count > 1 && !opts.replaceAll) throw new Error(`old_text appears ${count} times — the edit is ambiguous. Include more surrounding context to make it unique, or pass replace_all:true to replace every occurrence.`);

  const updated = opts.replaceAll ? original.split(os).join(ns) : original.replace(os, ns);
  const writable = await fh.createWritable();
  await writable.write(updated);
  await writable.close();
  return {
    name: basename,
    replacements: opts.replaceAll ? count : 1,
    bytes_before: file.size,
    bytes_after: updated.length,
    diff: unifiedDiffSnippet(os, ns)
  };
}

// A compact -/+ preview of a single hunk (not a full-file diff) for the approval
// card and the tool result. Line-oriented; truncated for very large snippets.
export function unifiedDiffSnippet(oldText, newText, maxLines = 40) {
  const oldLines = String(oldText).split("\n");
  const newLines = String(newText).split("\n");
  const out = [];
  for (const l of oldLines) out.push("- " + l);
  for (const l of newLines) out.push("+ " + l);
  if (out.length > maxLines) return out.slice(0, maxLines).join("\n") + `\n… (+${out.length - maxLines} more diff lines)`;
  return out.join("\n");
}

// ---- search_files: grep across the connected folder ------------------------
// Regex content search over readable TEXT files (skips vendor/build dirs, binary
// and blocked files), returning path:line:matched-line hits — the "where is this
// used?" tool. Bounded so a broad pattern can't return the whole tree.
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;   // don't slurp huge files into the matcher
const SEARCH_MAX_HITS = 300;
const SEARCH_MAX_FILES_SCANNED = 4000;

export async function searchFiles(root, pattern, opts = {}) {
  if (!String(pattern || "").trim()) throw new Error("search_files requires a non-empty pattern.");
  let rx;
  try { rx = new RegExp(pattern, opts.caseSensitive ? "g" : "gi"); }
  catch (e) { throw new Error(`Invalid regex pattern: ${e.message}`); }

  let glob = null;
  if (opts.glob) {
    // Support a simple "*.ext" / "*.{js,ts}" filename glob → regex on the basename.
    const g = String(opts.glob).trim();
    const body = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
      .replace(/\\\{([^}]*)\\\}/g, (_, inner) => "(" + inner.split(",").map((s) => s.trim()).join("|") + ")");
    try { glob = new RegExp("^" + body + "$", "i"); } catch { glob = null; }
  }

  const baseParts = splitPath(stripRootPrefix(root.name, opts.path || ""));
  const startDir = await dirAt(root, baseParts);
  const startRel = baseParts.join("/");
  const hits = [];
  const stats = { filesScanned: 0, truncated: false, capHit: false };
  await searchWalk(startDir, startRel, rx, glob, hits, stats, 0);
  return {
    pattern,
    root: opts.path || "(root)",
    matches: hits,
    files_scanned: stats.filesScanned,
    truncated: stats.truncated || stats.capHit,
    note: hits.length
      ? (stats.truncated ? `Stopped at ${SEARCH_MAX_HITS} matches — narrow the pattern or set a subfolder path.` : `${hits.length} match(es).`)
      : "No matches. Check the pattern (it's a regex), or widen the path/glob."
  };
}

async function searchWalk(dirHandle, relBase, rx, glob, hits, stats, depth) {
  if (hits.length >= SEARCH_MAX_HITS) { stats.truncated = true; return; }
  if (depth > MAX_RECURSIVE_DEPTH || stats.filesScanned >= SEARCH_MAX_FILES_SCANNED) { stats.capHit = true; return; }
  const kids = [];
  for await (const [name, h] of dirHandle.entries()) kids.push([name, h]);
  kids.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, h] of kids) {
    if (hits.length >= SEARCH_MAX_HITS) { stats.truncated = true; return; }
    const rel = relBase ? `${relBase}/${name}` : name;
    if (h.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      await searchWalk(h, rel, rx, glob, hits, stats, depth + 1);
    } else {
      if (readCategory(name) !== "text") continue;      // text/code only
      if (glob && !glob.test(name)) continue;
      let file;
      try { file = await h.getFile(); } catch { continue; }
      if (file.size > SEARCH_MAX_FILE_BYTES) continue;
      stats.filesScanned++;
      if (stats.filesScanned > SEARCH_MAX_FILES_SCANNED) { stats.capHit = true; return; }
      let text;
      try { text = await file.text(); } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        rx.lastIndex = 0;
        if (rx.test(lines[i])) {
          hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300).trim() });
          if (hits.length >= SEARCH_MAX_HITS) { stats.truncated = true; return; }
        }
      }
    }
  }
}

// ---- Organize: create folders, move/rename, copy, delete -------------------
// Moves and copies transfer raw BYTES via Blob streams — file contents never
// enter the model context — so they work on EVERY file type, including the
// binary/sensitive types read_file blocks (.pdf, .docx, .png, .db). The File
// System Access API has no cross-directory move for local folders (and none at
// all for directories), so a move is verified-copy-then-delete: the source is
// removed only AFTER the whole copy succeeded, so a failure can leave a partial
// duplicate but never lose data.

const MAX_TRANSFER_ENTRIES = 3000; // per move/copy of one folder tree (nothing is skipped — node_modules etc. count)

async function entryKind(dir, name) {
  try { await dir.getFileHandle(name); return "file"; } catch {}
  try { await dir.getDirectoryHandle(name); return "directory"; } catch {}
  return null;
}

// Resolve an EXISTING file-or-folder entry → { kind, handle, parent, name, rel }.
async function getEntry(root, relPath) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a path relative to the connected root (the root itself cannot be moved or deleted).");
  const parent = await dirAt(root, parts.slice(0, -1));
  const name = parts[parts.length - 1];
  const kind = await entryKind(parent, name);
  if (!kind) throw new Error(`Not found: "${parts.join("/")}"`);
  const handle = kind === "file" ? await parent.getFileHandle(name) : await parent.getDirectoryHandle(name);
  return { kind, handle, parent, name, rel: parts.join("/") };
}

// Create a folder (and any missing parents). Idempotent on an existing folder.
export async function createFolder(root, relPath) {
  const parts = splitPath(stripRootPrefix(root.name, relPath));
  if (!parts.length) throw new Error("Provide a folder path relative to the connected root.");
  const parent = await dirAt(root, parts.slice(0, -1), true);
  const name = parts[parts.length - 1];
  const existedAs = await entryKind(parent, name);
  if (existedAs === "file") throw new Error(`A FILE already exists at "${parts.join("/")}" — cannot create a folder with the same name.`);
  await parent.getDirectoryHandle(name, { create: true });
  return { path: parts.join("/"), created: existedAs !== "directory", existed: existedAs === "directory" };
}

async function copyFileTo(srcHandle, destDir, destName) {
  const file = await srcHandle.getFile();
  const out = await destDir.getFileHandle(destName, { create: true });
  const w = await out.createWritable();
  await w.write(file); // raw bytes — binary-safe, contents never surface
  await w.close();
  return file.size;
}

async function copyDirTo(srcDir, destParentDir, destName, counter) {
  const dest = await destParentDir.getDirectoryHandle(destName, { create: true });
  for await (const [name, h] of srcDir.entries()) {
    if (++counter.entries > MAX_TRANSFER_ENTRIES) {
      throw new Error(`Folder has more than ${MAX_TRANSFER_ENTRIES} entries — too large to move/copy in one call. Move its sub-folders individually. (Nothing was deleted; a partial copy may exist at the destination.)`);
    }
    if (h.kind === "directory") await copyDirTo(h, dest, name, counter);
    else { counter.bytes += await copyFileTo(h, dest, name); counter.files++; }
  }
}

// Shared move/copy. `to` semantics match `mv`: an EXISTING folder (or a path
// with a trailing slash) means "put it INSIDE, keeping the source name";
// anything else is the full destination path (i.e. a rename). "" / "." = root.
async function transferPath(root, fromPath, toPath, { overwrite = false, removeSource = false } = {}) {
  const verb = removeSource ? "move" : "copy";
  const src = await getEntry(root, fromPath);

  const intoFolder = /[\/\\]\s*$/.test(String(toPath || ""));
  const destParts = splitPath(stripRootPrefix(root.name, toPath));
  let parentParts, destName;
  if (!destParts.length) { parentParts = []; destName = src.name; }
  else {
    let existingDir = null;
    try { existingDir = await dirAt(root, destParts); } catch {}
    if (existingDir || intoFolder) { parentParts = destParts; destName = src.name; }
    else { parentParts = destParts.slice(0, -1); destName = destParts[destParts.length - 1]; }
  }
  const destRel = [...parentParts, destName].join("/");

  // Guards BEFORE creating anything at the destination.
  if (destRel === src.rel) return { ok: true, from: src.rel, to: destRel, kind: src.kind, note: "Source and destination are the same path — nothing to do." };
  if (src.kind === "directory") {
    const parentRel = parentParts.join("/");
    if (parentRel === src.rel || parentRel.startsWith(src.rel + "/")) {
      throw new Error(`Cannot ${verb} folder "${src.rel}" into itself ("${destRel}").`);
    }
  }
  const destParent = await dirAt(root, parentParts, true); // create missing destination folders
  const destExisting = await entryKind(destParent, destName);
  if (destExisting) {
    if (destExisting === "directory") throw new Error(`A folder already exists at "${destRel}" — folders are never overwritten or merged. Choose another name, or ${verb} the items individually.`);
    if (src.kind === "directory") throw new Error(`A file already exists at "${destRel}" — cannot replace a file with a folder.`);
    if (!overwrite) throw new Error(`A file already exists at "${destRel}". Pass overwrite:true to replace it, or choose another name.`);
  }

  const counter = { entries: 0, files: 0, bytes: 0 };
  if (src.kind === "file") {
    // Native move when supported (atomic rename/relocate); fall back to copy+delete.
    if (removeSource && !destExisting && typeof src.handle.move === "function") {
      try {
        await src.handle.move(destParent, destName);
        return { from: src.rel, to: destRel, kind: "file", files: 1, native: true };
      } catch { /* not supported for this case — copy+delete below */ }
    }
    counter.bytes = await copyFileTo(src.handle, destParent, destName);
    counter.files = 1;
  } else {
    await copyDirTo(src.handle, destParent, destName, counter);
  }
  if (removeSource) await src.parent.removeEntry(src.name, { recursive: src.kind === "directory" });
  return { from: src.rel, to: destRel, kind: src.kind, files: counter.files, bytes: counter.bytes };
}

export function movePath(root, fromPath, toPath, opts = {}) { return transferPath(root, fromPath, toPath, { ...opts, removeSource: true }); }
export function copyPath(root, fromPath, toPath, opts = {}) { return transferPath(root, fromPath, toPath, { ...opts, removeSource: false }); }

// Delete a file or folder. A non-empty folder requires explicit recursive:true.
export async function deletePath(root, relPath, { recursive = false } = {}) {
  const src = await getEntry(root, relPath);
  if (src.kind === "directory" && !recursive) {
    let empty = true;
    for await (const _k of src.handle.keys()) { empty = false; break; }
    if (!empty) throw new Error(`Folder "${src.rel}" is not empty. Pass recursive:true to delete it AND everything inside it (irreversible).`);
  }
  await src.parent.removeEntry(src.name, { recursive: src.kind === "directory" && recursive });
  return { deleted: src.rel, kind: src.kind };
}

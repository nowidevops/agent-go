// Prompt Builder modal wiring. Lives in its OWN module (loaded from
// sidepanel.html after sidepanel.js) so the NUL-byte-bearing sidepanel.js is
// never rewritten. Talks to background via {type:"build_prompt"}.

const $ = (id) => document.getElementById(id);

const overlay = $("pbOverlay");
const goalEl = $("pbGoal");
const outEl = $("pbOut");
const statusEl = $("pbStatus");
const resultWrap = $("pbResultWrap");
const genBtn = $("pbGen");
// Standalone (detached-window) mode: prompt-builder.html has no overlay — the
// page IS the builder. Same IDs, same handlers; only modal open/close and the
// composer-dependent Insert button differ.
const standalone = !overlay;

function openModal() {
  if (standalone) return;
  // Close the attach menu we were launched from and keep its ARIA truthful.
  $("attachMenu")?.classList.remove("open");
  $("attach")?.setAttribute("aria-expanded", "false");
  overlay.classList.add("open");
  goalEl.focus();
  refreshVisionInfo(); // provider may have changed since the last open
}
function closeModal() { overlay?.classList.remove("open"); }

// ⧉ Detach: open the builder as its own window (localStorage is shared, so
// history / session / zoom carry over) and close the cramped modal.
$("pbDetach")?.addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("prompt-builder.html"), type: "popup", width: 820, height: 900 });
  closeModal();
});
// No composer exists in the detached window — hide Insert there.
if (standalone) { const u = $("pbUse"); if (u) u.style.display = "none"; }

// Text zoom for the modal (A− / A+ in the header, Ctrl+scroll in the boxes).
// Applies to the goal + generated-prompt textareas; persisted so the size the
// user can comfortably read survives panel reopens.
const PB_ZOOM_KEY = "pbZoomPx";
let pbZoom = Math.min(24, Math.max(10, parseInt(localStorage.getItem(PB_ZOOM_KEY), 10) || 13));
function applyZoom() {
  for (const el of [goalEl, outEl]) if (el) el.style.fontSize = pbZoom + "px";
  localStorage.setItem(PB_ZOOM_KEY, String(pbZoom));
}
function bumpZoom(delta) { pbZoom = Math.min(24, Math.max(10, pbZoom + delta)); applyZoom(); }
$("pbZoomIn")?.addEventListener("click", () => bumpZoom(1));
$("pbZoomOut")?.addEventListener("click", () => bumpZoom(-1));
for (const el of [goalEl, outEl]) {
  el?.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    bumpZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}
applyZoom();

// Preset chips seed the goal box with a best-practice skeleton (placeholders
// in <angle brackets>) AND select a preset key that is sent with the
// build_prompt call — the writer is then FORCED to keep the pack-trigger
// phrasing ("ServiceNow", "code review", "deep research", …) in the finished
// prompt, so the matching guardrail pack deterministically injects when the
// prompt is run. Click the active chip again to deselect.
let pbPreset = null;
const snAreasWrap = $("pbSnAreas");
function syncSnAreasRow() {
  // Focus areas apply to ServiceNow-shaped work: the build, review,
  // fact-finding, and post-deployment presets (fact finding: pre-scope when the
  // user already knows which artifact types the story touches; post deployment:
  // pre-scope to the artifact types the update set actually carries).
  if (snAreasWrap) snAreasWrap.hidden = !["servicenow", "review", "factfinding", "postdeploy"].includes(pbPreset);
}
function selectedSnAreas() {
  return [...document.querySelectorAll("#pbSnAreas .pb-area.active")].map((c) => c.textContent.trim());
}
for (const area of document.querySelectorAll("#pbSnAreas .pb-area")) {
  area.addEventListener("click", () => {
    area.classList.toggle("active");
    const sel = selectedSnAreas();
    statusEl.textContent = sel.length
      ? "Focus areas: " + sel.join(", ") + " — the prompt will scope to these and ground them via sn_api_reference."
      : "No focus areas selected — the prompt will scope from your goal text alone.";
  });
}
for (const chip of document.querySelectorAll("#pbChips .pb-chip:not(.pb-area)")) {
  chip.addEventListener("click", () => {
    const wasActive = chip.classList.contains("active");
    document.querySelectorAll("#pbChips .pb-chip").forEach((c) => c.classList.remove("active"));
    if (wasActive) {
      pbPreset = null;
      syncSnAreasRow();
      statusEl.textContent = "Preset cleared.";
      return;
    }
    chip.classList.add("active");
    pbPreset = chip.dataset.preset || null;
    syncSnAreasRow();
    goalEl.value = chip.dataset.tpl || "";
    // Multi-line skeletons (the Post-deployment chip ships a 6-line form) would
    // otherwise land in a 3-row box the user has to scroll to fill in.
    goalEl.rows = Math.min(12, Math.max(3, goalEl.value.split("\n").length + 1));
    goalEl.focus();
    goalEl.setSelectionRange(0, 0);
    statusEl.textContent = "Template loaded — replace the <placeholders>, then Generate. The prompt will carry this preset's guardrail-pack wording.";
  });
}

// History (last 10 generations) + session restore, both in localStorage.
const PB_HIST_KEY = "pbHistory.v1";
const PB_LAST_KEY = "pbLast.v1";
const histSel = $("pbHistory");
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(PB_HIST_KEY)) || []; } catch { return []; }
}
function renderHistory() {
  if (!histSel) return;
  const items = loadHistory();
  histSel.replaceChildren(new Option("🕘 Recent prompts…", ""));
  items.forEach((it, i) => {
    const when = new Date(it.ts).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    histSel.add(new Option(`${when} — ${it.goal.slice(0, 60)}`, String(i)));
  });
  histSel.style.display = items.length ? "" : "none";
}
function pushHistory(goal, prompt, model) {
  const items = loadHistory().filter((it) => it.goal !== goal || it.prompt !== prompt);
  items.unshift({ goal, prompt, model: model || "", ts: Date.now() });
  localStorage.setItem(PB_HIST_KEY, JSON.stringify(items.slice(0, 10)));
  renderHistory();
}
histSel?.addEventListener("change", () => {
  const it = loadHistory()[Number(histSel.value)];
  if (!it) return;
  goalEl.value = it.goal;
  outEl.value = it.prompt;
  resultWrap.hidden = false;
  $("pbRegen").hidden = false;
  setModelBadge(it.model);
  updateCount();
  statusEl.textContent = "Recalled from history.";
  histSel.value = "";
});
function saveSession() {
  localStorage.setItem(PB_LAST_KEY, JSON.stringify({ goal: goalEl.value, prompt: outEl.value, model: pbModelStr }));
}
goalEl?.addEventListener("input", saveSession);
outEl?.addEventListener("input", saveSession);
try {
  const last = JSON.parse(localStorage.getItem(PB_LAST_KEY));
  if (last && (last.goal || last.prompt)) {
    goalEl.value = last.goal || "";
    if (last.prompt) { outEl.value = last.prompt; resultWrap.hidden = false; $("pbRegen").hidden = false; setModelBadge(last.model); }
  }
} catch { /* fresh start */ }
renderHistory();

// 📎 Attachments — extra context for the writer. Images become vision
// descriptions in the background; text files are quoted (truncated). Held
// in memory only (they can be MBs — not localStorage material).
const pbAttachments = []; // {name, kind:"image"|"text", dataUrl?|text?}
const filesWrap = $("pbFiles");
const filePick = $("pbFilePick");

// Vision-availability indicator: 👁 <model> when images CAN be described,
// 🚫👁 when the active provider can't see and no local vision model is set —
// attached image chips also get a ⚠ so it's obvious per-file.
let pbVision = null; // {available, via, model} | null (unknown)
async function refreshVisionInfo() {
  try { pbVision = await chrome.runtime.sendMessage({ type: "vision_info" }); } catch { pbVision = null; }
  const el = $("pbVision");
  if (el) {
    if (pbVision && pbVision.available) {
      el.hidden = false;
      el.textContent = "👁 " + (pbVision.model || "vision") + (pbVision.paired ? " (paired)" : "");
      el.title = pbVision.paired
        ? "Your provider can't see images, so they are AUTO-PAIRED to the local vision model " + pbVision.model + " for description."
        : "Attached images will be described by your cloud model " + (pbVision.model || "") + ".";
      el.style.borderColor = ""; el.style.color = "";
    } else if (pbVision) {
      el.hidden = false;
      el.textContent = "🚫👁 " + (pbVision.model || "vision model") + " not pulled";
      el.title = "Images auto-pair to the local vision model " + (pbVision.model || "") + ", but it is NOT pulled in Ollama — attached images will NOT be described. Run: " + (pbVision.hint || "ollama pull " + (pbVision.model || "")) + " (or switch to a vision-capable cloud provider).";
      el.style.borderColor = "var(--accent-orange, #CE9178)"; el.style.color = "var(--accent-orange, #CE9178)";
    } else {
      el.hidden = true;
    }
  }
  renderFiles();
}
function renderFiles() {
  if (!filesWrap) return;
  const noVision = pbVision && !pbVision.available;
  filesWrap.replaceChildren(...pbAttachments.map((f, i) => {
    const chip = document.createElement("button");
    chip.className = "pb-chip";
    const warn = f.kind === "image" && noVision;
    chip.title = (warn ? "⚠ No vision available — this image will NOT be described. " : "") + "Remove " + f.name;
    chip.textContent = (f.kind === "image" ? (warn ? "🖼⚠ " : "🖼 ") : "📄 ") + f.name + " ✕";
    if (warn) { chip.style.borderColor = "var(--accent-orange, #CE9178)"; chip.style.color = "var(--accent-orange, #CE9178)"; }
    chip.addEventListener("click", () => { pbAttachments.splice(i, 1); renderFiles(); });
    return chip;
  }));
}
refreshVisionInfo();
async function addFiles(fileList) {
  for (const f of fileList) {
    if (pbAttachments.length >= 5) { statusEl.textContent = "Attachment cap reached (5 files)."; break; }
    if (f.type.startsWith("image/")) {
      if (f.size > 4 * 1024 * 1024) { statusEl.textContent = `${f.name} skipped — image over 4 MB.`; continue; }
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      });
      pbAttachments.push({ name: f.name, kind: "image", dataUrl });
      if (pbVision && !pbVision.available) statusEl.textContent = "⚠ " + f.name + " will NOT be described — the paired vision model " + (pbVision.model || "") + " isn't pulled in Ollama (run: " + (pbVision.hint || "") + ").";
    } else {
      if (f.size > 300 * 1024) { statusEl.textContent = `${f.name} skipped — text file over 300 KB.`; continue; }
      const text = await f.text();
      pbAttachments.push({ name: f.name, kind: "text", text: text.slice(0, 6000) });
    }
  }
  renderFiles();
}
$("pbAttach")?.addEventListener("click", () => filePick?.click());
filePick?.addEventListener("change", async () => {
  await addFiles([...filePick.files]);
  filePick.value = "";
});
// Paste a screenshot (Snipping Tool etc.) straight into the goal box.
goalEl?.addEventListener("paste", (e) => {
  const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
  if (!imgs.length) return;
  addFiles(imgs.map((it, i) => {
    const blob = it.getAsFile();
    return new File([blob], `pasted-${Date.now()}-${i}.png`, { type: blob.type });
  }));
});

// Outlined badge naming the AI model that generated the current prompt.
// res.model arrives as "provider:model" — show the model name; keep the
// provider only for local (ollama) models whose own names carry a ":tag".
let pbModelStr = "";
function setModelBadge(m) {
  pbModelStr = m || "";
  const el = $("pbModel");
  if (!el) return;
  const name = pbModelStr.replace(/^(ollama|openai|gemini|anthropic|xai|claude-sub|custom):/, "");
  el.textContent = name ? "🧠 " + name : "";
  el.hidden = !name;
  el.title = pbModelStr ? "Generated by " + pbModelStr : "";
}

// Live character/word count under the output label.
const countEl = $("pbCount");
function updateCount() {
  if (!countEl) return;
  const t = outEl.value;
  countEl.textContent = t ? `${t.length} chars · ${(t.trim().match(/\S+/g) || []).length} words` : "";
}
outEl?.addEventListener("input", updateCount);
updateCount();

$("pbRegen")?.addEventListener("click", generate);

// 🗑 Clear — full reset for a fresh start when the result wasn't specific
// enough: goal, output, result area, status, and the restored-session state
// all clear. History is deliberately KEPT (recall still works); tweak the
// goal with more detail and Generate again.
$("pbClear")?.addEventListener("click", () => {
  pbPreset = null;
  document.querySelectorAll("#pbChips .pb-chip, #pbSnAreas .pb-area").forEach((c) => c.classList.remove("active"));
  syncSnAreasRow();
  goalEl.value = "";
  goalEl.rows = 3; // undo a chip template's auto-grow
  outEl.value = "";
  resultWrap.hidden = true;
  $("pbRegen").hidden = true;
  setModelBadge("");
  pbAttachments.length = 0;
  renderFiles();
  updateCount();
  localStorage.removeItem(PB_LAST_KEY);
  statusEl.textContent = "Cleared — describe the goal again with more specifics (URLs, names, numbers), then Generate.";
  goalEl.focus();
});

$("menuPromptBuilder")?.addEventListener("click", openModal);
$("pbClose")?.addEventListener("click", closeModal);
overlay?.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && overlay?.classList.contains("open")) closeModal();
});

async function generate() {
  const goal = goalEl.value.trim();
  if (!goal) { statusEl.textContent = "Describe your goal first."; return; }
  genBtn.disabled = true;
  statusEl.textContent = pbAttachments.some((f) => f.kind === "image")
    ? "Describing attached image(s) with vision, then writing your prompt…"
    : "Writing your prompt… (a busy agent run finishes first)";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "build_prompt", goal, includePage: $("pbUsePage").checked, preset: pbPreset, snAreas: selectedSnAreas(), files: pbAttachments
    });
    if (res?.ok) {
      outEl.value = res.prompt;
      resultWrap.hidden = false;
      $("pbRegen").hidden = false;
      pushHistory(goal, res.prompt, res.model);
      saveSession();
      updateCount();
      setModelBadge(res.model);
      statusEl.textContent = "Done — edit freely, then insert, copy, or save.";
      outEl.focus();
    } else {
      statusEl.textContent = "Failed: " + (res?.error || "no response from background (reload the extension?)");
    }
  } catch (e) {
    statusEl.textContent = "Failed: " + e.message;
  } finally {
    genBtn.disabled = false;
  }
}
genBtn?.addEventListener("click", generate);
// Ctrl+Enter in the goal box = Generate.
goalEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
});

$("pbUse")?.addEventListener("click", () => {
  const input = $("input");
  if (!input) return;
  input.value = outEl.value.trim();
  // Fire the composer's own input listeners (auto-height, send-button state).
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeModal();
  input.focus();
});

$("pbCopy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(outEl.value.trim());
    statusEl.textContent = "Copied to clipboard.";
  } catch (e) {
    statusEl.textContent = "Copy failed: " + e.message;
  }
});

// The saved document (shared by ⬇ Download and 💾 Save to folder). Filename is
// slugged from the goal so saved prompts stay identifiable.
function buildPromptDoc() {
  const text = outEl.value.trim();
  if (!text) return null;
  const slug = (goalEl.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "prompt";
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
    "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
  const body = `# AI Prompt — ${goalEl.value.trim() || "Agent Go agent"}\n\n_Generated ${d.toLocaleString()} by the Local LLM Prompt Builder. Author: iDevOpsLLC_\n\n---\n\n${text}\n`;
  return { name: `ai-prompt-${slug}-${stamp}.md`, body };
}

$("pbDownload")?.addEventListener("click", () => {
  const doc = buildPromptDoc();
  if (!doc) { statusEl.textContent = "Nothing to download yet."; return; }
  const url = URL.createObjectURL(new Blob([doc.body], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  statusEl.textContent = `Downloaded ${doc.name}.`;
});

// 💾 Save to folder — writes the .md into a user-picked folder (File System
// Access, same lifecycle as the conversation log: granted once, persists in
// IndexedDB; after a Chrome restart the grant lapses and the next Save —
// a user gesture — re-grants it). 📂 picks/replaces the folder explicitly.
import("./fsaccess.js").then((fs) => {
  async function pickFolder() {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    await fs.savePromptFolderHandle(dir);
    statusEl.textContent = `Prompts will be saved into "${dir.name}".`;
    return dir;
  }
  async function saveToFolder() {
    const doc = buildPromptDoc();
    if (!doc) { statusEl.textContent = "Nothing to save yet."; return; }
    try {
      let dir = await fs.getPromptFolderHandle();
      if (dir && !(await fs.ensureReadWritePermission(dir))) dir = null; // grant lapsed and re-grant refused
      if (!dir) dir = await pickFolder();
      await fs.writeFileText(dir, doc.name, doc.body);
      statusEl.textContent = `Saved ${doc.name} into "${dir.name}".`;
    } catch (e) {
      if (e && e.name === "AbortError") { statusEl.textContent = "Folder selection cancelled."; return; }
      statusEl.textContent = "Save failed: " + (e.message || e);
    }
  }
  $("pbSaveFolder")?.addEventListener("click", saveToFolder);
  $("pbPickFolder")?.addEventListener("click", () => pickFolder().catch((e) => {
    if (e && e.name === "AbortError") return;
    statusEl.textContent = "Folder selection failed: " + (e.message || e);
  }));
});

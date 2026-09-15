// learning.js — Level-1 reinforcement: trajectories, feedback, distilled lessons.
// No weight updates — the model "learns" through an evolving, weighted rulebook
// injected into the system prompt, reinforced by 👍 and corrected by 👎.
// Author: iDevOpsLLC

import { chat } from "./ollama.js";
import { withRetry, logErr } from "./util.js";
import { withModelLock } from "./model-lock.js";

const MAX_TRAJECTORIES = 500; // also the future DPO training set
const MAX_LESSONS = 40;

// Baseline lessons seeded automatically (a 👎 isn't required to earn them).
// They carry hard-won rules the local model gets wrong out of the box. Seeding
// re-runs only when SEED_VERSION is bumped (i.e. when this list grows); within a
// version a user delete sticks. Bump SEED_VERSION whenever you add a seed below.
const SEED_VERSION = 25;
const SEED_LESSONS = [
  "Course/SCORM/iframe content: your DOM tools reach into ALL frames (query_elements merges every frame; click/fill/drag route to the owning frame — results may show a 'frame' number). Try query_elements FIRST for course checkboxes/radios/‹ › arrows. If a control you can SEE is STILL not found, that frame is sandboxed/canvas — don't tell the user to do it themselves; use desktop control (capture_screenshot to locate it, then desktop_click at its screen position — a real mouse click ignores iframe sandboxing). If desktop-server is off, tell the user to start it + enable Desktop control in Options.",
  "To click ICON-ONLY buttons with no text — accordion expand/collapse chevrons (▸/▾), pager prev/next arrows (‹ ›), close/menu icons — query_elements 'button, a, [role=button], [aria-expanded]' with text 'next'/'prev'/'expand'/'collapse'/'close': the filter matches the button's icon_hint (derived from its aria-label/title/icon class/SVG/glyph). Each result reports icon_hint and aria_expanded (false=collapsed→click to expand). Then click_element the handle. To page through a lesson, click the 'next' arrow repeatedly (watch the 'N/M' counter); it may be disabled on the last page.",
  "To change a video's speed (e.g. 'play at 2x', 'speed up the training video') use control_media {rate:2} — it sets the media element's playbackRate directly and works even when the player's speed menu is hidden/fragile. Don't fight the on-screen '2x' menu. To get a gated lesson video finished faster, control_media {rate:2, action:'play'} so it plays through (seeking to the end doesn't satisfy watch-completion tracking).",
  "You CAN do drag-and-drop: use drag_drop {source, target} with two query_elements handles (the item to drag, and the drop zone). Never say 'I cannot perform drag-and-drop' or 'my tools only click and type'. For a card-sorting / drag-into-category activity: query_elements to get each card + each drop zone, call drag_drop once per card into its zone, then read_page to verify and click Continue/Submit.",
  "Editing code in the connected folder: use search_files (regex) to FIND a symbol/string across files, and edit_file (exact snippet replace) for small changes — never rewrite a whole file with write_file to change a few lines. After changing code, if run_command is enabled RUN the tests/build (e.g. 'npm test') and report the real result before saying it's done. Use git via run_command (git status/diff/add/commit).",
  "For debugging/root-cause tasks: gather evidence BEFORE hypothesizing — read_console (the page's real JS errors), read_network (failed requests with status codes), sn_recent_changes (what changed on the instance right before it broke), syslog via sn_query_table. Tie every claimed cause to a captured evidence item; a cause you cannot evidence goes under 'unverified hypotheses', not in the verdict.",
  "To organize/tidy the connected local folder use create_folder + move_file: move_file moves or RENAMES any file or folder (PDFs/DOCX/PNGs included) and folders move with all contents. Never relocate a file by read_file + write_file, never leave the user a 'move these manually' checklist, and never claim binary files can't be moved.",
  "read_file also READS binary documents in the connected folder: PDF/DOCX/XLSX/PPTX/RTF text is extracted and images are described by the vision model. To summarize a PDF, Word doc, spreadsheet, or image, just read_file its path — never say you can't read it. Only a scanned image-only PDF fails (the error says so); then open it in a tab and capture_screenshot.",
  "In SPAs (LinkedIn messaging, Slack, ServiceNow lists) open a thread by click_element on the conversation's NAME link (the row's <a>, often href has /messaging/thread/), NOT the '⋮'/More/options button. Then read_page on the NEXT turn — the main pane updates asynchronously, so re-read once before assuming it didn't change. If an options/overflow menu opens and blocks you, press_key 'Escape' to close it, then click the name link.",
  "On ServiceNow NEVER guess the instance host: build every URL from the current tab's exact origin. Don't use dev99999.service-now.com or a bare service-now.com.",
  "ServiceNow: open UI Builder at <origin>/now/builder/ui/home (NOT ui_builder.do, which doesn't exist). For other apps with unknown URLs, click their navigator/All-menu link instead of guessing.",
  "Never refuse to type/click/send or claim you can't interact. To message someone use send_chat_message {recipient, message} — it targets the right composer and won't post to the wrong channel.",
  "Trust send_chat_message's sent flag, not page text — your unsent draft also shows in read_page. If sent:false the message is still in the box; click the send button. Never claim sent on sent:false.",
  "To delete messages CALL delete_chat_message {text}, one per message — it does the ⋮/Delete/confirm flow. Never say you 'cannot delete' or 'cannot access the UI'; never claim an unconfirmed delete.",
  "Chat apps FAST-PATH: to read/summarize/reply in Slack/Teams/Discord call read_chat_messages ONCE (conversation name + last messages + open composers in one result) — never get_tab_info/read_page/scroll_page a chat thread first. Then in the SAME turn draft_chat_message {message, recipient} to put a reply in the box WITHOUT sending (it never sends and auto-opens Teams' hidden compose box); use send_chat_message only when the user explicitly wants it sent.",
  "COMPOSE FOR THE RECIPIENT: 'Tell X / Let X know / Ask X ...' means the message goes TO X — rewrite it as a natural second-person message addressed to X ('I'm working on YOUR code reviews', never a verbatim 'her code reviews'), greeting + tone matched to the thread (read_chat_messages first when tone matters). send_chat_message always shows the exact text for the user's approval before sending, so the wording you compose is what gets judged. PLAIN TEXT ONLY: never add emojis/emoticons the user didn't write themselves. The same rule applies to GENERATED DOCUMENTS (create_document/write_file): professional deliverables are emoji-free — severity/status as plain labels (CRITICAL / HIGH / PASS / FAIL), never colored circles or icons, unless the user explicitly asked for emojis.",
  "PDF FAST-PATH: never read a PDF by scrolling its preview + capture_screenshot page after page (a 33-page doc took 45 screenshots — wrong). Email/web attachment: download or use the saved local copy, then ONE read_pdf {url: '<local path>'} call reads the WHOLE document (desktop-server PyMuPDF + Tesseract OCR for scanned pages). If read_file returns garbled PDF text, that same read_pdf local-path call is the recovery.",
  "run_command with python: embedded newlines inside python -c '...' silently produce EMPTY output on Windows (exit 0, no stdout — you learn nothing). Write python as a ONE-LINER with semicolons and -u (python -u -c \"import fitz; print(...)\"), or write a real .py file first and run that. If a command returns exit 0 with empty stdout, do NOT retry variants blindly — the quoting is broken; switch to the one-liner or file form.",
  "READ ONCE, THEN WORK: when read_pdf returns truncated:false (or its note says COMPLETE), you have the ENTIRE document in that one result — immediately write the findings you need into your reply notes and produce the deliverable. Do NOT re-call read_pdf on the same file, and do NOT re-dump pages via run_command python that you already received. If truncated:true, the message tells you the exact max_chars to re-call with — ONE follow-up call, not repeated same-cap retries.",
];

async function load(key, fallback) {
  try {
    const o = await chrome.storage.local.get(key);
    return o[key] ?? fallback;
  } catch {
    return fallback;
  }
}
async function store(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {}
}

// Seed the baseline lessons when the seed set is newer than what we last applied.
// addLesson() dedupes (re-adding a present lesson just reinforces its weight), so
// only genuinely new seeds appear; within a SEED_VERSION a user delete is honored.
async function ensureSeeded() {
  if ((await load("lessonsSeedVersion", 0)) >= SEED_VERSION) return;
  // Drop prior seed-sourced lessons so UPDATED seed text replaces the old wording
  // (addLesson's similarity dedupe would otherwise just reinforce stale text).
  // User-authored and 👎-distilled lessons (other sources) are left untouched.
  const existing = await load("lessons", []);
  const kept = existing.filter((l) => l.source !== "seed");
  if (kept.length !== existing.length) await store("lessons", kept);
  for (const text of SEED_LESSONS) await addLesson(text, "seed");
  await store("lessonsSeedVersion", SEED_VERSION);
}

export async function getLessons() {
  await ensureSeeded();
  return load("lessons", []);
}
export async function getTrajectories() {
  return load("trajectories", []);
}

// Pick the lessons most relevant to this task (keyword overlap + weight).
export function selectLessons(lessons, taskText, n = 8) {
  const words = new Set(String(taskText).toLowerCase().match(/[a-z]{4,}/g) || []);
  return lessons
    .map((l) => {
      const lw = l.text.toLowerCase().match(/[a-z]{4,}/g) || [];
      const overlap = lw.filter((w) => words.has(w)).length;
      return { l, score: overlap * 2 + (l.weight || 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.score > 0)
    .map((x) => x.l);
}

// Token-overlap similarity for dedupe.
function similar(a, b) {
  const ta = new Set(a.toLowerCase().match(/[a-z]{4,}/g) || []);
  const tb = new Set(b.toLowerCase().match(/[a-z]{4,}/g) || []);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size) > 0.7;
}

export async function addLesson(text, source) {
  text = String(text || "").trim().replace(/^[-*•\d.\s"']+|["']+$/g, "").slice(0, 200);
  if (!text || text.length < 10) return null;
  const lessons = await load("lessons", []); // raw read — avoid re-triggering ensureSeeded()
  const dup = lessons.find((l) => similar(l.text, text));
  if (dup) {
    dup.weight = (dup.weight || 1) + 1; // re-learning the same lesson = reinforce it
    await store("lessons", lessons);
    return dup;
  }
  const lesson = { id: crypto.randomUUID(), text, weight: 1, ts: Date.now(), source: source || "manual" };
  lessons.push(lesson);
  lessons.sort((a, b) => (b.weight || 1) - (a.weight || 1) || b.ts - a.ts);
  await store("lessons", lessons.slice(0, MAX_LESSONS));
  return lesson;
}

export async function deleteLesson(id) {
  const lessons = await getLessons();
  await store("lessons", lessons.filter((l) => l.id !== id));
}
export async function clearLessons() {
  await store("lessons", []);
}

const TRAJECTORY_TTL_DAYS = 30; // entries older than this are pruned on the next save

export async function saveTrajectory(traj) {
  await applyPendingStepFeedback(traj); // C.5: merge any mid-run per-step labels
  const all = await getTrajectories();
  all.push(traj);
  // Age out stale entries (TTL) BEFORE capping to the most-recent MAX, so the log
  // doesn't accumulate months-old runs that no longer reflect current behaviour.
  const cutoff = Date.now() - TRAJECTORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  const fresh = all.filter((t) => (t.ts || 0) >= cutoff);
  await store("trajectories", fresh.slice(-MAX_TRAJECTORIES));
}

// Manually prune trajectories older than `days` (default = the TTL). Returns a
// summary for the options UI. `days = 0` clears all trajectories.
export async function pruneTrajectories(days = TRAJECTORY_TTL_DAYS) {
  const all = await getTrajectories();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const fresh = days <= 0 ? [] : all.filter((t) => (t.ts || 0) >= cutoff);
  await store("trajectories", fresh);
  return { removed: all.length - fresh.length, remaining: fresh.length };
}

// ---------------------------------------------------------------------------
// C.7 — Local diagnostics. Pure, read-only aggregation over the trajectories
// already stored for the learning loop — NO new collection, NO network egress.
// Surfaces which tools fail most, run/step feedback, step-count distribution,
// and the most common errors, so systemic issues are visible.
// ---------------------------------------------------------------------------
export async function computeDiagnostics() {
  const trajs = await getTrajectories();
  const tools = {};        // name -> { calls, fails, denied }
  const errors = {};       // truncated message -> count
  const stepCounts = [];
  const runFeedback = { up: 0, down: 0, none: 0 };
  const stepFeedback = { up: 0, down: 0 };
  const autoScore = { positive: 0, zero: 0, negative: 0 };

  for (const t of trajs) {
    const steps = Array.isArray(t.steps) ? t.steps : [];
    stepCounts.push(steps.length);
    if (t.feedback > 0) runFeedback.up++; else if (t.feedback < 0) runFeedback.down++; else runFeedback.none++;
    if (t.autoScore > 0) autoScore.positive++; else if (t.autoScore < 0) autoScore.negative++; else autoScore.zero++;
    for (const s of steps) {
      const name = s.tool || "unknown";
      const rec = tools[name] || (tools[name] = { calls: 0, fails: 0, denied: 0 });
      rec.calls++;
      if (s.denied) rec.denied++;
      if (s.error) {
        rec.fails++;
        const key = String(s.error).slice(0, 80);
        errors[key] = (errors[key] || 0) + 1;
      }
      if (s.feedback > 0) stepFeedback.up++; else if (s.feedback < 0) stepFeedback.down++;
    }
  }

  const sorted = stepCounts.slice().sort((a, b) => a - b);
  const stepSummary = sorted.length
    ? { min: sorted[0], max: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)],
        avg: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10 }
    : null;

  return {
    runs: trajs.length,
    stepSummary,
    toolList: Object.entries(tools)
      .map(([name, r]) => ({ name, ...r, failRate: r.calls ? Math.round((r.fails / r.calls) * 100) : 0 }))
      .sort((a, b) => b.calls - a.calls),
    topErrors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 8),
    runFeedback,
    stepFeedback,
    autoScore
  };
}

// 👍 reinforces the lessons that guided the run; 👎 weakens them and
// distills a NEW lesson from the failure via the local model.
export async function recordFeedback(runId, value, settings) {
  const all = await getTrajectories();
  const traj = all.find((t) => t.id === runId);
  if (!traj) return { ok: false, error: "Run not found (pruned or pre-feedback build)." };
  traj.feedback = value;
  await store("trajectories", all);

  const lessons = await getLessons();
  if (value > 0) {
    let reinforced = 0;
    for (const id of traj.usedLessons || []) {
      const l = lessons.find((x) => x.id === id);
      if (l) {
        l.weight = (l.weight || 1) + 1;
        reinforced++;
      }
    }
    await store("lessons", lessons);
    return { ok: true, reinforced };
  }

  for (const id of traj.usedLessons || []) {
    const l = lessons.find((x) => x.id === id);
    if (l) l.weight = Math.max(0, (l.weight || 1) - 0.5);
  }
  await store("lessons", lessons);
  const lesson = await distillLesson(traj, settings);
  return { ok: true, lesson: lesson ? lesson.text : null };
}

// ---------------------------------------------------------------------------
// C.5 — Per-step feedback (mid-run). A 👍/👎 can arrive while a run is still in
// progress (before its trajectory is saved), so we both (a) distill a lesson
// immediately from a flagged-bad step, and (b) stash the label to be merged into
// the trajectory when it is saved — giving per-step preference data for export.
// ---------------------------------------------------------------------------
const MAX_PENDING_RUNS = 50; // bound the pending-label store

export async function recordStepFeedback({ runId, stepIndex, value, step }, settings) {
  let annotated = false;
  if (runId != null && Number.isInteger(stepIndex)) {
    const all = await getTrajectories();
    const traj = all.find((t) => t.id === runId);
    if (traj && Array.isArray(traj.steps) && traj.steps[stepIndex]) {
      traj.steps[stepIndex].feedback = value; // run already saved — annotate now
      await store("trajectories", all);
      annotated = true;
    } else {
      await stashStepFeedback(runId, stepIndex, value); // run in progress — merge on save
    }
  }
  // 👎 → distill one focused, general lesson from this single step right away.
  let lesson = null;
  if (value < 0 && step) lesson = await distillStepLesson(step, settings);
  return { ok: true, annotated, lesson: lesson ? lesson.text : null };
}

async function stashStepFeedback(runId, stepIndex, value) {
  const pending = await load("pendingStepFeedback", {});
  (pending[runId] || (pending[runId] = {}))[stepIndex] = value;
  const ids = Object.keys(pending);
  if (ids.length > MAX_PENDING_RUNS) {
    for (const id of ids.slice(0, ids.length - MAX_PENDING_RUNS)) delete pending[id];
  }
  await store("pendingStepFeedback", pending);
}

async function applyPendingStepFeedback(traj) {
  if (!traj || traj.id == null) return;
  const pending = await load("pendingStepFeedback", {});
  const fb = pending[traj.id];
  if (!fb) return;
  for (const [i, v] of Object.entries(fb)) {
    if (Array.isArray(traj.steps) && traj.steps[i]) traj.steps[i].feedback = v;
  }
  delete pending[traj.id];
  await store("pendingStepFeedback", pending);
}

async function distillStepLesson(step, settings) {
  const desc =
    `${step.name}(${JSON.stringify(step.args || {}).slice(0, 300)}) -> ` +
    `${JSON.stringify(step.result || {}).slice(0, 400)}`;
  const prompt = `You improve a browser automation agent. The user marked THIS SINGLE STEP as bad:

${desc}

Write ONE short imperative lesson (max 140 characters) to avoid this mistake next time. Make it concrete but GENERAL (not tied to this exact page/record/handle). Output ONLY the lesson text.`;
  try {
    // A 👎 during a concurrent fan-out fires this distill mid-run; route it through
    // the model lock so it queues behind in-flight child inference (C.6 Phase 2).
    const msg = await withRetry(
      () => withModelLock(() => chat({
        base: settings.ollamaBase,
        model: settings.model,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.3 }
      })),
      { label: "distill step lesson" }
    );
    const text = (msg.content || "").trim().split("\n")[0];
    return await addLesson(text, "step-distilled");
  } catch (e) {
    logErr("distillStepLesson failed", e);
    return null;
  }
}

// Turn a bad trajectory into one short, general, imperative rule.
export async function distillLesson(traj, settings) {
  const steps = (traj.steps || [])
    .map((s) => `${s.denied ? "USER-DENIED " : ""}${s.tool}(${s.args || ""}) -> ${s.error ? "ERROR: " + s.error : s.verified === false ? "NOT VERIFIED" : "ok"}`)
    .join("\n")
    .slice(0, 3000);
  const prompt = `You improve a browser automation agent. The user rated this run BAD.

TASK: ${traj.task}
STEPS:
${steps}
FINAL ANSWER (truncated): ${traj.finalText || ""}

Write ONE short imperative lesson (max 140 characters) the agent should follow next time to avoid this failure. Make it concrete but GENERAL (not tied to this exact record or page). Output ONLY the lesson text.`;
  try {
    const msg = await withRetry(
      () => withModelLock(() => chat({
        base: settings.ollamaBase,
        model: settings.model,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.3 }
      })),
      { label: "distill lesson" }
    );
    const text = (msg.content || "").trim().split("\n")[0];
    return await addLesson(text, "auto-distilled");
  } catch (e) {
    logErr("distillLesson failed (feedback recorded, but no new lesson was created)", e);
    return null;
  }
}

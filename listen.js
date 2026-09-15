// listen.js — voice input (mic dictation) + live meeting/conversation listening
// for the Local LLM side panel. Audio goes ONLY to the local Whisper server
// (settings.whisperUrl, whisper-server/server.py); nothing is uploaded.
// Author: iDevOpsLLC
//
// Two features:
//  1) Dictation (🎤) — record the mic into the prompt box. Whisper primary;
//     falls back to Chrome's Web Speech API (cloud) if the server is down.
//  2) Meeting listen (🎧) — continuously captures the ACTIVE TAB's audio
//     (Teams / Meet / Zoom web) and/or the microphone (in-room voices),
//     transcribes in short chunks via Whisper, keeps a rolling timestamped
//     transcript, and can ACTIVELY PARTICIPATE: a trigger phrase (or a
//     trailing question when no trigger is set) starts an agent run with the
//     recent transcript as context. Replies can be spoken aloud (TTS) and the
//     agent may post into the meeting chat via send_chat_message — which keeps
//     its existing approval gating, so participation obeys the current mode.
//
// Recording gotcha: MediaRecorder timeslice chunks after the first are NOT
// self-contained webm files (no container headers), so we CYCLE the recorder
// (stop → full blob → restart) each chunk; every blob then decodes standalone.

import { getSettings } from "./settings.js";

const CHUNK_MS = 12000;        // per-chunk record length (latency vs. Whisper call rate)
const MIN_BLOB_BYTES = 4500;   // below this it's essentially silence — skip the round-trip
const TRANSCRIPT_MAX_LINES = 400;
const CONTEXT_MAX_CHARS = 3000; // transcript tail attached to prompts (local-model numCtx budget)

let cb = null;                 // { run, bubble, isBusy, inputEl } injected by sidepanel.js
let suppressCtxOnce = false;   // participation prompts already embed the transcript

// ---------- shared helpers ----------

function pickMime() {
  try {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  } catch {}
  return "audio/webm";
}

async function whisperHealthy(base) {
  try {
    const res = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function whisperTranscribe(base, blob) {
  const fd = new FormData();
  fd.append("audio", blob, "chunk.webm");
  const res = await fetch(base + "/transcribe", { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("Whisper HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return String(j.text || "").trim();
}

// Mic access. In a side panel Chrome sometimes rejects getUserMedia without
// ever showing the permission prompt — if so, open a normal extension tab
// (mic-permission.html) where the prompt CAN render, then have the user retry.
async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
      try { await chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") }); } catch {}
      throw new Error("Microphone permission needed — grant it in the tab that just opened, then click the mic again.");
    }
    throw e;
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

function stripForSpeech(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*#_>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- 1) Dictation (mic → prompt box) ----------
// LIVE: the recorder is cycled every few seconds (same trick as the meeting
// listener), so each slice transcribes while you keep talking and the text
// streams into the prompt box continuously — no need to stop first.

const DICT_CHUNK_MS = 5000;

const dict = { recording: false, rec: null, stream: null, timer: null, queue: null, webSpeech: null, btn: null };

function setMicUi(on, title) {
  if (!dict.btn) return;
  dict.btn.classList.toggle("recording", on);
  dict.btn.title = title || (on ? "Recording — click to stop and transcribe" : "Voice input — dictate into the prompt (local Whisper)");
}

function insertDictation(text) {
  if (!text) return;
  const el = cb.inputEl;
  el.value = (el.value ? el.value.replace(/\s+$/, "") + " " : "") + text;
  el.dispatchEvent(new Event("input")); // re-run autoGrow / clear-button wiring
  el.scrollTop = el.scrollHeight;       // keep the newest dictated words in view
  el.focus();
}

async function startDictation() {
  const s = await getSettings();
  if (await whisperHealthy(s.whisperUrl)) {
    const stream = await getMicStream();
    dict.stream = stream;
    dict.recording = true;
    dict.queue = Promise.resolve(); // serializes inserts so slices land in spoken order
    setMicUi(true);
    dictCycle(s.whisperUrl, stream);
    return;
  }
  // Whisper down → live Web Speech fallback (cloud — Chrome's own dictation).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    cb.bubble("msg error", "⚠ Whisper server is not reachable and this browser has no Web Speech API. Start it with whisper-server\\start-whisper.bat.");
    return;
  }
  const r = new SR();
  r.continuous = true;
  r.interimResults = false;
  r.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) insertDictation(ev.results[i][0].transcript.trim());
    }
  };
  r.onerror = (ev) => {
    if (ev.error === "not-allowed") {
      // Same side-panel prompt problem as getUserMedia — grant it in a real tab.
      cb.bubble("msg error", "⚠ Microphone permission needed — grant it in the tab that just opened, then click the mic again.");
      try { chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") }); } catch {}
    }
    stopDictation();
  };
  r.onend = () => { if (dict.webSpeech === r) { dict.webSpeech = null; dict.recording = false; setMicUi(false); } };
  dict.webSpeech = r;
  dict.recording = true;
  setMicUi(true, "Recording (Web Speech fallback — cloud) — click to stop");
  r.start();
}

// One live-dictation cycle: record a short slice, restart immediately, and
// transcribe the finished slice in the background → prompt box.
function dictCycle(base, stream) {
  const rec = new MediaRecorder(stream, { mimeType: pickMime() });
  dict.rec = rec;
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    const more = dict.recording;
    if (more) dictCycle(base, stream);
    const blob = new Blob(parts, { type: rec.mimeType });
    if (blob.size < MIN_BLOB_BYTES) { if (!more) finishDictation(); return; } // silent slice
    dict.queue = dict.queue.then(async () => {
      try {
        const text = await whisperTranscribe(base, blob);
        insertDictation(text);
      } catch (e) {
        cb.bubble("msg error", "⚠ Dictation failed: " + (e.message || e));
      }
      if (!more) finishDictation(); // last slice done → release the mic
    });
  };
  rec.start();
  dict.timer = setTimeout(() => { try { if (rec.state !== "inactive") rec.stop(); } catch {} }, DICT_CHUNK_MS);
}

function finishDictation() {
  if (dict.stream) { dict.stream.getTracks().forEach((t) => t.stop()); dict.stream = null; }
  setMicUi(false);
}

function stopDictation() {
  const hadRecorder = dict.rec && dict.rec.state !== "inactive";
  dict.recording = false;
  if (dict.timer) { clearTimeout(dict.timer); dict.timer = null; }
  if (hadRecorder) { try { dict.rec.stop(); } catch {} } // the in-flight slice still transcribes, then finishDictation() releases the mic
  dict.rec = null;
  if (dict.webSpeech) { try { dict.webSpeech.stop(); } catch {} dict.webSpeech = null; setMicUi(false); }
  if (!hadRecorder) finishDictation();
}

async function toggleDictation() {
  if (dict.recording) { stopDictation(); return; }
  try { await startDictation(); } catch (e) {
    setMicUi(false);
    cb.bubble("msg error", "⚠ " + (e.message || e));
  }
}

// ---------- 2) Meeting / conversation listener ----------

const listen = {
  active: false,
  sources: [],      // [{ label, stream, rec, timer }]
  audioCtx: null,
  transcript: [],   // ["[hh:mm] [Meeting] …", …]
  card: null, pre: null,
  whisperUrl: "",
  startedAt: 0,
  queued: null,     // participation request deferred while the agent was busy
  prefs: { participate: false, speak: false, trigger: "hey assistant", rate: 1 },
};

export function isListening() { return listen.active; }

// Transcript tail appended to user prompts sent while listening, so "what did
// they just decide?" works without any extra step.
export function getListenContext() {
  if (suppressCtxOnce) { suppressCtxOnce = false; return ""; }
  if (!listen.active || !listen.transcript.length) return "";
  return "\n\n[LIVE MEETING TRANSCRIPT — most recent first-hand context, captured locally]\n" + transcriptTail();
}

function transcriptTail() {
  let out = [];
  let total = 0;
  for (let i = listen.transcript.length - 1; i >= 0; i--) {
    const line = listen.transcript[i];
    total += line.length + 1;
    if (total > CONTEXT_MAX_CHARS) break;
    out.push(line);
  }
  return out.reverse().join("\n");
}

// Speak the agent's final reply out loud (participation in the room). Only
// while listening and only when the strip's "speak replies" toggle is on.
export function maybeSpeak(text) {
  if (!listen.active || !listen.prefs.speak) return;
  const clean = stripForSpeech(text).slice(0, 1200);
  if (!clean) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    // Web Speech accepts rate 0.1–10; clamp to the strip's 0.5–2 range.
    const r = Number(listen.prefs.rate);
    u.rate = Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1;
    speechSynthesis.speak(u);
  } catch {}
}

function savePrefs() {
  try { chrome.storage.local.set({ listenPrefs: listen.prefs }); } catch {}
}
async function loadPrefs() {
  try {
    const { listenPrefs } = await chrome.storage.local.get("listenPrefs");
    if (listenPrefs && typeof listenPrefs === "object") Object.assign(listen.prefs, listenPrefs);
  } catch {}
}

function appendLine(label, text) {
  const line = "[" + stamp() + "] [" + label + "] " + text;
  listen.transcript.push(line);
  if (listen.transcript.length > TRANSCRIPT_MAX_LINES) listen.transcript.splice(0, listen.transcript.length - TRANSCRIPT_MAX_LINES);
  if (listen.pre) {
    listen.pre.textContent += (listen.pre.textContent ? "\n" : "") + line;
    listen.pre.scrollTop = listen.pre.scrollHeight;
  }
}

// One recorder cycle for one source: record CHUNK_MS, stop for a complete webm
// blob, immediately start the next cycle, transcribe this blob in parallel.
function startCycle(src) {
  if (!listen.active) return;
  const rec = new MediaRecorder(src.stream, { mimeType: pickMime() });
  src.rec = rec;
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = async () => {
    if (listen.active) startCycle(src);
    const blob = new Blob(parts, { type: rec.mimeType });
    if (blob.size < MIN_BLOB_BYTES) return; // silence
    try {
      const text = await whisperTranscribe(listen.whisperUrl, blob);
      if (text) onChunkText(src.label, text);
    } catch (e) {
      appendLine("system", "⚠ transcription failed: " + (e.message || e));
    }
  };
  rec.start();
  src.timer = setTimeout(() => { try { if (rec.state !== "inactive") rec.stop(); } catch {} }, CHUNK_MS);
}

function onChunkText(label, text) {
  appendLine(label, text);
  // Deferred participation first: the agent was busy when the trigger fired.
  if (listen.queued && !cb.isBusy()) {
    const latest = listen.queued;
    listen.queued = null;
    launchParticipation(latest);
    return;
  }
  if (!listen.prefs.participate) return;
  const trig = String(listen.prefs.trigger || "").trim().toLowerCase();
  // With a trigger phrase: respond when addressed. Without one: respond to a
  // chunk that ends in a direct question.
  const hit = trig ? text.toLowerCase().includes(trig) : /\?\s*$/.test(text.trim());
  if (!hit) return;
  if (cb.isBusy()) { listen.queued = text; appendLine("system", "⏳ trigger heard — waiting for the current run to finish"); return; }
  launchParticipation(text);
}

function launchParticipation(latest) {
  const prompt =
    "You are LISTENING to a live meeting/conversation (local transcription). " +
    "You were just addressed or a question was raised. Recent transcript (oldest → newest):\n\n" +
    transcriptTail() +
    "\n\nLatest: \"" + latest + "\"\n\n" +
    "Respond with ONE short, helpful, meeting-appropriate contribution (answer the question, or add the key point). " +
    "If the active tab has this meeting's chat composer, you may post your reply there with send_chat_message; " +
    "otherwise just reply here. Do not repeat the transcript back.";
  suppressCtxOnce = true; // the prompt already carries the transcript
  cb.run(prompt);
}

// Meeting audio, two-stage. tabCapture is seamless (no picker) but Chrome only
// allows it on a tab the extension was INVOKED on (toolbar click / Ctrl+Shift+L
// on that tab) — clicks inside the side panel don't count. When it refuses (or
// the active tab is a chrome:// page), fall back to the standard share picker:
// pick the meeting tab + "Also share tab audio", or "Entire screen" + "Share
// system audio" — which also hears NATIVE apps (Teams/Zoom desktop).
async function captureMeetingAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chromePage = !tab || /^(chrome|edge|devtools|about|chrome-extension):/.test(tab.url || "");
  if (!chromePage) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: false,
      });
      // tabCapture mutes the tab for the user — route it back to the speakers.
      listen.audioCtx = new AudioContext();
      listen.audioCtx.createMediaStreamSource(stream).connect(listen.audioCtx.destination);
      return { label: "Meeting", stream, rec: null, timer: null };
    } catch (e) {
      if (!/invoked|activeTab/i.test(String((e && e.message) || e))) throw e;
      // fall through to the picker
    }
  }
  cb.bubble("msg note", "In the picker: choose the MEETING TAB and tick “Also share tab audio” — or “Entire screen” + “Share system audio” to hear a native app (Teams/Zoom desktop). The video is discarded; only audio is used, locally.");
  const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  disp.getVideoTracks().forEach((t) => t.stop()); // audio-only listener
  const audio = disp.getAudioTracks();
  if (!audio.length) {
    disp.getTracks().forEach((t) => t.stop());
    throw new Error("No audio was shared — try again and tick the “share audio” checkbox in the picker.");
  }
  // Chrome's "Stop sharing" bar ends the track — treat it as Stop.
  audio[0].addEventListener("ended", () => { if (listen.active) stopListening(); });
  return { label: "Meeting", stream: new MediaStream(audio), rec: null, timer: null };
}

// One de-duplicated "Whisper unreachable" notice. The health check runs on every
// listen/dictation start, so rapid clicks (or a menu pick fired repeatedly) otherwise
// stack identical error bubbles — the 4× duplicate the user saw. Suppresses repeats
// within 6s and NEVER prints "undefined" (falls back to a "not configured" hint).
let _lastWhisperErrAt = 0;
function whisperUnreachable(feature, url) {
  const now = Date.now();
  if (now - _lastWhisperErrAt < 6000) return;   // dedupe burst of identical errors
  _lastWhisperErrAt = now;
  const u = (url || "").trim();
  const where = u ? `at ${u}` : "(not configured — set it in Settings)";
  cb.bubble("msg error", `⚠ ${feature} needs the local Whisper server ${where}. Start it with whisper-server\\start-whisper.bat, then try again.`);
}

async function startListening(kind) {
  if (listen.active) return;
  const s = await getSettings();
  listen.whisperUrl = s.whisperUrl;
  // Continuous transcription NEEDS the local server (Web Speech can't read tab audio).
  if (!(await whisperHealthy(s.whisperUrl))) {
    whisperUnreachable("The meeting listener", s.whisperUrl);
    return;
  }

  const sources = [];
  try {
    if (kind === "tab" || kind === "both") {
      sources.push(await captureMeetingAudio());
    }
    if (kind === "mic" || kind === "both") {
      const stream = await getMicStream();
      sources.push({ label: "Mic", stream, rec: null, timer: null });
    }
  } catch (e) {
    sources.forEach((x) => x.stream.getTracks().forEach((t) => t.stop()));
    if (listen.audioCtx) { try { listen.audioCtx.close(); } catch {} listen.audioCtx = null; }
    cb.bubble("msg error", "⚠ Could not start listening: " + (e.message || e));
    return;
  }

  listen.active = true;
  listen.sources = sources;
  listen.transcript = [];
  listen.queued = null;
  listen.startedAt = Date.now();

  // Live transcript card in the log.
  const d = document.createElement("div");
  d.className = "tool ok";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "🎧 listening (" + sources.map((x) => x.label).join(" + ") + ") — live transcript · audio stays local (Whisper)";
  const pre = document.createElement("pre");
  pre.style.maxHeight = "180px";
  d.appendChild(name);
  d.appendChild(pre);
  listen.card = d;
  listen.pre = pre;
  cb.bubble("msg note", "🎧 Listening started. Heads-up: make sure meeting participants are aware/consent to the assistant listening.");
  const logEl = document.getElementById("log");
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;

  updateStrip(true);
  sources.forEach(startCycle);
}

export function stopListening() {
  if (!listen.active) return;
  listen.active = false;
  for (const src of listen.sources) {
    if (src.timer) clearTimeout(src.timer);
    if (src.rec && src.rec.state !== "inactive") { try { src.rec.stop(); } catch {} } // final blob still transcribes
    src.stream.getTracks().forEach((t) => t.stop());
  }
  listen.sources = [];
  if (listen.audioCtx) { try { listen.audioCtx.close(); } catch {} listen.audioCtx = null; }
  try { speechSynthesis.cancel(); } catch {}
  if (listen.card) {
    const mins = Math.max(1, Math.round((Date.now() - listen.startedAt) / 60000));
    const n = document.createElement("div");
    n.className = "approval-done";
    n.textContent = "⏹ stopped after ~" + mins + " min · " + listen.transcript.length + " transcript lines (ask about it any time this session)";
    listen.card.appendChild(n);
  }
  listen.card = null;
  listen.pre = null;
  updateStrip(false);
}

// ---------- strip + button wiring ----------

let stripEls = null;

function updateStrip(on) {
  if (!stripEls) return;
  stripEls.strip.hidden = !on;
  stripEls.listenBtn.classList.toggle("recording", on);
  stripEls.listenBtn.title = on
    ? "Listening — click to stop"
    : "Listen to a meeting or conversation — live transcript + active participation";
  if (on) stripEls.label.textContent = "Listening (" + listen.sources.map((x) => x.label).join(" + ") + ")";
}

export async function initListen(callbacks) {
  cb = callbacks;
  await loadPrefs();

  dict.btn = document.getElementById("mic");
  dict.btn.addEventListener("click", toggleDictation);

  const listenBtn = document.getElementById("listenBtn");
  const menu = document.getElementById("listenMenu");
  listenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (listen.active) { stopListening(); return; }
    menu.classList.toggle("open");
  });
  document.addEventListener("click", () => menu.classList.remove("open"));
  const pick = (kind) => { menu.classList.remove("open"); startListening(kind); };
  document.getElementById("listenTab").addEventListener("click", () => pick("tab"));
  document.getElementById("listenMic").addEventListener("click", () => pick("mic"));
  document.getElementById("listenBoth").addEventListener("click", () => pick("both"));

  stripEls = {
    strip: document.getElementById("listenStrip"),
    label: document.getElementById("listenLabel"),
    listenBtn,
  };
  const part = document.getElementById("lsParticipate");
  const speak = document.getElementById("lsSpeak");
  const rate = document.getElementById("lsRate");
  const trig = document.getElementById("lsTrigger");
  part.checked = !!listen.prefs.participate;
  speak.checked = !!listen.prefs.speak;
  if (rate) rate.value = String(listen.prefs.rate || 1);
  trig.value = listen.prefs.trigger || "";
  part.addEventListener("change", () => { listen.prefs.participate = part.checked; savePrefs(); });
  speak.addEventListener("change", () => { listen.prefs.speak = speak.checked; savePrefs(); });
  if (rate) rate.addEventListener("change", () => {
    const r = parseFloat(rate.value);
    listen.prefs.rate = Number.isFinite(r) ? r : 1;
    savePrefs();
    // Speak a short confirmation at the new speed so the change is audible immediately.
    if (listen.prefs.speak) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance("Speed " + rate.value + "x"); u.rate = Math.min(2, Math.max(0.5, listen.prefs.rate)); speechSynthesis.speak(u); } catch {} }
  });
  document.getElementById("lsStop").addEventListener("click", stopListening);

  // Don't leave capture streams dangling if the panel closes mid-meeting.
  window.addEventListener("pagehide", () => { stopListening(); stopDictation(); });
}

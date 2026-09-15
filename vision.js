// vision.js — capture the visible tab and describe it with a local vision model.
// This is how the coder agent "sees" the page (qwen3-coder has no vision itself).
// Author: iDevOpsLLC

import { chat } from "./ollama.js";
import { describe as cloudDescribe } from "./provider.js";
import { withRetry } from "./util.js";
import { withModelLock } from "./model-lock.js";
import { acquireKeyedSlot } from "./concurrency.js";

// When a cloud provider is active, send the image straight to that (natively
// multimodal) model instead of the separate local vision model. Returns the
// describe result, or null when the local Ollama path should be used. Cloud
// errors are turned into the same helpful shape as local vision errors.
async function tryCloudDescribe({ settings, prompt, base64, signal }) {
  let res;
  try {
    res = await cloudDescribe({ settings, prompt, base64, signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return { error: `Cloud vision (${settings.provider}) error: ${String(e.message || e)}` };
  }
  if (!res) return null; // local provider — caller uses the Ollama vision model
  return { description: res.content, vision_model: res.vision_model };
}

// Global guard for the activate→capture→restore critical section below.
// captureVisibleTab is a shared resource (it grabs the ACTIVE tab of a window), so
// two concurrent sub-agents screenshotting different background tabs in the same
// window would otherwise clobber each other's activation. One fixed key serializes
// every screenshot; capture is quick, so global serialization costs nothing real.
const captureGuard = new Map();

// Capture the visible area of `tab`. When `tab` is a BACKGROUND tab (e.g. a
// sub-agent bound to a non-active tab), captureVisibleTab would grab whatever the
// user is actually looking at — so we briefly activate the bound tab, capture, then
// restore whichever tab was active. When `tab` is already active (or omitted, the
// top-level agent's case) we capture directly with no visible side effect.
async function captureTab(tab) {
  if (!tab || tab.id == null) {
    return chrome.tabs.captureVisibleTab({ format: "png" }); // legacy: OS-visible active tab
  }
  const windowId = tab.windowId;
  if (tab.active) {
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" }); // already front-most
  }
  const release = await acquireKeyedSlot(captureGuard, "capture");
  let prevActiveId = null;
  try {
    const [prev] = await chrome.tabs.query({ active: true, windowId });
    prevActiveId = prev ? prev.id : null;
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 120)); // let the tab paint before capturing
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } finally {
    // Best-effort restore so the user is left on the tab they had focused.
    if (prevActiveId != null && prevActiveId !== tab.id) {
      try { await chrome.tabs.update(prevActiveId, { active: true }); } catch {}
    }
    release();
  }
}

// Turn a raw vision-model error into a helpful message. A missing model is the
// most common cause and is NOT retried (it won't self-heal), so tell the user
// exactly how to fix it instead of leaving a cryptic "no such model".
function visionError(model, e) {
  const m = String(e?.message || e);
  if (/not found|no such model|try pulling|unknown model/i.test(m)) {
    return { error: `Vision model "${model}" is not installed. Run "ollama pull ${model}" (or pick an installed vision model in Settings). Until then, use read_page for text instead of screenshots.` };
  }
  if (e?.name === "TimeoutError" || /timed?\s?out/i.test(m)) {
    return { error: `Vision (${model}) timed out after ${VISION_TIMEOUT_MS / 1000}s — usually the GPU is full (another big model resident) and the vision model is stuck loading. Try again, use read_page instead of a screenshot, or free VRAM (ollama ps / ollama stop <model>).` };
  }
  return { error: `Vision model (${model}) error: ${m}` };
}

// Hard watchdog on every vision call. Without it, a stuck Ollama load (e.g. GPU
// crammed by a 32B model, so the vision model can't fit) hangs the whole run
// with nothing but "thinking…" — the 2026-07-09 freeze. Long enough for a cold
// vision-model load (~20s) + slow inference; a hang errors out instead.
const VISION_TIMEOUT_MS = 120000;

// One vision chat call, retried on transient Ollama hiccups (5xx / network).
function describeWith({ base, model, prompt, base64, signal }) {
  const watchdog = AbortSignal.timeout(VISION_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, watchdog]) : watchdog;
  // withModelLock INSIDE withRetry so the GPU lock is acquired fresh per attempt
  // and never held across the retry backoff sleep (C.6 Phase 2).
  return withRetry(
    () => withModelLock(() => chat({
      base,
      model,
      messages: [{ role: "user", content: prompt, images: [base64] }],
      // num_ctx MUST be capped here: with no explicit value Ollama allocates the
      // model's NATIVE context — qwen3-vl:8b is 262144, turning an 8GB model
      // into a 46GB allocation (53% CPU-offloaded, evicts the agent model,
      // glacial screenshots — observed 2026-07-09). 8192 fits image + prompt.
      options: { temperature: 0.2, num_ctx: 8192 },
      signal: combined
    })),
    { signal: combined, label: "vision describe" }
  );
}

// Downscale big captures before vision. Full-page PNGs on a hi-DPI monitor are
// several MB; vision cost scales with pixels, so ~1440px wide cuts image tokens
// ~4x while UI text stays readable for qwen2.5vl. Any decode failure returns
// the original untouched.
const MAX_VISION_WIDTH = 1440;
async function shrinkForVision(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    if (bmp.width <= MAX_VISION_WIDTH) { bmp.close(); return dataUrl; }
    const h = Math.round((bmp.height * MAX_VISION_WIDTH) / bmp.width);
    const canvas = new OffscreenCanvas(MAX_VISION_WIDTH, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, MAX_VISION_WIDTH, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return "data:image/jpeg;base64," + btoa(bin);
  } catch { return dataUrl; }
}

// Describe an arbitrary base64 image with the local vision model.
export async function describeImage({ base64, focus, settings, signal }) {
  const prompt = focus
    ? `The user attached this image. Analyze it with respect to: ${focus}. Describe everything relevant — visible text, numbers, UI elements, charts, layout. Be specific and complete.`
    : `Describe this image in detail: visible text, numbers, UI elements, charts, people/objects, and layout.`;
  const cloud = await tryCloudDescribe({ settings, prompt, base64, signal });
  if (cloud) return cloud;
  try {
    const msg = await describeWith({ base: settings.ollamaBase, model: settings.visionModel, prompt, base64, signal });
    return { description: msg.content, vision_model: settings.visionModel };
  } catch (e) {
    return visionError(settings.visionModel, e);
  }
}

export async function captureAndDescribe({ focus, settings, signal, tab }) {
  let dataUrl;
  try {
    // Requires host permission for the tab; returns a PNG data URL. `tab` (the
    // sub-agent's bound tab) is activated around the capture when it's in the
    // background; omitted/active tabs capture directly.
    dataUrl = await captureTab(tab);
  } catch (e) {
    return { error: `Screenshot failed: ${e.message}. (Restricted pages like chrome:// can't be captured.)` };
  }

  const base64 = ((await shrinkForVision(dataUrl)) || "").split(",")[1];
  if (!base64) return { error: "Screenshot produced no image data." };

  const prompt = focus
    ? `This is a screenshot of a web page. Focus on: ${focus}. Describe what you see relevant to that — visible text, buttons, links, fields, and layout. Be specific and concise.`
    : `This is a screenshot of a web page. Describe it concisely: main visible text, buttons, links, form fields, and overall layout/state.`;

  const cloud = await tryCloudDescribe({ settings, prompt, base64, signal });
  if (cloud) return cloud;
  try {
    const msg = await describeWith({ base: settings.ollamaBase, model: settings.visionModel, prompt, base64, signal });
    return { description: msg.content, vision_model: settings.visionModel };
  } catch (e) {
    return visionError(settings.visionModel, e);
  }
}

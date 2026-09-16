// First-run setup (design refresh 2026-09-14). Four steps that set only settings the extension
// already has (agent model, autonomy mode, auto web-search, and desktop control in Private) and
// hand a starter prompt to the side panel's message box. Nothing here sends a message or runs
// the agent. background.js opens this page once, on a fresh install; the same file ships in
// Agent Go and Agent Go Private, and <html data-product> picks the copy.
// Author: iDevOpsLLC
import { getSettings, saveSettings } from "./settings.js";

const PRODUCT = document.documentElement.dataset.product === "go" ? "go" : "private";
const NAME = PRODUCT === "go" ? "Agent Go" : "Agent Go Private";
const $ = (id) => document.getElementById(id);
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const SHARED_STEPS = [
  { title: "Set the ground rules", body: "Defaults are conservative. You can switch the mode per conversation from the side panel." },
  { title: "Try it on this page", body: "Pick one and it lands in the side panel's message box. Switch to the tab you want help with, then press send. Stop ends a run at any point." }
];
const STEPS = {
  private: [
    { title: "Nothing leaves this computer unless you say so", body: "Agent Go Private runs in your browser against a model on your own machine. Cloud providers stay off until you add one in Settings." },
    { title: "Choose the brain", body: "These are the models installed in Ollama on this computer. You can change this any time in Settings." },
    ...SHARED_STEPS
  ],
  go: [
    { title: "An agent that works in the tab you are on", body: "Agent Go reads the page you ask about and runs the model in the Agent Go cloud. Sign in with your Agent Go account to use your plan." },
    { title: "Choose the brain", body: "Auto runs Kimi K3 where your plan includes it, and GLM 5.2 on Free and Starter. You can change this any time in Settings." },
    ...SHARED_STEPS
  ]
};
const PROMISES = {
  private: [
    ["⌂", "Runs on your hardware", "Ollama on this computer. No account needed."],
    ["⊘", "Cloud is opt-in", "Nothing goes to a cloud provider until you add one."],
    ["▤", "No telemetry", "Diagnostics stay local. The optional version check fetches one static file."]
  ],
  go: [
    ["✓", "You approve actions", "Plan first is the default. Nothing happens until you OK the plan."],
    ["■", "Stop at any point", "Stop halts a run mid-step."],
    ["→", "Sign in once", "Your account and plan live in Settings."]
  ]
};
const MODES = [
  ["plan", "Plan first", "Drafts a step-by-step plan and waits for your approval before doing anything."],
  ["ask", "Ask before acting", "Pauses for your approval before clicking, typing, navigating, or editing code."],
  ["auto", "Act without asking", "Works without pausing for approval. Stop still halts it."],
  ["readonly", "Read-only", "Review and analysis only. Every write tool is removed."]
];
const TRY = [
  ["ask", "Summarize this page"],
  ["◎", "Screenshot this page and read the chart"],
  ["click", "Find the login button and click it"]
];

let step = 0;
let renderSeq = 0;
let windowId = null;
try { chrome.windows.getCurrent().then((w) => { windowId = w && w.id; }).catch(() => {}); } catch (_e) { /* no windows API */ }

function say(text) { $("obStatus").textContent = text || ""; }

// Writes go one at a time, each on top of the freshest stored settings. Finish and Skip wait for the
// queue, and a failed write keeps the page open with its error.
let writeChain = Promise.resolve();
let writeFailed = null;
function track(work) {
  writeChain = writeChain
    .then(work)
    .then(() => { say("Saved."); }, (e) => { writeFailed = e; say("Could not save: " + ((e && e.message) || e)); });
  return writeChain;
}
function patchSettings(partial) {
  return track(async () => {
    const cur = await getSettings();
    delete cur.byokApiKey; // Agent Go: never touch the machine-local BYOK key from this page
    await saveSettings({ ...cur, ...partial });
  });
}

// Mirrors functions/src/modules/llm-go/model-allowlist.js; the server still decides. Free and Starter
// get the included models only; every other signed-in plan gets the whole catalog.
const PLAN_INCLUDED = new Set(["glm-5.2:cloud", "glm-5.3-flash", "gemma4:31b"]);
function planAllows(tier, model) {
  if (!model) return true;
  if (!tier || tier === "free" || tier === "starter") return PLAN_INCLUDED.has(model);
  return true;
}

function openSettings() { chrome.runtime.openOptionsPage().catch(() => {}); }

function button(cls, text, onClick) {
  const b = h("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function choiceList(items, current, onPick, scroll) {
  const list = h("div", scroll ? "ob-list scroll" : "ob-list");
  list.setAttribute("role", "radiogroup");
  const buttons = items.map((it) => {
    const b = h("button", "ob-choice");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(it.value === current));
    if (it.disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
    const text = h("span", "ob-text");
    text.append(h("span", it.mono ? "ob-name ob-mono" : "ob-name", it.name));
    if (it.desc) text.append(h("span", "ob-sub", it.desc));
    b.append(h("span", "ob-radio"), text);
    if (it.meta) b.append(h("span", "ob-meta", it.meta));
    b.addEventListener("click", () => {
      for (const x of buttons) x.setAttribute("aria-checked", String(x === b));
      onPick(it.value);
    });
    return b;
  });
  list.append(...buttons);
  return list;
}

function switchRow(name, hint, on, onToggle) {
  const row = h("div", "ob-row");
  const text = h("span", "ob-text");
  text.append(h("span", "ob-rowname", name), h("span", "ob-sub", hint));
  const sw = h("button", "ob-switch");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", name);
  sw.setAttribute("aria-checked", String(on));
  sw.addEventListener("click", () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    onToggle(next);
  });
  row.append(text, sw);
  return row;
}

function renderPromise(box) {
  const grid = h("div", "ob-grid");
  for (const [glyph, title, body] of PROMISES[PRODUCT]) {
    const card = h("div", "ob-promise");
    card.append(h("span", "ob-glyph", glyph), h("span", "ob-ptitle", title), h("span", "ob-sub", body));
    grid.append(card);
  }
  box.append(grid);
  if (PRODUCT === "go") {
    const row = h("div", "ob-inline");
    row.append(button("ob-btn", "Sign in", openSettings));
    box.append(row);
  }
}

async function renderBrainPrivate(box, seq) {
  await writeChain;
  const s = await getSettings();
  if (seq !== renderSeq) return;
  if (s.provider && s.provider !== "ollama") {
    box.append(h("p", "ob-note", `Your provider is set to ${s.provider} in Settings, so the model is picked there.`));
    const row = h("div", "ob-inline");
    row.append(button("ob-btn", "Open Settings", openSettings));
    box.append(row);
    return;
  }
  box.append(h("p", "ob-note", "Checking Ollama on this computer…"));
  let models = null;
  try {
    const { listModels } = await import("./ollama.js");
    models = await Promise.race([
      listModels(s.ollamaBase),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), 5000))
    ]);
  } catch (_e) { models = null; }
  // The local provider only runs on-machine models; a :cloud tag would be normalized back to the default.
  if (Array.isArray(models)) models = models.filter((m) => typeof m === "string" && !/[:-]cloud$/.test(m));
  if (seq !== renderSeq) return;
  box.textContent = "";
  if (!models || !models.length) {
    box.append(h("p", "ob-note", models
      ? "Ollama is running but has no local models yet. Pull one in a terminal (for example: ollama pull qwen3-coder:30b), then retry."
      : `Ollama is not answering at ${s.ollamaBase}. Start Ollama, then retry.`));
    const row = h("div", "ob-inline");
    row.append(button("ob-btn", "Retry", render), button("ob-btn", "Open Settings", openSettings));
    box.append(row);
    return;
  }
  box.append(h("p", "ob-label plain", `ollama · ${s.ollamaBase}`));
  const items = models.map((m) => ({ value: m, name: m, mono: true, meta: m === s.model ? "current" : "" }));
  box.append(choiceList(items, s.model, (m) => patchSettings({ model: m }), items.length > 6));
}

async function renderBrainGo(box, seq) {
  await writeChain;
  const [s, { CLOUD_MODELS }, auth] = await Promise.all([
    getSettings(),
    import("./cloud.js"),
    import("./auth.js").then((m) => m.getAuth()).catch(() => null)
  ]);
  if (seq !== renderSeq) return;
  const tier = auth && auth.idToken ? String(auth.tier || "free") : "";
  const items = [{ value: "", name: "Auto", desc: "Kimi K3 where your plan includes it, GLM 5.2 on Free and Starter." }];
  for (const list of Object.values(CLOUD_MODELS)) {
    for (const m of list) {
      const label = String(m.label || "");
      const cut = label.indexOf(" — ");
      const allowed = planAllows(tier, m.id);
      items.push({ value: m.id, name: m.id, mono: true, desc: cut >= 0 ? label.slice(cut + 3) : "", disabled: !allowed, meta: allowed ? "" : "not in your plan" });
    }
  }
  if (!tier) box.append(h("p", "ob-note", "Sign in to choose from every model your plan includes. Until then Auto and GLM 5.2 are available."));
  box.append(choiceList(items, s.model || "", (m) => patchSettings({ model: m }), true));
}

async function renderRules(box, seq) {
  await writeChain;
  const [s, local] = await Promise.all([getSettings(), chrome.storage.local.get("actMode")]);
  if (seq !== renderSeq) return;
  const mode = MODES.some(([v]) => v === local.actMode) ? local.actMode : "plan";
  box.append(h("p", "ob-label", "Autonomy mode"));
  box.append(choiceList(
    MODES.map(([value, name, desc]) => ({ value, name, desc })),
    mode,
    (m) => track(() => chrome.storage.local.set({ actMode: m }))
  ));
  box.append(h("p", "ob-label", "Permissions"));
  const rows = h("div", "ob-rows");
  rows.append(switchRow("Auto web-search", "Searches the web when a task needs facts the page does not have.", !!s.autoWebSearch, (on) => patchSettings({ autoWebSearch: on })));
  if (PRODUCT === "private") {
    const hasToken = !!String(s.desktopToken || "").trim();
    const desk = switchRow("Desktop control",
      hasToken
        ? "Mouse, keyboard and screenshots across the whole desktop. Needs the desktop bridge running. Leave off until you need it."
        : "Needs the local desktop bridge and its token. Add the token in Settings > Behavior and limits, then turn this on there.",
      hasToken && !!s.desktopControlEnabled, (on) => patchSettings({ desktopControlEnabled: on }));
    if (!hasToken) { const sw = desk.querySelector(".ob-switch"); sw.disabled = true; sw.setAttribute("aria-disabled", "true"); }
    rows.append(desk);
  }
  box.append(rows);
}

function renderTry(box) {
  const list = h("div", "ob-list");
  for (const [slug, text] of TRY) {
    const b = button("ob-try", null, () => handOff(text));
    const label = h("span", "ob-text");
    label.append(h("span", "ob-name", text));
    b.append(h("span", "ob-slug", slug), label, h("span", "ob-arrow", "→"));
    list.append(b);
  }
  box.append(list);
}

// Opens the side panel (needs this click's user gesture, so it runs before any await) and puts
// the prompt in its message box. sidepanel.js fills the box and never sends it.
function handOff(text) {
  let opened = Promise.resolve(false);
  try {
    if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
      opened = chrome.sidePanel.open({ windowId }).then(() => true, () => false);
    }
  } catch (_e) { /* fall back to the toolbar hint */ }
  const stored = chrome.storage.local.set({ agWelcomePrompt: text, agWelcomePromptAt: Date.now() }).then(() => true, () => false);
  Promise.all([opened, stored]).then(([ok, saved]) => say(!saved
    ? "Could not hand the prompt to the side panel. Type it there instead."
    : ok
      ? "It is in the side panel's message box (unless you already typed something there). Switch to the tab you want help with, then press send."
      : `It is waiting for the message box. Click the ${NAME} icon in the toolbar to open the side panel.`));
}

let closeAnyway = false;
async function closePage() {
  $("obNext").disabled = true;
  $("obSkip").disabled = true;
  // Drain the live queue: a choice clicked while we wait extends it.
  let chain;
  do { chain = writeChain; await chain; } while (chain !== writeChain);
  if (writeFailed && !closeAnyway) {
    say("Could not save: " + ((writeFailed && writeFailed.message) || writeFailed) + ". Try again, or click Skip or Finish once more to close and finish in Settings.");
    closeAnyway = true;
    $("obNext").disabled = false;
    $("obSkip").disabled = false;
    return;
  }
  chrome.tabs.getCurrent()
    .then((t) => (t ? chrome.tabs.remove(t.id) : window.close()))
    .catch(() => window.close());
}

function render() {
  const seq = ++renderSeq;
  const copy = STEPS[PRODUCT][step];
  $("obKicker").textContent = `Step ${step + 1} of 4`;
  $("obTitle").textContent = copy.title;
  $("obBody").textContent = copy.body;
  $("obCount").textContent = `${step + 1} / 4`;
  const dots = $("obDots");
  dots.textContent = "";
  for (let i = 0; i < 4; i++) dots.append(h("span", "ob-dot" + (i <= step ? " on" : "") + (i === step ? " cur" : "")));
  $("obBack").style.visibility = step === 0 ? "hidden" : "visible";
  $("obNext").textContent = step === 3 ? "Finish" : "Continue";
  say("");
  const box = $("obBox");
  box.textContent = "";
  const fail = (e) => { if (seq === renderSeq) say("Could not load this step: " + ((e && e.message) || e)); };
  if (step === 0) renderPromise(box);
  else if (step === 1) (PRODUCT === "go" ? renderBrainGo : renderBrainPrivate)(box, seq).catch(fail);
  else if (step === 2) renderRules(box, seq).catch(fail);
  else renderTry(box);
}

function go(next) {
  step = Math.max(0, Math.min(3, next));
  render();
  $("obTitle").focus({ preventScroll: true });
}

$("obNext").addEventListener("click", () => (step === 3 ? closePage() : go(step + 1)));
$("obBack").addEventListener("click", () => go(step - 1));
$("obSkip").addEventListener("click", closePage);
document.title = `${NAME} — Welcome`;
render();

// settings-nav.js — Settings navigation, design refresh direction (2026-09-14):
// grouped sidebar (General / Agent / Knowledge / Automation / Trust), one page per topic with a
// kicker, title and short description, search across sections, remembered page, unsaved-changes
// footer badge, and the header theme toggle. Loaded AFTER options.js (which runs
// initCollapsibleSettings). It never moves controls, never changes what options.js reads or saves,
// and never un-hides a section that account/license gating or the owner has hidden.
// Page reshape (2026-09-14, "real data only"): related sections share one page (Overview, Models
// and providers, Behavior and limits), and a few page parts from the design are drawn over data
// the extension already has: summary tiles, provider cards bound to #provider, the installed
// Ollama models, the autonomy mode (the side panel's actMode), and list styling hooks.
// Author: iDevOpsLLC
import { expandAncestors } from "./collapsible.js";
import { DEFAULTS } from "./settings.js";

const NAV_ID = "settingsNav";
const SECTION_KEY = "optionsSection";
const GROUP_ORDER = ["General", "Agent", "Knowledge", "Automation", "Trust", "Settings"];

// Section heading (as written in options.html) -> [group, page title, one-line description].
// Sections that share a title share one page; the first non-empty description wins.
const PAGES = [
  [/^License and updates/, "General", "Overview", "Your license, the update window, and the model this copy runs."],
  [/^Update available/, "General", "Overview", ""],
  [/^Account/, "General", "Overview", "Your account, plan, credits and version."],
  [/^Plan & Credits/, "General", "Overview", ""],
  [/^Model$/, "General", "Models and providers", "The model that runs your requests, your own-key options, and the optional local bridges."],
  [/^Local models/, "General", "Models and providers", "Pick the brain. Local models run on this machine; cloud keys stay in this browser profile."],
  [/^Inference provider/, "General", "Models and providers", ""],
  [/^Voice input/, "General", "Models and providers", ""],
  [/^Desktop control/, "Agent", "Behavior and limits", ""],
  [/^Agent behavior/, "Agent", "Behavior and limits", "How much the agent may do before it asks, how long a run may go, and how much it does at once."],
  [/^Knowledge packs/, "Knowledge", "Knowledge packs", "Turn on the packs your work needs. Save applies the change to the next run."],
  [/^Learning/, "Knowledge", "Learning", "Lessons the agent learned from your feedback. Delete any that are wrong."],
  [/^Shortcuts/, "Automation", "Shortcuts", "Slash commands you run from the side panel or on a schedule. Export them before you update."],
  [/^Saved workflows/, "Automation", "Saved workflows", "Workflows you recorded with Teach. Run them from the side panel."],
  [/^Diagnostics/, "Trust", "Diagnostics", "A read-only summary of your stored run history. Nothing leaves this machine."]
];

const MODES = [
  ["plan", "Plan first", "Drafts a step-by-step plan and waits for your approval before doing anything."],
  ["ask", "Ask before acting", "Pauses for your approval before clicking, typing, navigating, or editing code."],
  ["auto", "Act without asking", "Works without pausing for approval. Stop still halts it."],
  ["readonly", "Read-only", "Review and analysis only. Every write tool is removed."]
];

const PROVIDER_NAMES = {
  ollama: "On this computer (Ollama)", "ollama-cloud": "Ollama cloud", openai: "OpenAI", gemini: "Google Gemini",
  anthropic: "Anthropic", "claude-sub": "Claude subscription", "codex-sub": "ChatGPT subscription", xai: "xAI", custom: "Custom endpoint"
};

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const textOf = (id) => ((document.getElementById(id) || {}).textContent || "").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Controls that save or act on their own (not through the main Save button): shortcuts, learning,
// the Private license paste box, Agent Go's sign-in and update cards, and the page parts drawn here.
function isSelfSaving(el) {
  return !!el.closest("#shortcuts, details.card, #licensePasteWrap, #signedOut, #signedIn, #updateCard, .sn-extra, .sn-selfsave")
    || !!(el.closest(".card") && el.closest(".card").querySelector("#workflowList, #analyzeBtn"));
}

function isGatedHidden(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.style && n.style.display === "none") return true;
    if (n.classList && n.classList.contains("owner-hidden")) return true;
    // a collapsible body whose heading is owner-hidden is hidden with it
    if (n.classList && n.classList.contains("cat-body") && n.previousElementSibling && n.previousElementSibling.classList.contains("owner-hidden")) return true;
  }
  return false;
}

function sectionItems() {
  const items = [];
  document.querySelectorAll(".wrap > .card, .wrap > details.card").forEach((card) => {
    if (card.tagName === "DETAILS") {
      const hd = card.querySelector("summary h2");
      if (hd) items.push({ head: hd, card, details: card, body: null, label: hd.textContent.trim() });
      return;
    }
    card.querySelectorAll(":scope > h2").forEach((hd) => {
      const body = hd.nextElementSibling && hd.nextElementSibling.classList.contains("cat-body") ? hd.nextElementSibling : null;
      items.push({ head: hd, card, details: null, body, label: hd.textContent.replace(/^[▸▾]\s*/, "").trim() });
    });
  });
  items.forEach((it) => {
    const page = PAGES.find((p) => p[0].test(it.label));
    it.group = page ? page[1] : "Settings";
    it.title = page ? page[2] : it.label;
    it.blurb = page ? page[3] : "";
  });
  return items;
}

function pagesOf(items) {
  const pages = [];
  for (const it of items) {
    let p = pages.find((x) => x.title === it.title);
    if (!p) { p = { title: it.title, group: it.group, blurb: "", members: [], extras: [] }; pages.push(p); }
    if (!p.blurb && it.blurb) p.blurb = it.blurb;
    p.members.push(it);
    it.page = p;
  }
  return pages;
}

function itemText(it) {
  if (it.details) return it.details.textContent;
  return it.head.textContent + " " + (it.body ? it.body.textContent : "");
}

// A page part that lives outside the section cards: shown only with its page, hidden while searching.
function addExtra(page, node, before) {
  node.classList.add("sn-extra");
  before.before(node);
  page.extras.push(node);
}

// ---------- Page parts (real data only) ----------
function addTiles(page, isGo) {
  const wrap = h("div", "sn-tiles");
  const tiles = {};
  const make = (key, label) => {
    const t = h("div", "sn-tile");
    const v = h("span", "sn-tile-v", "—");
    const s = h("span", "sn-tile-s");
    t.append(h("span", "sn-tile-k", label), v, s);
    wrap.append(t);
    tiles[key] = { v, s };
  };
  const set = (key, v, s) => { tiles[key].v.textContent = v || "—"; tiles[key].s.textContent = s || ""; };
  const watch = (ids, fn) => {
    const run = () => { try { fn(); } catch (e) { /* source not filled yet */ } };
    ids.map((id) => document.getElementById(id)).filter(Boolean).forEach((n) =>
      new MutationObserver(run).observe(n, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style"] }));
    run();
  };
  if (isGo) {
    make("account", "Account"); make("plan", "Plan"); make("version", "Version");
    const signedIn = () => { const n = document.getElementById("signedIn"); return !!n && !n.classList.contains("hidden"); };
    watch(["signedIn", "userEmail"], () => set("account", signedIn() ? textOf("userEmail") : "Signed out", signedIn() ? "Signed in on this browser" : "Sign in below to use your plan."));
    watch(["signedIn", "tierBadge", "creditBadge"], () => set("plan", signedIn() ? cap(textOf("tierBadge")) : "—", signedIn() ? textOf("creditBadge") : "Sign in to see your credits."));
    watch(["versionText"], () => {
      const parts = textOf("versionText").split(" · ");
      set("version", parts[0].replace(/^Agent Go\s*/, "").replace(/^—$/, ""), parts.slice(1).join(" · "));
    });
  } else {
    make("license", "License"); make("version", "Version"); make("model", "Main model");
    watch(["licenseStatus"], () => {
      const txt = textOf("licenseStatus");
      const m = txt.match(/^Licensed to (.+?) · purchased .+? · new versions until ([^(]+)/);
      if (m) set("license", "Licensed", `${m[1]} · updates until ${m[2].trim()}`);
      else if (/^Developer copy/.test(txt)) set("license", "Developer copy", "Loaded from the source folder. No license needed.");
      else if (/^Not licensed/.test(txt)) set("license", "Not licensed", "Paste your key below, or use the download from your account.");
      else set("license", txt.replace(/…$/, "") || "Checking", "");
    });
    watch(["updateStatus", "updateNotice"], () => {
      const parts = textOf("updateStatus").split(" · ");
      const n = document.getElementById("updateNotice");
      const avail = n && !n.hidden && /is available/.test(n.textContent) ? ((n.querySelector("strong") || n).textContent.trim()) : "";
      set("version", parts[0].replace(/^Version\s*/, "").replace(/^—$/, ""), avail || parts.slice(1).join(" · "));
    });
    const renderModel = async () => {
      let stored = {};
      try { stored = (await chrome.storage.sync.get("settings")).settings || {}; } catch (e) { /* not an extension page */ }
      const s = { ...DEFAULTS, ...stored };
      const prov = s.provider || "ollama";
      const model = prov === "ollama" || prov === "ollama-cloud" ? s.model : (s.cloudModel || "provider default");
      set("model", model, PROVIDER_NAMES[prov] || prov);
    };
    renderModel();
    try { chrome.storage.onChanged.addListener((c, area) => { if (area === "sync" && c.settings) renderModel(); }); } catch (e) { /* not an extension page */ }
  }
  addExtra(page, wrap, page.members[0].card);
}

function addProviderCards(page) {
  const sel = document.getElementById("provider");
  if (!sel) return null;
  const isCloudChoice = (v) => v !== "ollama" && v !== "ollama-cloud";
  let lastCloud = isCloudChoice(sel.value) ? sel.value : "";
  const defs = [
    { name: "On this computer", desc: "Ollama on this machine. Page content stays here.", warn: false, match: (v) => v === "ollama", value: () => "ollama" },
    { name: "Ollama cloud", desc: "Ollama-hosted :cloud models through the local daemon. Page content goes to Ollama's servers.", warn: true, match: (v) => v === "ollama-cloud", value: () => "ollama-cloud" },
    { name: "Cloud key or subscription", desc: "OpenAI, Gemini, Anthropic, xAI, a custom endpoint or a subscription bridge. Pick one in the list below.", warn: true, match: isCloudChoice, value: () => lastCloud || "openai" }
  ];
  const wrap = h("div", "sn-cards");
  wrap.setAttribute("role", "radiogroup");
  wrap.setAttribute("aria-label", "Where the main model runs");
  const btns = defs.map((d) => {
    const b = h("button", "sn-pcard");
    b.type = "button";
    b.setAttribute("role", "radio");
    const top = h("span", "sn-pcard-top");
    top.append(h("span", null, d.name), h("span", d.warn ? "sn-dot warn" : "sn-dot"));
    d.meta = h("span", "sn-pcard-meta", d.warn ? "page data leaves this machine" : "private");
    b.append(top, h("span", "sn-pcard-desc", d.desc), d.meta);
    b.addEventListener("click", () => {
      sync(); // pick up a value options.js set without an event before choosing
      const v = d.value();
      if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      sync();
    });
    return b;
  });
  const sync = () => {
    if (isCloudChoice(sel.value)) lastCloud = sel.value;
    defs.forEach((d, i) => btns[i].setAttribute("aria-checked", String(d.match(sel.value))));
  };
  sel.addEventListener("change", sync);
  setInterval(sync, 1500); // options.js fills the select without an event
  wrap.append(...btns);
  addExtra(page, wrap, page.members[0].card);
  sync();
  return defs[0].meta;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return Math.round(n / 1e6) + " MB";
  return n ? Math.round(n / 1e3) + " KB" : "";
}

function addInstalledModels(localMeta) {
  const installed = document.getElementById("installed");
  if (!installed) return;
  const box = h("div", "sn-models");
  box.hidden = true;
  installed.before(box);
  let seq = 0;
  let inflight = null;
  const isCloud = (m) => /[:-]cloud$/.test(m);
  const render = async () => {
    const my = ++seq;
    const base = (((document.getElementById("ollamaBase") || {}).value || "").trim() || DEFAULTS.ollamaBase || "http://localhost:11434").replace(/\/+$/, "");
    let models = null;
    try {
      if (inflight) inflight.abort();
      const ctl = new AbortController();
      inflight = ctl;
      const timer = setTimeout(() => ctl.abort(), 5000);
      try {
        const r = await fetch(base + "/api/tags", { signal: ctl.signal });
        const body = r.ok ? await r.json() : null;
        models = body && Array.isArray(body.models)
          ? body.models.filter((m) => m && typeof (m.name || m.model) === "string")
          : null;
      } finally { clearTimeout(timer); }
    } catch (e) { models = null; }
    if (my !== seq) return;
    box.textContent = "";
    if (!models || !models.length) { box.hidden = true; if (localMeta) localMeta.textContent = "private"; return; }
    const agent = (document.getElementById("model") || {}).value;
    const vision = (document.getElementById("visionModel") || {}).value;
    const head = h("div", "sn-models-head");
    head.append(h("span", null, "Installed models"), h("span", null, "ollama · " + base.replace(/^https?:\/\//, "")));
    const list = h("div", "sn-models-list");
    for (const m of models) {
      const name = String(m.name || m.model || "");
      const row = h("div", "sn-mrow");
      const txt = h("span", "sn-mname");
      txt.append(h("b", null, name));
      const roles = [];
      if (name === agent) roles.push("agent model");
      if (name === vision) roles.push("vision model");
      if (isCloud(name)) roles.push("runs on Ollama's servers");
      if (roles.length) txt.append(h("small", null, roles.join(" · ")));
      row.append(txt);
      if (!isCloud(name) && m.size) row.append(h("span", "sn-msize", fmtSize(m.size)));
      const tag = name === agent ? ["active", "on"] : name === vision ? ["vision", "on"] : isCloud(name) ? ["cloud", "warn"] : ["ready", ""];
      row.append(h("span", ("sn-tag " + tag[1]).trim(), tag[0]));
      list.append(row);
    }
    box.append(head, list);
    box.hidden = false;
    if (localMeta) {
      const n = models.filter((m) => !isCloud(String(m.name || ""))).length;
      localMeta.textContent = `${n} local model${n === 1 ? "" : "s"} installed`;
    }
  };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(render, 300); };
  new MutationObserver(later).observe(installed, { childList: true, characterData: true, subtree: true });
  for (const id of ["model", "visionModel"]) { const e = document.getElementById(id); if (e) e.addEventListener("change", later); }
  later();
}

function addAutonomy(page) {
  const target = page.members.find((m) => /^Agent behavior/.test(m.label)) || page.members[0];
  const block = h("div", "sn-block sn-selfsave sn-searchable");
  const list = h("div", "sn-radios");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "Autonomy mode");
  const btns = MODES.map(([value, name, desc]) => {
    const b = h("button", "sn-radio");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.mode = value;
    const t = h("span", "sn-radio-text");
    t.append(h("span", "sn-radio-name", name), h("span", "sn-radio-desc", desc));
    b.append(h("span", "sn-radio-dot"), t);
    b.addEventListener("click", async () => {
      const prev = confirmed;
      clicks++;
      paint(value, true);
      hint.textContent = "Saving…";
      try {
        await chrome.storage.local.set({ actMode: value });
        confirmed = value;
        paint(value);
        hint.textContent = HINT;
      } catch (e) {
        // Re-read what is actually stored: `prev` can be stale if this click beat the initial read.
        let m = prev;
        try { const r = await chrome.storage.local.get("actMode"); if (MODES.some(([v]) => v === r.actMode)) m = r.actMode; } catch (_e) { /* keep prev */ }
        confirmed = m;
        paint(m);
        hint.textContent = "Could not save the mode (" + ((e && e.message) || e) + "). It is still " + nameOf(m) + ".";
      }
    });
    return b;
  });
  const HINT = "Saved at once. This is the same setting as the mode menu in the side panel.";
  const nameOf = (m) => (MODES.find(([v]) => v === m) || MODES[0])[1];
  let confirmed = "plan";
  let clicks = 0;
  const paint = (m, pending) => btns.forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === m));
    b.classList.toggle("sn-pending", !!pending && b.dataset.mode === m);
  });
  const hint = h("span", "sn-block-hint", HINT);
  hint.setAttribute("role", "status");
  list.append(...btns);
  block.append(h("span", "sn-block-title", "Autonomy"), list, hint);
  paint("plan");
  try {
    const clicksAtRead = clicks; // a click made before the stored value arrives wins over it
    chrome.storage.local.get("actMode", (r) => {
      const m = r && r.actMode;
      if (clicks === clicksAtRead && MODES.some(([v]) => v === m)) { confirmed = m; paint(m); }
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.actMode && MODES.some(([v]) => v === c.actMode.newValue)) { confirmed = c.actMode.newValue; paint(confirmed); }
    });
  } catch (e) { /* not an extension page */ }
  addExtra(page, block, target.card);
}

function addDesktopNote(it) {
  if (!it.body) return;
  it.head.classList.add("sn-late");
  it.body.classList.add("sn-late");
  const note = h("div", "sn-danger-note");
  const t = h("div");
  t.append(h("b", null, "Desktop control and shell"),
    h("span", null, "Lets the agent move your mouse, type, and run shell commands outside the browser. Both are off by default, need the local desktop bridge, and every action asks for your approval first."));
  note.append(t);
  it.body.prepend(note);
}

function addShortcutTools() {
  const filter = document.getElementById("scFilter");
  const name = document.getElementById("scName");
  if (!filter || !name) return;
  const add = h("button", "sn-new", "New command");
  add.type = "button";
  add.addEventListener("click", () => {
    const clear = document.getElementById("scCancel");
    if (clear) clear.click();
    name.scrollIntoView({ block: "center" });
    name.focus();
  });
  const actions = filter.nextElementSibling;
  if (actions && actions.classList.contains("actions")) actions.prepend(add); else filter.after(add);
  const scId = document.getElementById("scId");
  if (scId && scId.parentElement) scId.parentElement.prepend(h("div", "sn-subhead", "Add or edit a command"));
}

function addDiagnosticsNote() {
  const b = document.getElementById("analyzeBtn");
  if (b) b.after(h("span", "sn-note", "Runs locally · nothing uploaded"));
}

function wireLessonBadge(page) {
  const src = document.getElementById("lessonCount");
  if (!src || !page) return;
  const run = () => {
    const m = src.textContent.match(/(\d+)\s+lesson/);
    if (m) page.link.dataset.badge = m[1]; else delete page.link.dataset.badge;
  };
  new MutationObserver(run).observe(src, { childList: true, characterData: true, subtree: true });
  run();
}

function enhance(pages, isGo) {
  const byTitle = (t) => pages.find((p) => p.title === t);
  const overview = byTitle("Overview");
  if (overview) addTiles(overview, isGo);
  const models = byTitle("Models and providers");
  if (models && !isGo) addInstalledModels(addProviderCards(models));
  const behavior = byTitle("Behavior and limits");
  if (behavior) {
    addAutonomy(behavior);
    const desk = behavior.members.find((m) => /^Desktop control/.test(m.label));
    if (desk) addDesktopNote(desk);
  }
  addShortcutTools();
  addDiagnosticsNote();
  wireLessonBadge(byTitle("Learning"));
}

function build() {
  if (document.getElementById(NAV_ID)) return;
  const items = sectionItems();
  if (!items.length) return;
  const pages = pagesOf(items);

  const isGo = document.documentElement.dataset.product === "go";
  let version = "";
  try { version = chrome.runtime.getManifest().version; } catch (e) { /* not an extension page */ }

  const nav = document.createElement("nav");
  nav.id = NAV_ID;
  nav.setAttribute("aria-label", "Settings sections");
  nav.innerHTML = `
    <div class="sn-brand">
      <span class="sn-mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h8"></path><path d="M8 4l4 4-4 4"></path></svg></span>
      <span class="sn-name"><b></b><small></small></span>
    </div>
    <label class="sn-search" for="settingsSearch">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5L14 14"></path></svg>
      <input id="settingsSearch" type="search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" />
    </label>
    <div class="sn-list"></div>
    <p class="sn-empty" hidden>No settings match.</p>`;
  nav.querySelector(".sn-name b").textContent = isGo ? "Agent Go" : "Agent Go Private";
  nav.querySelector(".sn-name small").textContent = (version ? "v" + version + " · " : "") + (isGo ? "settings" : "local-first");
  const list = nav.querySelector(".sn-list");

  const groups = {};
  for (const name of GROUP_ORDER) {
    if (!pages.some((p) => p.group === name)) continue;
    const g = document.createElement("div");
    g.className = "sn-group";
    const capEl = document.createElement("span");
    capEl.className = "sn-group-label";
    capEl.textContent = name;
    g.appendChild(capEl);
    list.appendChild(g);
    groups[name] = g;
  }
  pages.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sn-link";
    b.textContent = p.title;
    b.addEventListener("click", () => { clearSearch(); show(p, true); });
    p.link = b;
    groups[p.group].appendChild(b);
  });

  document.body.prepend(nav);
  document.body.classList.add("has-nav", "sn-paged");

  // Page header: kicker + title (the page h1) + description, next to the theme toggle.
  const head = document.querySelector(".settings-head");
  const h1 = head && head.querySelector("h1");
  let kicker = null, blurb = null;
  if (h1) {
    const titles = document.createElement("div");
    titles.className = "sn-titles";
    kicker = document.createElement("span");
    kicker.className = "sn-kicker";
    blurb = document.createElement("p");
    blurb.className = "sn-blurb";
    h1.before(titles);
    titles.append(kicker, h1, blurb);
  }
  const setHead = (k, title, text) => {
    if (!h1) return;
    kicker.textContent = k;
    h1.textContent = title;
    blurb.textContent = text;
    blurb.hidden = !text;
  };

  // Cards that hold several sections are hidden only when all of their sections are.
  const cards = [...new Set(items.map((it) => it.card))];
  const setOff = (it, off) => {
    for (const el of [it.head, it.body, it.details]) if (el) el.classList.toggle("sn-off", off);
  };
  const syncCards = () => {
    for (const card of cards) {
      const mine = items.filter((it) => it.card === card);
      card.classList.toggle("sn-off", mine.every((it) => it.head.classList.contains("sn-off")));
    }
  };
  const openFully = (it) => {
    if (it.details) it.details.open = true;
    else if (it.head._catSet) it.head._catSet(true);
    const scope = it.details || it.body;
    if (scope) scope.querySelectorAll(".packGroupTitle.cat-head").forEach((t) => t._catSet && t._catSet(true));
  };
  const visible = (it) => !(isGatedHidden(it.card) || isGatedHidden(it.head));
  const pageVisible = (p) => p.members.some(visible);
  const setExtras = (page) => pages.forEach((p) => p.extras.forEach((e) => e.classList.toggle("sn-off", p !== page)));

  let current = null;
  function setCurrent() {
    pages.forEach((p) => p.link.setAttribute("aria-current", p === current ? "true" : "false"));
  }
  function show(page, remember) {
    if (!page) return;
    current = page;
    document.body.classList.remove("sn-searching");
    items.forEach((x) => setOff(x, x.page !== page));
    setExtras(page);
    syncCards();
    page.members.forEach(openFully);
    setHead(page.group, page.title, page.blurb);
    setCurrent();
    window.scrollTo(0, 0);
    if (remember) { try { chrome.storage.local.set({ [SECTION_KEY]: page.title }); } catch (e) { /* not an extension page */ } }
  }
  const firstVisible = () => pages.find(pageVisible) || pages[0];

  enhance(pages, isGo);

  // Gating: hide links (and empty groups) for pages the page has hidden; never un-hide a section.
  let gateSig = "";
  const syncGating = () => {
    pages.forEach((p) => { p.link.hidden = !pageVisible(p); });
    const sig = pages.map((p) => (pageVisible(p) ? "1" : "0")).join("");
    const changed = gateSig !== "" && sig !== gateSig;
    gateSig = sig;
    if (changed && document.body.classList.contains("sn-searching")) {
      const box = document.getElementById("settingsSearch");
      if (box && box.value.trim()) box.dispatchEvent(new Event("input"));
    }
    for (const g of Object.values(groups)) g.hidden = ![...g.querySelectorAll(".sn-link")].some((l) => !l.hidden);
    if (current && !pageVisible(current) && !document.body.classList.contains("sn-searching")) {
      const next = firstVisible();
      if (next !== current) show(next, false); // nothing visible at all: stay put instead of re-showing forever
    }
  };
  let pending = null;
  new MutationObserver(() => { clearTimeout(pending); pending = setTimeout(syncGating, 120); })
    .observe(document.querySelector(".wrap"), { subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });

  // Search: show every matching section (with its heading) until the box is cleared.
  const search = document.getElementById("settingsSearch");
  const emptyNote = nav.querySelector(".sn-empty");
  function clearSearch() {
    if (!search.value) return;
    search.value = "";
    document.querySelectorAll(".search-hit").forEach((n) => n.classList.remove("search-hit"));
    emptyNote.hidden = true;
  }
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll(".search-hit").forEach((n) => n.classList.remove("search-hit"));
    if (!q) { emptyNote.hidden = true; show(current || firstVisible(), false); return; }
    document.body.classList.add("sn-searching");
    setExtras(null);
    let shown = 0;
    let firstHit = null;
    items.forEach((it) => {
      const match = visible(it) && itemText(it).toLowerCase().includes(q);
      setOff(it, !match);
      if (!match) return;
      shown++;
      openFully(it);
      const scope = it.details || it.body;
      if (!scope) return;
      scope.querySelectorAll("label, .packGroupTitle, .hint").forEach((el) => {
        if (isGatedHidden(el) || !el.textContent.toLowerCase().includes(q)) return;
        expandAncestors(el);
        for (let d = el.parentElement && el.parentElement.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
        el.classList.add("search-hit");
        if (!firstHit) firstHit = el;
      });
    });
    pages.forEach((p) => p.extras.forEach((e) => {
      if (e.classList.contains("sn-searchable") && e.textContent.toLowerCase().includes(q)) { e.classList.remove("sn-off"); shown++; }
    }));
    syncCards();
    pages.forEach((p) => p.link.setAttribute("aria-current", "false"));
    setHead("Search", shown ? `Results for “${search.value.trim()}”` : "No settings match", shown ? `${shown} section${shown === 1 ? "" : "s"} contain this text.` : "Try another word.");
    emptyNote.hidden = shown > 0;
    if (firstHit) firstHit.scrollIntoView({ block: "center" });
  });

  // Deep links (#shortcuts, ?highlight=…) and anything focused inside another page open that page.
  const itemFor = (el) => items.find((it) => it.card.contains(el) && (it.details || it.head === el || (it.body && it.body.contains(el))))
    || items.find((it) => it.card === el);
  // Reveal a target inside its page: select the page, open collapsible and native <details> ancestors,
  // then scroll it into view. Gated or owner-hidden targets are never revealed.
  const reveal = (el) => {
    const it = el && itemFor(el);
    if (!it || !visible(it) || isGatedHidden(el)) return false;
    clearSearch();
    show(it.page, false);
    expandAncestors(el);
    for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
    el.scrollIntoView({ block: "center" });
    return true;
  };
  const openHash = () => {
    const id = (location.hash || "").slice(1);
    if (id && reveal(document.getElementById(id))) return true;
    // ?highlight=<shortcut id> (the create_shortcut tool): options.js outlines the row; open its page.
    let hl = null;
    try { hl = new URLSearchParams(location.search).get("highlight"); } catch (e) { hl = null; }
    return !!hl && reveal(document.getElementById("shortcuts"));
  };
  window.addEventListener("hashchange", openHash);
  document.addEventListener("focusin", (e) => {
    if (!e.target || !e.target.closest || !e.target.closest(".sn-off")) return;
    const it = itemFor(e.target);
    if (it && visible(it)) { clearSearch(); show(it.page, false); }
  });

  syncGating();
  if (!openHash()) {
    show(firstVisible(), false);
    // Restore the last page the user opened (older builds stored a section heading).
    try {
      chrome.storage.local.get(SECTION_KEY, (r) => {
        const saved = r && r[SECTION_KEY];
        if (!saved || location.hash || /[?&]highlight=/.test(location.search) || search.value) return;
        const page = pages.find((p) => p.title === saved) || (items.find((x) => x.label === saved) || {}).page;
        if (page && pageVisible(page)) show(page, false);
      });
    } catch (e) { /* not an extension page */ }
  }
}

// Unsaved-changes badge in the Save footer (display only; Save and its validation are unchanged).
function wireDirtyBadge() {
  const save = document.getElementById("save");
  if (!save || document.getElementById("dirtyBadge")) return;
  const badge = document.createElement("span");
  badge.id = "dirtyBadge";
  badge.className = "dirty-badge";
  badge.setAttribute("role", "status");
  badge.textContent = "Unsaved changes";
  badge.hidden = true;
  save.after(badge);
  const setDirty = (on) => { badge.hidden = !on; document.body.classList.toggle("is-dirty", on); };
  const wrap = document.querySelector(".wrap");
  let editRev = 0;     // bumps on every Save-covered edit
  let revAtSave = -1;  // edit revision when Save/Reset was clicked
  const onEdit = (e) => {
    const t = e.target;
    if (!t || t.id === "settingsSearch" || isSelfSaving(t)) return;
    if (t.matches("input, select, textarea")) { editRev++; setDirty(true); }
  };
  wrap.addEventListener("input", onEdit);
  wrap.addEventListener("change", onEdit);
  for (const id of ["save", "reset"]) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => { revAtSave = editRev; }, true);
  }
  // Cleared only when Save or Reset finished every write (options.js dispatches this last), and only if
  // nothing was edited while it was running. A change made elsewhere or a refused Save leaves it on.
  document.addEventListener("ag-settings-saved", () => {
    if (revAtSave === editRev) setDirty(false);
    revAtSave = -1;
  });
}

// Header theme toggle (same pattern as public/home.html): icon + label, each click cycles
// System -> Light -> Dark and is applied and stored at once in its own key (uiTheme), so it never
// touches the settings object or the Unsaved changes badge.
const THEME_ORDER = ["system", "light", "dark"];
const THEME_NAME = { system: "System", light: "Light", dark: "Dark" };
const THEME_ICON = {
  system: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"></circle><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor"></path></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="3"></circle><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"></path></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10.2A5.6 5.6 0 0 1 5.8 3a5.6 5.6 0 1 0 7.2 7.2z"></path></svg>'
};
function wireThemeToggle() {
  const btn = document.getElementById("themeCycle");
  if (!btn) return;
  const render = (v) => {
    const mode = THEME_ORDER.includes(v) ? v : "system";
    btn.querySelector(".tc-ico").innerHTML = THEME_ICON[mode];
    btn.querySelector(".tc-label").textContent = THEME_NAME[mode];
    btn.title = `Theme: ${THEME_NAME[mode]}. Click to change`;
    btn.setAttribute("aria-label", `Color theme: ${THEME_NAME[mode]}. Click to change`);
  };
  render(window.__agGetTheme ? window.__agGetTheme() : "system");
  btn.addEventListener("click", () => {
    const cur = window.__agGetTheme ? window.__agGetTheme() : "system";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    render(next);
    if (window.__agSaveTheme) window.__agSaveTheme(next).catch((e) => console.warn("[theme] could not be saved", e));
  });
  window.addEventListener("ag-theme-applied", (e) => render(e.detail)); // follows the side-panel menu and late sync
}

build();
wireDirtyBadge();
wireThemeToggle();

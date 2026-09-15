// editors.js — CodeMirror/Monaco code-editor access (e.g. ServiceNow widget panes).
// Content scripts run in an ISOLATED world and cannot see page JS objects like
// el.CodeMirror, so these tools inject functions into the page's MAIN world.
// Author: iDevOpsLLC

import { SN_TABLE_ALIAS_HINTS, SN_FIELD_ALIAS_HINTS, wfActivityQueryHint } from "./sn-hints.js";

// ---------------------------------------------------------------------------
// Functions below run IN THE PAGE (MAIN world). They are serialized by
// chrome.scripting and must be fully self-contained — no module references.
// ---------------------------------------------------------------------------

function pageEnumEditors() {
  const found = [];
  (function walk(root, depth) {
    if (depth > 12) return;
    let els = [];
    try { els = root.querySelectorAll("*"); } catch { els = []; }
    for (const el of els) {
      const cls = el.classList;
      if (cls && cls.contains("CodeMirror") && el.CodeMirror) {
        found.push({ kind: "codemirror", el });
      } else if (
        cls && cls.contains("monaco-editor") &&
        !(el.parentElement && el.parentElement.closest(".monaco-editor"))
      ) {
        found.push({ kind: "monaco", el });
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  })(document, 0);

  function monacoFor(el) {
    try {
      const eds = (window.monaco && window.monaco.editor && window.monaco.editor.getEditors)
        ? window.monaco.editor.getEditors() : [];
      return eds.find((e) => {
        const n = e.getDomNode && e.getDomNode();
        return n && (n === el || el.contains(n) || n.contains(el));
      }) || null;
    } catch { return null; }
  }
  function valueOf(item) {
    try {
      if (item.kind === "codemirror") return item.el.CodeMirror.getValue();
      const ed = monacoFor(item.el);
      return ed ? ed.getValue() : null;
    } catch { return null; }
  }
  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.slice(0, 80);
    let n = el;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      let sib = n.previousElementSibling, hops = 0;
      while (sib && hops < 3) {
        const t = (sib.innerText || "").trim();
        if (t && t.length <= 80) return t.split("\n")[0];
        sib = sib.previousElementSibling; hops++;
      }
      const lab = n.querySelector && n.querySelector("label, .panel-title, legend");
      if (lab) {
        const t = (lab.innerText || "").trim();
        if (t && t.length <= 80) return t.split("\n")[0];
      }
    }
    return "";
  }
  return found.map((item, i) => {
    const v = valueOf(item);
    const r = item.el.getBoundingClientRect();
    return {
      localIndex: i,
      kind: item.kind,
      label: labelOf(item.el),
      visible: r.width > 0 && r.height > 0,
      chars: v == null ? null : v.length,
      preview: v == null ? null : v.slice(0, 160)
    };
  });
}

function pageGetEditorValue(localIndex, maxChars) {
  const found = [];
  (function walk(root, depth) {
    if (depth > 12) return;
    let els = [];
    try { els = root.querySelectorAll("*"); } catch { els = []; }
    for (const el of els) {
      const cls = el.classList;
      if (cls && cls.contains("CodeMirror") && el.CodeMirror) found.push({ kind: "codemirror", el });
      else if (cls && cls.contains("monaco-editor") && !(el.parentElement && el.parentElement.closest(".monaco-editor"))) found.push({ kind: "monaco", el });
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  })(document, 0);

  const item = found[localIndex];
  if (!item) return { error: "stale" };
  let v = null;
  try {
    if (item.kind === "codemirror") v = item.el.CodeMirror.getValue();
    else {
      const eds = (window.monaco && window.monaco.editor && window.monaco.editor.getEditors)
        ? window.monaco.editor.getEditors() : [];
      const ed = eds.find((e) => {
        const n = e.getDomNode && e.getDomNode();
        return n && (n === item.el || item.el.contains(n) || n.contains(item.el));
      });
      if (ed) v = ed.getValue();
    }
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
  if (v == null) return { error: "Could not read this editor's value." };
  const cap = maxChars || 30000;
  return { kind: item.kind, chars: v.length, value: v.slice(0, cap), truncated: v.length > cap };
}

function pageSetEditorValue(localIndex, value, append) {
  const found = [];
  (function walk(root, depth) {
    if (depth > 12) return;
    let els = [];
    try { els = root.querySelectorAll("*"); } catch { els = []; }
    for (const el of els) {
      const cls = el.classList;
      if (cls && cls.contains("CodeMirror") && el.CodeMirror) found.push({ kind: "codemirror", el });
      else if (cls && cls.contains("monaco-editor") && !(el.parentElement && el.parentElement.closest(".monaco-editor"))) found.push({ kind: "monaco", el });
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  })(document, 0);

  const item = found[localIndex];
  if (!item) return { error: "stale" };
  try {
    if (item.kind === "codemirror") {
      const cm = item.el.CodeMirror;
      const nv = append ? cm.getValue() + value : value;
      cm.setValue(nv);
      if (cm.save) cm.save(); // sync the underlying <textarea> (classic SN forms)
      if (cm.refresh) cm.refresh();
      const ta = cm.getTextArea && cm.getTextArea();
      if (ta) {
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true, kind: "codemirror", chars: nv.length };
    }
    const eds = (window.monaco && window.monaco.editor && window.monaco.editor.getEditors)
      ? window.monaco.editor.getEditors() : [];
    const ed = eds.find((e) => {
      const n = e.getDomNode && e.getDomNode();
      return n && (n === item.el || item.el.contains(n) || n.contains(item.el));
    });
    if (!ed) return { error: "Monaco editor instance not reachable on this page." };
    const nv = append ? ed.getValue() + value : value;
    ed.setValue(nv);
    return { ok: true, kind: "monaco", chars: nv.length };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Background-side wrappers (service worker).
// ---------------------------------------------------------------------------

// Per-tab cache of the last enumeration: index -> { frameId, localIndex, ... }.
const cache = new Map();

async function enumerate(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: pageEnumEditors
    });
  } catch (e) {
    throw new Error(`Cannot inspect editors on this page: ${e.message}`);
  }
  const flat = [];
  for (const r of results || []) {
    for (const ed of r.result || []) flat.push({ frameId: r.frameId, ...ed });
  }
  flat.forEach((e, i) => { e.index = i; });
  cache.set(tabId, flat);
  return flat;
}

export async function listEditors(tabId) {
  const flat = await enumerate(tabId);
  if (!flat.length) {
    return { count: 0, editors: [], note: "No CodeMirror/Monaco editors found. If the page should have them, they may still be loading — read the page or wait, then retry." };
  }
  return {
    count: flat.length,
    editors: flat.map((e) => ({
      index: e.index, kind: e.kind, label: e.label, visible: e.visible, chars: e.chars, preview: e.preview
    }))
  };
}

async function locate(tabId, index) {
  let flat = cache.get(tabId);
  if (!flat || !flat[index]) flat = await enumerate(tabId);
  const ed = flat[index];
  if (!ed) throw new Error(`No editor with index ${index} (${flat.length} found). Call list_editors first.`);
  return ed;
}

async function runOnEditor(tabId, ed, func, args) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [ed.frameId] },
    world: "MAIN",
    func,
    args
  });
  return r ? r.result : { error: "No result from page." };
}

export async function getEditorValue(tabId, index, maxChars) {
  let ed = await locate(tabId, index);
  let res = await runOnEditor(tabId, ed, pageGetEditorValue, [ed.localIndex, maxChars || 30000]);
  if (res && res.error === "stale") { // page re-rendered — re-enumerate and retry once
    await enumerate(tabId);
    ed = await locate(tabId, index);
    res = await runOnEditor(tabId, ed, pageGetEditorValue, [ed.localIndex, maxChars || 30000]);
  }
  return res;
}

export async function setEditorValue(tabId, index, value, append) {
  let ed = await locate(tabId, index);
  let res = await runOnEditor(tabId, ed, pageSetEditorValue, [ed.localIndex, String(value ?? ""), !!append]);
  if (res && res.error === "stale") {
    await enumerate(tabId);
    ed = await locate(tabId, index);
    res = await runOnEditor(tabId, ed, pageSetEditorValue, [ed.localIndex, String(value ?? ""), !!append]);
  }
  return res;
}

// ---------------------------------------------------------------------------
// save_record — SAVE a classic ServiceNow form via its OWN g_form API and VERIFY
// the record persisted. A bare click on "Submit"/"Update" only proves the button
// was clicked; a mandatory-field block or a client script can silently refuse the
// insert (the live failure: "successful" Submit clicks that created ZERO records).
// g_form is the authoritative model (validates + saves) but lives in the classic
// form's iframe MAIN world, unreachable from the content script — so we drive it
// here via chrome.scripting (same mechanism as the editors above). Verified LIVE
// 2026-07-15 on dev000000: g_form.getMissingFields()/save()/getUniqueValue() are
// the reliable primitives; g_form.save() = save-and-stay (insert-and-stay on a
// new record), which is exactly what makes the Advanced tab render afterwards.
// ---------------------------------------------------------------------------

// MAIN-world: validate + save. Self-contained (serialized by chrome.scripting).
// Exported for the workflow-activity form route in tools.js (sn_wf_activity_set).
export function pageSnSave() {
  try {
    var gf = window.g_form;
    if (!gf || typeof gf.save !== "function") return { hasGform: false };
    var missing = [];
    try { missing = gf.getMissingFields ? gf.getMissingFields() : []; } catch (e) {}
    if (missing && missing.length) {
      var labels = missing.map(function (f) {
        try { return gf.getLabelOf ? gf.getLabelOf(f) : f; } catch (e) { return f; }
      });
      return { hasGform: true, blocked: true, missing: labels };
    }
    try { gf.save(); } catch (e) { return { hasGform: true, error: String((e && e.message) || e) }; }
    return { hasGform: true, saving: true };
  } catch (e) { return { hasGform: false, error: String((e && e.message) || e) }; }
}

// MAIN-world: fire a save UI ACTION. Fallback when g_form.save() can't confirm a
// new-record insert but a UI action works (live SN1 a-live-run). PREFERS the
// header context-menu "Save (remain here)" / "Insert and Stay" — a save-AND-STAY
// that keeps the form open with the new sys_id (user 2026-07-20h: right-click the
// form header → Save; it does NOT redirect to the list). Only if a stay action
// isn't reachable does it fall back to Submit/Update (save-and-EXIT to the list),
// which still saves but loses the open form + sys_id.
function pageSnSubmitInsert() {
  try {
    var gf = window.g_form;
    if (!gf) return { hasGform: false };
    var isNew = false;
    try { isNew = gf.isNewRecord ? gf.isNewRecord() : false; } catch (e) {}
    var stay = isNew ? "sysverb_insert_and_stay" : "sysverb_update_and_stay";
    var exit = isNew ? "sysverb_insert" : "sysverb_update";
    // 1) a rendered stay button, if the form shows one
    var b = document.getElementById(stay);
    if (b) { b.click(); return { hasGform: true, clicked: stay, stayed: true }; }
    // 2) invoke the stay UI action directly (the header-menu "Save" path)
    if (typeof window.gsftSubmit === "function") {
      var form = gf.getFormElement ? gf.getFormElement() : null;
      window.gsftSubmit(null, form, stay);
      return { hasGform: true, clicked: stay, stayed: true };
    }
    // 3) last resort: save-and-EXIT (redirects to the list, sys_id not kept)
    var e2 = document.getElementById(exit) || document.getElementById("sysverb_insert")
          || document.getElementById("sysverb_insert_bottom");
    if (e2) { e2.click(); return { hasGform: true, clicked: e2.id, stayed: false }; }
    return { hasGform: true, clicked: null };
  } catch (e) { return { hasGform: true, error: String((e && e.message) || e) }; }
}

// MAIN-world: detect a visible blocking dialog/modal (GlideModal / GlideDialogWindow /
// UI16 Bootstrap .modal) and report its title + visible button labels. The ACL
// "Verify Security Rules" confirmation is the canonical case (live 2026-08-19
// STRY0000001 run: save_record reported "likely blocked by validation" while the
// dialog sat open waiting for Continue). Returns null when no dialog is visible so
// runMainAllFrames' find(Boolean) picks the frame that actually has one.
function pageSnDetectDialog() {
  try {
    var sels = '.modal.in, .modal[style*="display: block"], [id^="glide_modal"], [id^="glide_dialog"], .gd_window, div[role="dialog"], div[role="alertdialog"]';
    var nodes = document.querySelectorAll(sels);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var r = n.getBoundingClientRect();
      if (!r || r.width < 50 || r.height < 40) continue;
      var cs = window.getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // Separate queries, NOT one selector list: querySelector('a, b') returns the
      // first match in TREE ORDER, so the .modal-header ancestor would always beat
      // its own h4 and drag the "×" close glyph into the title (validation D1).
      var titleEl = n.querySelector('.modal-title')
                 || n.querySelector('[id$="_title_text"]')
                 || n.querySelector('.modal-header h4')
                 || n.querySelector('h4, h1, h2, h3')
                 || n.querySelector('.modal-header');
      var title = titleEl ? String(titleEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) : "";
      var btns = [];
      var bl = n.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]');
      for (var j = 0; j < bl.length; j++) {
        var b = bl[j];
        if (b.classList && b.classList.contains("close")) continue; // "×" glyph is noise
        if ((b.getAttribute && (b.getAttribute("aria-label") || "")).toLowerCase() === "close") continue;
        var br = b.getBoundingClientRect();
        if (!br || br.width < 10 || br.height < 10) continue;
        var t = String(b.textContent || b.value || "").replace(/\s+/g, " ").trim();
        if (t && t !== "×" && t.length <= 40 && btns.indexOf(t) < 0) btns.push(t);
      }
      return { hasDialog: true, title: title, buttons: btns.slice(0, 10) };
    }
    return null;
  } catch (e) { return null; }
}

// MAIN-world: click Continue on the "Verify Security Rules" dialog ONLY. This
// dialog is informational (it lists the ACL rules being added under an elevated
// security_admin session) and Continue simply commits the submit the agent
// already initiated — every other dialog is surfaced to the model, never
// auto-clicked. Returns null when the dialog isn't present in this frame.
function pageSnClickVerifyContinue() {
  try {
    var sels = '.modal.in, .modal[style*="display: block"], [id^="glide_modal"], [id^="glide_dialog"], .gd_window, div[role="dialog"], div[role="alertdialog"]';
    var nodes = document.querySelectorAll(sels);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var r = n.getBoundingClientRect();
      if (!r || r.width < 50 || r.height < 40) continue;
      // Same prioritized lookup as pageSnDetectDialog (see D1 note there).
      var titleEl = n.querySelector('.modal-title')
                 || n.querySelector('[id$="_title_text"]')
                 || n.querySelector('.modal-header h4')
                 || n.querySelector('h4, h1, h2, h3')
                 || n.querySelector('.modal-header');
      var title = titleEl ? String(titleEl.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (!/verify security rules/i.test(title)) continue;
      var bl = n.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]');
      for (var j = 0; j < bl.length; j++) {
        var t = String(bl[j].textContent || bl[j].value || "").replace(/\s+/g, " ").trim();
        if (/^continue$/i.test(t)) { bl[j].click(); return { clickedContinue: true, title: title }; }
      }
    }
    return null;
  } catch (e) { return null; }
}

// MAIN-world: read the current record state (after g_form re-instantiates on save).
function pageSnState() {
  try {
    var gf = window.g_form;
    if (!gf) return { hasGform: false };
    var id = null, isNew = null;
    try { id = gf.getUniqueValue ? gf.getUniqueValue() : null; } catch (e) {}
    try { isNew = gf.isNewRecord ? gf.isNewRecord() : null; } catch (e) {}
    return { hasGform: true, sysId: id, isNewRecord: isNew };
  } catch (e) { return { hasGform: false }; }
}

async function runMainAllFrames(tabId, func) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func });
  } catch (e) {
    return { error: `Cannot reach the page: ${e.message}` };
  }
  // The classic form frame is the one exposing g_form.
  return (results || []).map((r) => r && r.result).find((r) => r && r.hasGform) || (results || []).map((r) => r && r.result).find(Boolean) || null;
}

// Classify the tab URL AFTER an Insert UI action fired: a genuine saved sys_id
// (32-hex, never the -1 new-record marker), OR a navigation to the record list
// (insert succeeded and exited — a validation failure would keep the form open).
// Pure + exported so the save-fallback decision is unit-tested. Handles the
// polaris double-encoded classic URL (…​.do%3Fsys_id%3D<hex>…) via decode.
export function classifySavedUrl(url) {
  // Guarded: a stray "%" in the tab URL makes decodeURIComponent throw URIError
  // (validation D2) — fall back to the raw string rather than rejecting the tool call.
  let u; try { u = decodeURIComponent(String(url || "")); } catch (e) { u = String(url || ""); }
  const m = u.match(/[?&]sys_id=([0-9a-f]{32})\b/i);
  if (m) return { sys_id: m[1] };
  if (/[_/]list\.do\b|\/list\b/i.test(u)) return { list: true };
  return null;
}

export async function saveServiceNowRecord(tabId) {
  const r = await runMainAllFrames(tabId, pageSnSave);
  if (r && r.error && !r.hasGform) return { ok: false, error: r.error };
  if (!r || !r.hasGform) {
    return { ok: false, error: "No ServiceNow form found on this page (g_form is not present). save_record works on a CLASSIC ServiceNow form (…/<table>.do). Open the record's classic form and retry." };
  }
  if (r.blocked) {
    const labels = r.missing || [];
    return {
      ok: false, saved: false, blocked_by: "unpopulated_mandatory_fields",
      mandatory_fields: labels.length ? labels : undefined,
      error: "ServiceNow refused the save — required field(s) are still empty" +
        (labels.length ? " (" + labels.join(", ") + ")" : "") +
        ". The record was NOT created. Fill the missing field(s) — open its section tab first if it's hidden — then call save_record again."
    };
  }
  if (r.error) return { ok: false, error: "g_form.save() failed: " + r.error };

  // Poll for the saved sys_id — g_form re-instantiates after the save-and-stay.
  let state = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((res) => setTimeout(res, 300));
    state = await runMainAllFrames(tabId, pageSnState);
    if (state && state.sysId && /^[0-9a-f]{32}$/i.test(state.sysId) && state.isNewRecord !== true) break;
  }
  if (state && state.sysId && /^[0-9a-f]{32}$/i.test(state.sysId) && state.isNewRecord !== true) {
    return {
      ok: true, saved: true, sys_id: state.sysId,
      note: "Record saved and still open. If you now need the Advanced tab (Condition + Script) on a Business Rule, open_form_section {\"section\":\"Advanced\"} then list_editors + set_editor_value for the Script, and save_record again."
    };
  }

  // DIALOG CHECK (2026-08-19, live STRY0000001 ACL run): a confirmation dialog
  // (canonically the ACL "Verify Security Rules" modal under security_admin
  // elevation) keeps the record unsaved while the form shows NO field error, so
  // the old code fell through to "validation is likely blocking it" and the model
  // spiraled hunting for a red field. Auto-continue that known-safe dialog; report
  // any other dialog to the model instead of guessing.
  const dialogOutcome = await handleConfirmationDialog(tabId);
  if (dialogOutcome) return dialogOutcome;

  // FALLBACK (2026-07-20h, live SN1 a-live-run): g_form.save() (save-and-stay)
  // sometimes can't confirm a NEW-record insert even though the Insert UI ACTION
  // works — in the live run the model had to find and click Submit itself. Try the
  // real Insert/Update button (save-and-exit), then confirm via a real sys_id OR
  // navigation to the record list (a validation failure keeps the form OPEN, so a
  // list-nav is a reliable insert-succeeded signal).
  const sub = await runMainAllFrames(tabId, pageSnSubmitInsert);
  if (sub && sub.clicked) {
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 300));
      const st = await runMainAllFrames(tabId, pageSnState);
      if (st && st.sysId && /^[0-9a-f]{32}$/i.test(st.sysId) && st.isNewRecord !== true) {
        return { ok: true, saved: true, sys_id: st.sysId, note: `Saved via the ${sub.clicked} action (save-and-STAY; g_form.save() could not confirm). The form is still open on the record — read it back to verify fields persisted.` };
      }
      let rawUrl = "";
      try { rawUrl = (await chrome.tabs.get(tabId)).url || ""; } catch (e) {}
      const cls = classifySavedUrl(rawUrl);
      if (cls && cls.sys_id) return { ok: true, saved: true, sys_id: cls.sys_id, note: `Saved via the ${sub.clicked} action; the form stayed open on the record.` };
      if (cls && cls.list) {
        return { ok: true, saved: true, sys_id: null, note: `Insert succeeded via the ${sub.clicked} action and returned to the record list (a validation failure would have kept the form open). sys_id not captured — re-open the record from the list to confirm and read it back.` };
      }
    }
  }

  // The Insert action can ALSO trigger the confirmation dialog (it fires the same
  // submit path) — check once more before blaming form validation.
  const lateDialog = await handleConfirmationDialog(tabId);
  if (lateDialog) return lateDialog;

  return {
    ok: false, saved: false,
    error: "g_form.save() and the Insert UI action both failed to confirm a saved sys_id (the record still reads as new/unsaved and did not exit to the list). A required field, client script, ACL, or data policy is likely blocking it — inspect with read_page / query_elements (look for a red field error or a form message) before retrying; do NOT assume it saved."
  };
}

// Shared by both save_record failure points: if a confirmation dialog is open,
// auto-continue the ACL "Verify Security Rules" one (informational; Continue just
// commits the submit the agent already initiated) and confirm the save landed;
// report any OTHER dialog to the model with its title + buttons. Returns null when
// no dialog is involved so the caller proceeds to its normal path.
async function handleConfirmationDialog(tabId) {
  const dlg = await runMainAllFrames(tabId, pageSnDetectDialog);
  if (!dlg || !dlg.hasDialog) return null;
  const isVerify = /verify security rules/i.test(dlg.title || "");
  const hasContinue = (dlg.buttons || []).some((b) => /^continue$/i.test(b));
  if (isVerify && hasContinue) {
    const clicked = await runMainAllFrames(tabId, pageSnClickVerifyContinue);
    if (clicked && clicked.clickedContinue) {
      for (let i = 0; i < 24; i++) {
        await new Promise((res) => setTimeout(res, 300));
        const st = await runMainAllFrames(tabId, pageSnState);
        if (st && st.sysId && /^[0-9a-f]{32}$/i.test(st.sysId) && st.isNewRecord !== true) {
          return { ok: true, saved: true, sys_id: st.sysId, note: "Saved. ServiceNow showed the 'Verify Security Rules' confirmation dialog (normal for ACL changes under security_admin); Continue was clicked automatically to commit it." };
        }
        let rawUrl = "";
        try { rawUrl = (await chrome.tabs.get(tabId)).url || ""; } catch (e) {}
        const cls = classifySavedUrl(rawUrl);
        if (cls && cls.sys_id) return { ok: true, saved: true, sys_id: cls.sys_id, note: "Saved after auto-confirming the 'Verify Security Rules' dialog." };
        if (cls && cls.list) return { ok: true, saved: true, sys_id: null, note: "Saved after auto-confirming the 'Verify Security Rules' dialog; the form exited to the record list. sys_id not captured — query the record back (sn_query_session) to confirm and get it." };
      }
      return {
        ok: false, saved: false, blocked_by: "confirmation_dialog",
        dialog: { title: dlg.title, buttons: dlg.buttons },
        error: "Clicked Continue on the '" + dlg.title + "' dialog but could not confirm a saved sys_id afterwards. Re-check the form (read_page) and verify via sn_query_session before retrying; do NOT assume it saved."
      };
    }
  }
  return {
    ok: false, saved: false, blocked_by: "confirmation_dialog",
    dialog: { title: dlg.title || "(untitled dialog)", buttons: dlg.buttons || [] },
    error: "The save is waiting on an open confirmation dialog" + (dlg.title ? " ('" + dlg.title + "')" : "") + " — this is NOT a field-validation failure, so do not re-fill the form or hunt for red fields. Dialog buttons: " + ((dlg.buttons || []).join(", ") || "(none detected)") + ". Either click the confirming button via query_elements + click_element, or STOP and tell the user the dialog needs their decision. Then verify the record saved with sn_query_session."
  };
}

// ---------------------------------------------------------------------------
// sn_set_field — set ANY classic-form field via its OWN g_form.setValue() API.
// This is the RELIABLE way to populate reference, glide_list (list collector /
// slushbucket), choice, and plain fields — it drives the form's authoritative model
// directly, so there is NO fighting the slushbucket DOM, no "Lookup using list"
// popup window, no autocomplete race. For a reference / glide_list field the `value`
// MUST be the target record's sys_id(s) (comma-separated for a list) and `display`
// the shown name(s): pass both and g_form commits instantly. Get the sys_id first
// with sn_query_session on the reference table. `append` adds to a list instead of
// replacing it. Verified via g_form.getValue after the set.
// ---------------------------------------------------------------------------
function pageSnSetField(field, value, display, append) {
  try {
    var gf = window.g_form;
    if (!gf || typeof gf.setValue !== "function") return { hasGform: false };
    // g_form uses the BARE field name (no "<table>." prefix) — strip it if present.
    var f = String(field || "");
    if (f.indexOf(".") !== -1) f = f.split(".").pop();
    var present = false;
    try { present = gf.hasField ? gf.hasField(f) : !!gf.getControl(f); } catch (e) {}
    if (!present) {
      var names; try { names = gf.getFieldNames ? gf.getFieldNames() : undefined; } catch (e) {}
      return { hasGform: true, error: "field '" + f + "' is not on this form", available_fields: names };
    }
    var mandatory = false; try { mandatory = gf.isMandatory ? gf.isMandatory(f) : false; } catch (e) {}
    var v = value == null ? "" : String(value);
    // glide_list append: union the existing sys_ids with the new one(s), de-duped.
    if (append) {
      var cur = ""; try { cur = gf.getValue(f) || ""; } catch (e) {}
      var seen = {}, out = [];
      (cur ? cur.split(",") : []).concat(v ? v.split(",") : []).forEach(function (x) {
        x = (x || "").trim(); if (x && !seen[x]) { seen[x] = 1; out.push(x); }
      });
      v = out.join(",");
    }
    try {
      if (display != null && String(display) !== "") gf.setValue(f, v, String(display));
      else gf.setValue(f, v);
    } catch (e) { return { hasGform: true, error: "g_form.setValue('" + f + "') failed: " + String((e && e.message) || e) }; }
    var after = null, disp = null;
    try { after = gf.getValue(f); } catch (e) {}
    try { disp = gf.getDisplayValue ? gf.getDisplayValue(f) : null; } catch (e) {}
    return { hasGform: true, ok: true, field: f, value: after, display: disp, mandatory: mandatory };
  } catch (e) { return { hasGform: false, error: String((e && e.message) || e) }; }
}

// MAIN-world: dump the form's fields + best-effort type so the agent can SEE the
// record's shape (which fields are reference/glide_list/choice and what they need).
function pageSnFormFields() {
  try {
    var gf = window.g_form;
    if (!gf) return { hasGform: false };
    var table = null; try { table = gf.getTableName ? gf.getTableName() : null; } catch (e) {}
    var names = []; try { names = gf.getFieldNames ? gf.getFieldNames() : []; } catch (e) {}
    // Fallback: some form versions return nothing from getFieldNames() — enumerate g_form.elements
    // (GlideForm's own field list) instead so a fresh new-record form still reports its fields.
    if ((!names || !names.length) && gf.elements && gf.elements.length) {
      try { names = gf.elements.map(function (el) { return el && (el.fieldName || (el.getName && el.getName())); }).filter(Boolean); } catch (e) {}
    }
    var fields = [];
    for (var i = 0; i < names.length; i++) {
      var f = names[i]; if (!f) continue;
      var o = { name: f };
      try { o.label = gf.getLabelOf ? gf.getLabelOf(f) : f; } catch (e) {}
      try { o.mandatory = gf.isMandatory ? gf.isMandatory(f) : false; } catch (e) {}
      try { o.value = gf.getValue ? gf.getValue(f) : ""; } catch (e) {}
      try { o.display = gf.getDisplayValue ? gf.getDisplayValue(f) : ""; } catch (e) {}
      // Best-effort type: a sys_display.* twin ⇒ reference/list; a <select> ⇒ choice; else string.
      try {
        var ctrl = gf.getControl ? gf.getControl(f) : null;
        if (document.getElementById("sys_display." + (table || "") + "." + f)) o.type = "reference_or_list";
        else if (ctrl && ctrl.tagName === "SELECT") o.type = "choice";
        else if (ctrl && ctrl.tagName) o.type = ctrl.type || ctrl.tagName.toLowerCase();
        else o.type = "unknown";
      } catch (e) { o.type = "unknown"; }
      fields.push(o);
    }
    return { hasGform: true, table: table, fields: fields };
  } catch (e) { return { hasGform: false, error: String((e && e.message) || e) }; }
}

async function runMainAllFramesArgs(tabId, func, args) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func, args: args || [] });
  } catch (e) { return { error: `Cannot reach the page: ${e.message}` }; }
  return (results || []).map((r) => r && r.result).find((r) => r && r.hasGform)
      || (results || []).map((r) => r && r.result).find(Boolean) || null;
}

export async function setServiceNowField(tabId, { field, value, display, append } = {}) {
  if (!field) return { ok: false, error: "sn_set_field requires a 'field' (the field name, e.g. sc_catalogs)." };
  const r = await runMainAllFramesArgs(tabId, pageSnSetField, [
    String(field), value == null ? "" : String(value), display == null ? null : String(display), !!append
  ]);
  if (r && r.error && !r.hasGform) return { ok: false, error: r.error };
  if (!r || !r.hasGform) {
    return { ok: false, error: "No ServiceNow classic form found (g_form is not present). sn_set_field works on a CLASSIC form (…/<table>.do). Open the record's classic form and retry." };
  }
  if (r.error) return { ok: false, error: r.error, available_fields: r.available_fields };
  return {
    ok: true, field: r.field, value: r.value, display: r.display, mandatory: r.mandatory,
    note: "Set via g_form.setValue and verified. For a reference/glide_list, `value` MUST be the sys_id(s) and `display` the name(s) — get the sys_id with sn_query_session on the reference table first. Then save_record."
  };
}

export async function getServiceNowFormFields(tabId) {
  const r = await runMainAllFramesArgs(tabId, pageSnFormFields, []);
  if (!r || !r.hasGform) return { ok: false, error: "No ServiceNow classic form found (g_form absent). Open the record's classic form (…/<table>.do)." };
  return { ok: true, table: r.table, fields: r.fields, note: "type 'reference_or_list' = set it with sn_set_field (value=sys_id from sn_query_session, display=name). type 'choice' = sn_set_field with the choice value. Mandatory fields must be filled before save_record." };
}

// ---------------------------------------------------------------------------
// sn_check_duplicate — does a record already exist? Call BEFORE creating one, so
// the agent never adds a duplicate (the live incident: FOUR copies of the same
// Business Rule accumulated across retries). Queries the Table API through the
// LOGGED-IN UI SESSION (cookie + X-UserToken=g_ck) from the page's MAIN world —
// this succeeds even where the plain REST tool (sn_query_table) 401s under the
// "Basic Auth Restriction" (verified LIVE 2026-07-15: REST 401, session fetch
// 200). Checks by NAME first, then by sys_id if one was provided.
// ---------------------------------------------------------------------------

// MAIN-world: session-authenticated Table API lookup. Self-contained. A sys field
// often TRUNCATES the stored name (e.g. sys_script.name = 40 chars), so an exact
// name= match MISSES a real duplicate — use an anchored STARTSWITH on a
// conservative prefix for long names (verified LIVE: caught all 4 dupes) and fall
// back to exact for short names.
// PERF (2026-09-01): same three defects as sn_query_session, fixed the same way —
// see the PERF note above pageSnQuery. This one was WORSE per frame, because it
// issues up to TWO requests (by name, by sys_id) and awaited them in series, so
// every frame with a g_ck cost two sequential round-trips. Now: the caller picks
// ONE frame, the two lookups run concurrently (they are independent), and both
// carry a timeout. Timeouts matter more here than in a read — this runs on the
// WRITE path, and a stalled duplicate check blocks a record from being created.
async function pageSnFindRecords(table, name, sysId, prefixLen, timeoutMs) {
  try {
    var gck = window.g_ck || null;
    if (!gck) return { hasGck: false };
    var base = window.location.origin + "/api/now/table/" + encodeURIComponent(table);
    var budget = timeoutMs || 20000;
    async function q(query) {
      var url = base + "?sysparm_query=" + encodeURIComponent(query) +
        "&sysparm_fields=sys_id,name&sysparm_limit=20&sysparm_exclude_reference_link=true";
      var init = { headers: { "Accept": "application/json", "X-UserToken": gck }, credentials: "same-origin" };
      try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(budget); } catch (e0) {}
      var r;
      try {
        r = await fetch(url, init);
      } catch (eF) {
        var timedOut = !!(eF && (eF.name === "TimeoutError" || eF.name === "AbortError"));
        return {
          error: timedOut
            ? "TIMEOUT after " + Math.round(budget / 1000) + "s -- the instance did not answer the Table API in time"
            : String((eF && eF.message) || eF)
        };
      }
      if (!r.ok) return { error: "HTTP " + r.status };
      var j = await r.json();
      return { rows: (j && j.result) ? j.result.map(function (x) { return { sys_id: x.sys_id, name: x.name }; }) : [] };
    }
    // Concurrent, not sequential: the two lookups answer different questions and
    // neither depends on the other, so serialising them just doubled the wait.
    var nameQuery = !name ? null
      : (String(name).length > prefixLen ? "nameSTARTSWITH" + String(name).slice(0, prefixLen) : "name=" + name);
    var pair = await Promise.all([
      nameQuery ? q(nameQuery) : null,
      sysId ? q("sys_id=" + sysId) : null
    ]);
    var out = { hasGck: true, table: table };
    if (pair[0]) out.byName = pair[0];
    if (pair[1]) out.bySysId = pair[1];
    return out;
  } catch (e) {
    // hasGck must be set here: the caller keys "is this a ServiceNow page?" off it,
    // so a bare {error} made a genuine exception LOOK like a missing UI session and
    // told the user to go open a ServiceNow form they were already on.
    return { hasGck: true, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// sn_query_session — query ANY table through the logged-in UI session (g_ck),
// so the agent can read SIBLING / related records (e.g. OTHER active Business
// Rules on the same table to find ordering conflicts or overlapping logic —
// exactly the instance-wide breadth AWF gets from its SN MCP). Bypasses the
// REST 401 the plain sn_query_table tool hits under a Basic-Auth Restriction.
// READ-ONLY; results are citable evidence.
//
// PERF (2026-09-01 — live customer rm_story run, owner: "why does this always take
// forever?"). Three unbounded costs, all fixed here:
//   1. FAN-OUT. The whole fetch ran under `allFrames: true`, so EVERY frame with
//      a g_ck fired the SAME Table API request (a Next Experience form is top
//      document + gsft_main + embedded iframes) and the result-picker then threw
//      all but one away. executeScript resolves only when every frame settles,
//      so the tool cost the SLOWEST duplicate. Now: probe for g_ck with no
//      network, then query from ONE frame.
//   2. REQUEST SHAPE. `sysparm_display_value=all` was hardcoded, making SN
//      resolve value + display_value for every field — a record read plus an ACL
//      pass per reference. Default is now `true` (byte-identical agent-visible
//      output after the flatten below, cheaper on the instance) and callers that
//      need raw reference sys_ids can ask for `false`.
//   3. NO CEILING. Neither the in-page fetch nor the injection had a timeout, so
//      a slow instance parked the agent until the user hit Stop. Both are now
//      bounded and fail with an actionable message.
// ---------------------------------------------------------------------------

const SN_DISPLAY_VALUE_MODES = new Set(["true", "false", "all"]);
const SN_QUERY_FETCH_TIMEOUT_MS = 25000;
const SN_QUERY_PROBE_TIMEOUT_MS = 10000;

const SN_DUPE_FETCH_TIMEOUT_MS = 20000;
const SN_NO_SESSION_DUPE_ERROR = "No ServiceNow UI session (g_ck) on this page — open a ServiceNow classic form or list first, then retry the duplicate check. Do NOT create the record until the check has actually run.";

const SN_NO_SESSION_ERROR = "No ServiceNow UI session (g_ck) on this page — the ACTIVE tab is not a logged-in ServiceNow page. Fix: navigate the active tab to any classic ServiceNow page on the target instance (e.g. <origin>/incident_list.do), then RETRY sn_query_session — it will now work and return structured records (sys_id, number, fields) in ONE call. PREFER that retry over navigate + read_page UI-scraping: sn_query_session gives clean field values and exact sys_ids, whereas scraping the list page is slower and returns unstructured text. (If list_tabs shows a logged-in instance tab, navigate the active tab to that instance's origin first.)";

// Bound an executeScript round-trip. Same degrade-on-timeout contract as
// tools.js `withDeadline` (the 2026-07-27 frame-discovery hang fix) — resolve
// with `fallback` rather than rejecting — but kept LOCAL because editors.js is a
// leaf module and tools.js imports FROM it; sharing would make the pair circular.
function snWithDeadline(p, ms, fallback) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    Promise.resolve(p).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

// MAIN-world, NO NETWORK: does this frame carry a UI session token? Deliberately
// trivial — it exists so the expensive query runs in one frame, not all of them.
function pageSnHasGck() {
  try { return { hasGck: !!window.g_ck, origin: window.location.origin }; }
  catch (e) { return { hasGck: false }; }
}

// Pick the single frame to query from: the top document when it holds a session,
// otherwise the lowest-numbered frame that does (gsft_main on a classic-wrapped
// form). Returns { frameId: null } when the tab has no ServiceNow session at all.
// A stalled probe degrades to the top frame (`degraded: true`) exactly as
// frameIdsWithContent degrades to [0] — attempting the query beats refusing it,
// and the caller uses the flag to pick the right error text if frame 0 has no g_ck.
async function resolveSnSessionFrame(tabId) {
  let probe;
  try {
    probe = await snWithDeadline(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN", func: pageSnHasGck
      }).catch(() => null),
      SN_QUERY_PROBE_TIMEOUT_MS, null
    );
  } catch (e) { return { error: `Cannot reach the page: ${e.message}` }; }
  if (!probe) return { frameId: 0, degraded: true };
  const withGck = probe
    .filter((p) => p && p.result && p.result.hasGck)
    .map((p) => ({ frameId: p.frameId == null ? 0 : p.frameId, origin: p.result.origin }));
  if (!withGck.length) return { frameId: null };
  const top = withGck.find((f) => f.frameId === 0);
  const pick = top || withGck.reduce((a, b) => (b.frameId < a.frameId ? b : a));
  return { frameId: pick.frameId, origin: pick.origin, sessionFrames: withGck.length };
}

async function pageSnQuery(table, query, fields, limit, displayValue, timeoutMs) {
  try {
    var gck = window.g_ck || null;
    if (!gck) return { hasGck: false };
    var url = window.location.origin + "/api/now/table/" + encodeURIComponent(table) +
      "?sysparm_query=" + encodeURIComponent(query || "") +
      (fields ? "&sysparm_fields=" + encodeURIComponent(fields) : "") +
      "&sysparm_limit=" + (limit || 20) +
      "&sysparm_display_value=" + encodeURIComponent(displayValue || "true") +
      "&sysparm_exclude_reference_link=true";
    var budget = timeoutMs || 25000;
    var init = { headers: { "Accept": "application/json", "X-UserToken": gck }, credentials: "same-origin" };
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(budget); } catch (e0) {}
    var r;
    var t0 = Date.now();
    try {
      r = await fetch(url, init);
    } catch (eF) {
      var timedOut = !!(eF && (eF.name === "TimeoutError" || eF.name === "AbortError"));
      return {
        hasGck: true, timedOut: timedOut || undefined, ms: Date.now() - t0,
        error: timedOut
          ? "TIMEOUT after " + Math.round(budget / 1000) + "s -- the instance did not answer the Table API in time. " +
            "This is an INSTANCE SPEED problem, not a wrong table/query: do NOT rewrite the arguments. " +
            "Retry ONCE with a smaller limit and fewer fields, and pass display_value:'false' to skip reference resolution."
          : String((eF && eF.message) || eF)
      };
    }
    var elapsed = Date.now() - t0;
    if (!r.ok) {
      // Surface ServiceNow's own error text (e.g. "Invalid table sc_cat_item_variable")
      // -- a bare "HTTP 400" gave the model nothing to self-correct on and it
      // retried the same wrong table 5x (run 2026-08-18 13:25).
      var detail = "";
      try { var ej = await r.json(); detail = (ej && ej.error && (ej.error.message || ej.error.detail)) ? String(ej.error.message || "") + (ej.error.detail ? " -- " + String(ej.error.detail) : "") : ""; } catch (e2) {}
      return { hasGck: true, ms: elapsed, error: "HTTP " + r.status + (detail ? " (" + detail.slice(0, 300) + ")" : ""), status: r.status };
    }
    var j = await r.json();
    // display_value=true (the default) already returns flat display strings;
    // display_value=all returns {value, display_value} per field. Flatten either
    // shape so the agent always gets readable, citable strings. display_value=false
    // returns raw stored values (reference fields come back as sys_ids) — also flat.
    var rows = (j && j.result) ? j.result.map(function (rec) {
      var o = {};
      for (var k in rec) {
        var v = rec[k];
        o[k] = (v && typeof v === "object") ? (v.display_value !== undefined && v.display_value !== "" ? v.display_value : v.value) : v;
      }
      return o;
    }) : [];
    return { hasGck: true, rows: rows, ms: elapsed };
  } catch (e) { return { hasGck: true, error: String((e && e.message) || e) }; }
}

export async function snQuerySession(tabId, opts) {
  const table = opts && opts.table;
  if (!table) return { error: "table is required (e.g. 'sys_script' for Business Rules)." };
  const query = (opts && opts.query) || "";
  const fields = (opts && opts.fields) || "";
  const limit = Math.min(50, Math.max(1, Number(opts && opts.limit) || 20));
  const displayValue = SN_DISPLAY_VALUE_MODES.has(String(opts && opts.display_value))
    ? String(opts.display_value) : "true";

  // ONE frame, not all of them (see the PERF note on this section). The probe does
  // no network, so this extra round-trip is far cheaper than the N-1 duplicate
  // Table API requests it replaces.
  const frame = await resolveSnSessionFrame(tabId);
  if (frame.error) return { error: frame.error };
  if (frame.frameId == null) return { error: SN_NO_SESSION_ERROR };

  let results;
  try {
    results = await snWithDeadline(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] }, world: "MAIN",
        func: pageSnQuery,
        args: [String(table), String(query), String(fields), limit, displayValue, SN_QUERY_FETCH_TIMEOUT_MS]
      }),
      SN_QUERY_FETCH_TIMEOUT_MS + 5000, null
    );
  } catch (e) { return { error: `Cannot reach the page: ${e.message}` }; }
  const r = (results || []).map((x) => x && x.result).find(Boolean) || null;
  if (!r) return { error: `The ServiceNow frame that held the UI session (frame ${frame.frameId}) never answered — the injection stalled or the frame navigated mid-query. This is an INSTANCE/PAGE speed problem, not a wrong table or query: do NOT rewrite the arguments. Retry sn_query_session once with a smaller limit.` };
  // The probe saw g_ck in this frame a moment ago; if it is gone now the frame
  // reloaded between the two injections. When the probe was SKIPPED (degraded),
  // frame 0 simply may not be a ServiceNow page at all — say that instead.
  if (!r.hasGck || (!r.rows && !r.error)) {
    return frame.degraded
      ? { error: SN_NO_SESSION_ERROR }
      : { error: `The ServiceNow UI session disappeared from frame ${frame.frameId} between the session probe and the query — the frame reloaded mid-call. Retry sn_query_session once (it re-picks the frame).` };
  }
  if (r.error) {
    let hint = "";
    if (/HTTP 401/.test(r.error)) hint = " (the user may lack read access to " + table + ").";
    else if (/HTTP 403/.test(r.error) && /Field\(s\) present in the query/i.test(r.error)) {
      // NOT an ACL problem. ServiceNow's strict-query mode returns exactly this 403 when
      // sysparm_query names a field that does NOT EXIST on the table (run 2026-08-18
      // 13:34: `questionLIKEStart Date` on item_option_new -- real field is
      // question_text -- retried 12x with ever-shorter `fields`, which never touches
      // the query). Tell the model which side is wrong and how to find the real name.
      const fld = SN_FIELD_ALIAS_HINTS.find((h) => h.table.test(String(table)) && h.re.test(String(query)));
      hint = " -- HTTP 403 'Field(s) present in the query' = a FIELD NAME IN YOUR QUERY DOES NOT EXIST on " + table +
        " (it is NOT a permissions problem, and changing `fields` will never fix it -- the bad name is in `query`). Do NOT retry with the same query." +
        (fld ? " HINT: " + fld.hint : " Find the real field name via sn_query_session on sys_dictionary (query: name=" + table + "^elementLIKE<guess> , fields: element,column_label,internal_type).");
    }
    else if (/HTTP 400/.test(r.error) || /Invalid table/i.test(r.error)) {
      // A 400 from the Table API almost always means the TABLE NAME is wrong (or a
      // field in the query does not exist). Do NOT retry the same call -- fix the name.
      const alias = SN_TABLE_ALIAS_HINTS.find((h) => h.re.test(String(table)));
      hint = " -- HTTP 400 = bad table name or unknown field in the query. Do NOT retry with the same arguments; correct the table/field first." +
        (alias ? " HINT: '" + table + "' is not a ServiceNow table -- " + alias.hint : " If unsure of the table name, query sys_db_object (query: name=<guess> or labelLIKE<words>) to find it.");
    }
    return { error: "Session query failed: " + r.error + hint };
  }
  // `query_ms` is the in-page Table API time only (not injection overhead). It is
  // here so a slow instance is VISIBLE in the transcript instead of looking like
  // the agent stalled — the whole reason this tool felt like it hung.
  const out = {
    ok: true, table, query, display_value: displayValue,
    count: r.rows.length, records: r.rows,
    query_ms: r.ms
  };
  // Classic-workflow activity INPUTS are not on wf_activity (2026-09-02 STRY0000001
  // run: 30+ calls chasing advanced_script through wf_activity/wf_activity_variable
  // that all came back empty). Say where they are on the FIRST such query.
  const wfHint = wfActivityQueryHint(table, fields, query);
  if (wfHint) out.hint = wfHint;
  return out;
}

// SN_TABLE_ALIAS_HINTS / SN_FIELD_ALIAS_HINTS moved to sn-hints.js (2026-09-02) so
// the REST tools in sn-tools.js give the same self-correction hints as the session
// tools here. Imported at the top of this file.

export async function snCheckDuplicate(tabId, opts) {
  const table = opts && opts.table;
  const name = opts && opts.name;
  const sysId = opts && opts.sysId;
  if (!table) return { ok: false, error: "table is required — the record's own table (e.g. sys_script for a Business Rule, sys_ui_action for a UI Action)." };
  if (!name && !sysId) return { ok: false, error: "Provide name and/or sys_id to check for a duplicate." };

  // ONE frame, not all of them (see the PERF note on pageSnFindRecords).
  const frame = await resolveSnSessionFrame(tabId);
  if (frame.error) return { ok: false, error: frame.error };
  if (frame.frameId == null) return { ok: false, error: SN_NO_SESSION_DUPE_ERROR };

  let results;
  try {
    results = await snWithDeadline(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] }, world: "MAIN",
        func: pageSnFindRecords,
        args: [String(table), name ? String(name) : "", sysId ? String(sysId) : "", 30, SN_DUPE_FETCH_TIMEOUT_MS]
      }),
      SN_DUPE_FETCH_TIMEOUT_MS + 5000, null
    );
  } catch (e) { return { ok: false, error: `Cannot reach the page: ${e.message}` }; }
  const r = (results || []).map((x) => x && x.result).find(Boolean) || null;
  // FAIL CLOSED. This guards the write path: "I could not check" must never read
  // as "no duplicate exists", or the agent creates the fifth copy of a Business
  // Rule — the exact incident this tool was written to prevent.
  if (!r) {
    return { ok: false, error: `The duplicate check could not run — the ServiceNow frame holding the UI session (frame ${frame.frameId}) never answered. Do NOT create the record: you have no evidence it is absent. Retry sn_check_duplicate; if it fails again, look for the record in the UI before creating anything.` };
  }
  if (!r.hasGck) {
    return { ok: false, error: SN_NO_SESSION_DUPE_ERROR };
  }
  if (r.error) return { ok: false, error: "Duplicate check failed: " + r.error + (/HTTP 401/.test(r.error) ? " (even the session query was denied — the user may lack read access to " + table + ")." : "") + " This is NOT evidence that the record is absent — do NOT create it on the strength of a failed check." };
  const nameRows = (r.byName && r.byName.rows) || [];
  const nameErr = r.byName && r.byName.error;
  const idRow = (r.bySysId && r.bySysId.rows && r.bySysId.rows[0]) || null;
  const idErr = r.bySysId && r.bySysId.error;
  const duplicate = nameRows.length > 0 || !!idRow;
  const first = nameRows[0] || idRow;

  // FAIL CLOSED on a partial check (2026-09-01). A lookup that ERRORED returns no
  // rows, and the old code fed that straight into `duplicate` — so a 401, a 500 or
  // (now that fetches time out) a slow instance produced the verdict "No existing
  // record matched — safe to create", with the real reason parked in a sibling
  // field the model had no reason to read. That is how you get the fifth copy of a
  // Business Rule. A lookup only counts as evidence of ABSENCE if it succeeded.
  const failed = [];
  if (name && nameErr) failed.push("by name (" + nameErr + ")");
  if (sysId && idErr) failed.push("by sys_id (" + idErr + ")");
  // A duplicate that WAS found is conclusive on its own — report it even if the
  // other lookup failed. Absence is the only verdict that needs a clean check.
  const inconclusive = !duplicate && failed.length > 0;

  const base = {
    table, duplicate: inconclusive ? null : duplicate,
    checked_by: [name && !nameErr ? "name" : null, sysId && !idErr ? "sys_id" : null].filter(Boolean),
    name_matches: name ? nameRows : undefined,
    name_query_error: nameErr || undefined,
    sys_id_match: sysId ? (idRow || null) : undefined,
    sys_id_query_error: idErr || undefined
  };

  if (inconclusive) {
    return {
      ok: false, ...base, inconclusive: true,
      error: "DUPLICATE CHECK INCONCLUSIVE — the lookup " + failed.join(" and ") + " did not complete, so this is NOT evidence that the record is absent. " +
        "Do NOT create the record on the strength of this result. Retry sn_check_duplicate once; if it fails again, search for '" + (name || sysId) + "' in the " + table +
        " list in the UI and decide from what you see there."
    };
  }
  return {
    ok: true, ...base,
    summary: duplicate
      ? "DUPLICATE FOUND — " + nameRows.length + " record(s) already match by name" + (idRow ? " and the sys_id exists" : "") +
        ". Do NOT create a new record; open the existing one (sys_id " + (first && first.sys_id) + ") and update it instead." +
        (failed.length ? " (The " + failed.join(" and ") + " lookup failed, but the match above is conclusive.)" : "")
      : "No existing record matched — safe to create."
  };
}

/* theme-boot.js - applies the saved Appearance (System / Light / Dark) before first paint.
   Classic script (not a module) loaded in <head> of every extension page, so the page never
   flashes the wrong theme. chrome.storage.sync `uiTheme` (its own top-level key, never inside
   the settings object, so a theme change can never rewrite or undo other settings) is the
   source of truth; localStorage `agTheme` is a same-origin cache shared by the side panel,
   Settings and pop-outs. "system" removes data-theme so theme.css follows prefers-color-scheme.
   Every applied value is announced as window event "ag-theme-applied" (detail = value) so
   menus can follow a late sync correction. Author: iDevOpsLLC */
(function () {
  var KEY = "agTheme";
  var SYNC_KEY = "uiTheme";
  var MIGRATED_KEY = "uiThemeMigrated";
  var held = false; // Settings holds its unsaved preview so a change made elsewhere does not repaint it

  function normalize(v) { return v === "light" || v === "dark" ? v : "system"; }

  function apply(v) {
    var root = document.documentElement;
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
  }

  function announce(v) {
    try { window.dispatchEvent(new CustomEvent("ag-theme-applied", { detail: v })); } catch (e) { /* old browser */ }
  }

  function read() {
    try { return normalize(localStorage.getItem(KEY)); } catch (e) { return "system"; }
  }

  function setLocal(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: still apply for this page */ }
    if (!held) apply(v);
    announce(v);
  }

  apply(read());

  window.__agGetTheme = read;
  // Apply on this page and the shared cache only (no sync write).
  window.__agSetTheme = function (next) { setLocal(normalize(next)); };
  // While held, stored changes from other pages update the cache but not this page's rendering.
  window.__agHoldThemePreview = function (on) {
    held = !!on;
    if (!held) apply(read());
  };
  // Apply and store the choice in its own sync key. Resolves when the write finished; rejects on failure.
  window.__agSaveTheme = function (next) {
    var v = normalize(next);
    setLocal(v);
    return new Promise(function (resolve, reject) {
      try {
        if (!(window.chrome && chrome.storage && chrome.storage.sync)) { resolve(v); return; }
        var o = {}; o[SYNC_KEY] = v;
        chrome.storage.sync.set(o, function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message || "theme could not be saved")); else resolve(v);
        });
      } catch (e) { reject(e); }
    });
  };

  // Another extension page changed the cached theme.
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    var v = normalize(e.newValue);
    if (!held) apply(v);
    announce(v);
  });

  // Resync from the source of truth (a cleared cache, or a change made while this page was closed).
  // An explicit uiTheme always wins. If none exists yet, a Light/Dark value from the short-lived
  // settings.theme field is copied once (marker written so a later delete means System, never the
  // old value). A missing key otherwise means System, which also resets a stale cached Light/Dark.
  try {
    if (window.chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get([SYNC_KEY, MIGRATED_KEY, "settings"], function (r) {
        r = r || {};
        var t;
        if (r[SYNC_KEY] === undefined && !r[MIGRATED_KEY]) {
          var legacy = r.settings && r.settings.theme;
          t = normalize(legacy);
          var o = {}; o[MIGRATED_KEY] = true;
          if (t !== "system") o[SYNC_KEY] = t;
          chrome.storage.sync.set(o, function () { void (chrome.runtime && chrome.runtime.lastError); }); // best effort; retried next load
        } else {
          t = normalize(r[SYNC_KEY]);
        }
        if (t !== read()) setLocal(t); else announce(t);
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "sync" || !changes[SYNC_KEY]) return;
        var t = normalize(changes[SYNC_KEY].newValue);
        if (t !== read()) setLocal(t);
      });
    }
  } catch (e) { /* not running as an extension page (tests, file://) */ }
})();

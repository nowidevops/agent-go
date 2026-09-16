// collapsible.js — Settings page: every category collapsible, collapsed by default (owner
// directive 2026-09-12, both Agent Go and Agent Go Private). Progressive enhancement over the
// existing markup: nothing moves ids, nothing changes what options.js reads or saves.
//
//   - Every <h2> inside a .card becomes a toggle for the siblings that follow it (up to the
//     next <h2>). Content that sits BEFORE a card's first <h2> stays visible (card lead-in).
//   - Every .packGroupTitle becomes a toggle for the rest of its group (nested groups work,
//     e.g. the REAL-MONEY section inside the paper trading group).
//   - The Save / Reset row is never folded away.
//   - A focused field (validation errors, Tab navigation) or a #hash deep link expands its
//     ancestors, so nothing the user is sent to can be hidden.
//   - No persistence: the page opens collapsed every time, by design.
//
// Author: iDevOpsLLC

const BODY_CLASS = "cat-body";
const HEAD_CLASS = "cat-head";

function isActionsRow(el) {
  return !!(el && el.querySelector && (el.querySelector("#save") || el.querySelector("#reset") || el.id === "save" || el.id === "reset"));
}

function wrapFollowing(head, stopAt) {
  const body = document.createElement("div");
  body.className = BODY_CLASS;
  let n = head.nextSibling;
  while (n) {
    const next = n.nextSibling;
    if (n.nodeType === 1 && (stopAt(n) || isActionsRow(n))) break;
    body.appendChild(n);
    n = next;
  }
  head.after(body);
  return body;
}

function makeToggle(head, body) {
  head.classList.add(HEAD_CLASS);
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", "false");
  const chev = document.createElement("span");
  chev.className = "cat-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.textContent = "▸";
  head.prepend(chev);
  body.hidden = true;
  const set = (open) => {
    body.hidden = !open;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    chev.textContent = open ? "▾" : "▸";
  };
  head.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("a,button,input,select,textarea")) return; // controls inside a title keep working
    set(body.hidden);
  });
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(body.hidden); }
  });
  head._catSet = set;
}

export function expandAncestors(el) {
  let n = el;
  while (n && n !== document.body) {
    if (n.classList && n.classList.contains(BODY_CLASS) && n.hidden) {
      const head = n.previousElementSibling;
      if (head && head._catSet) head._catSet(true);
    }
    n = n.parentElement;
  }
}

export function initCollapsibleSettings() {
  if (document.documentElement.dataset.collapsibleInit) return;
  document.documentElement.dataset.collapsibleInit = "1";
  const style = document.createElement("style");
  style.textContent = `
    .${HEAD_CLASS} { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; }
    .${HEAD_CLASS}:focus-visible { outline: 2px solid var(--accent-blue, #569CD6); outline-offset: 2px; border-radius: 4px; }
    .${HEAD_CLASS} .cat-chev { display: inline-block; width: 12px; color: var(--text-secondary, #808080); font-size: 12px; }
    .${BODY_CLASS} { margin-top: 6px; }
    .${BODY_CLASS}[hidden] { display: none !important; }
  `;
  document.head.appendChild(style);

  // 1. Card headings (h2) — including a <details> summary's h2 is left alone: <details> is already collapsible.
  document.querySelectorAll(".card").forEach((card) => {
    if (card.tagName === "DETAILS") return;
    const heads = Array.from(card.querySelectorAll(":scope > h2"));
    heads.forEach((h) => {
      const body = wrapFollowing(h, (n) => n.tagName === "H2");
      makeToggle(h, body);
    });
  });

  // 2. Pack groups — the title toggles the rest of its parent (nested titles handled by document order).
  document.querySelectorAll(".packGroupTitle").forEach((title) => {
    if (title.classList.contains(HEAD_CLASS)) return;
    const body = wrapFollowing(title, (n) => n.classList && n.classList.contains("packGroupTitle"));
    makeToggle(title, body);
  });

  // 3. Never hide what the user was sent to.
  document.addEventListener("focusin", (e) => { if (e.target) expandAncestors(e.target); });
  const openHash = () => {
    const id = (location.hash || "").slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    expandAncestors(el);
    const head = el.querySelector && el.querySelector(":scope > h2." + HEAD_CLASS);
    if (head && head._catSet) head._catSet(true);
  };
  window.addEventListener("hashchange", openHash);
  openHash();
}

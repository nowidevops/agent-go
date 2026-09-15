// scheduler.js — chrome.alarms engine for scheduled shortcuts ("Schedule task").
// Author: iDevOpsLLC
//
// MV3 constraint: alarms fire only while Chrome is running. A "once" task whose
// time passes while Chrome is closed fires at the next launch (chrome.alarms keeps
// it) or — if computeNextFire now reports it as past — is skipped on the next sync.
// We never run an agent turn headlessly: a fired alarm enqueues a PENDING run and
// (a) wakes an open side panel to run it visibly, or (b) badges the icon so the
// user opens the panel, which then drains and runs the queue.
// OS toast REMOVED 2026-08-20 (was already gated off 08-18): recurring schedules
// (e.g. /trade-cycle) made it a nag. The action badge is the only closed-panel signal.

import { getShortcuts, computeNextFire, isWithinWindow } from "./shortcuts.js";

const ALARM_PREFIX = "sched:";
const PENDING_KEY = "scheduledPending"; // chrome.storage.local: [{ scId, name, firedAt }]

// Rebuild every schedule alarm from the current shortcut list. Called on install,
// on startup, and whenever the shortcuts change. Idempotent: clears our alarms
// first, then recreates one per enabled+fireable schedule. Returns the count set.
export async function syncAlarms() {
  try {
    const existing = await chrome.alarms.getAll();
    await Promise.all(
      existing.filter((a) => a.name.startsWith(ALARM_PREFIX)).map((a) => chrome.alarms.clear(a.name))
    );
  } catch { /* alarms API unavailable — nothing to clear */ }

  const list = await getShortcuts();
  let n = 0;
  for (const sc of list) {
    if (!sc.schedule || !sc.schedule.enabled) continue;
    const when = computeNextFire(sc.schedule);
    if (when == null) continue; // e.g. a one-time schedule already in the past
    const opts = { when };
    // interval: let chrome.alarms repeat it natively (no per-fire reschedule).
    if (sc.schedule.recurrence === "interval") {
      const p = parseInt(sc.schedule.intervalMinutes, 10);
      if (p >= 1) opts.periodInMinutes = p;
    }
    try { await chrome.alarms.create(ALARM_PREFIX + sc.id, opts); n++; } catch {}
  }
  return n;
}

// Handle a fired alarm: enqueue the run, reschedule (recurring) or disable (once),
// then wake the panel or badge+notify. Returns true if it was one of our alarms.
export async function handleAlarm(alarm) {
  if (!alarm || !alarm.name || !alarm.name.startsWith(ALARM_PREFIX)) return false;
  const scId = alarm.name.slice(ALARM_PREFIX.length);

  const list = await getShortcuts();
  const sc = list.find((s) => s.id === scId);
  if (!sc || !sc.schedule || !sc.schedule.enabled) return true; // deleted/disabled since scheduling

  // Interval schedules may carry an active-hours window and a calendar-day filter
  // (weekdays / market days). The native periodic alarm keeps firing around the
  // clock; skip any fire outside the window or on an off day (it stays armed and
  // resumes when the window reopens). Daily schedules honour the day filter too —
  // a skipped daily fire still falls through to reschedule its next occurrence.
  const active = isWithinWindow(sc.schedule);
  if (sc.schedule.recurrence === "interval" && !active) return true;

  if (active) await enqueuePending({ scId, name: sc.name, firedAt: Date.now() });

  if (sc.schedule.recurrence === "once") {
    // One-shot: disable it so a browser restart can't refire the same task.
    sc.schedule.enabled = false;
    try { await chrome.storage.local.set({ shortcuts: list }); } catch {}
  } else if (sc.schedule.recurrence === "interval") {
    // Periodic alarm repeats itself (periodInMinutes) — nothing to reschedule.
  } else {
    // Recurring (daily/weekly): schedule the next occurrence. Compute from a moment
    // AFTER now so the job can't recompute to the same instant and double-fire.
    const next = computeNextFire(sc.schedule, Date.now() + 60_000);
    if (next != null) { try { await chrome.alarms.create(alarm.name, { when: next }); } catch {} }
  }

  if (!active) return true; // nothing enqueued (off day) — no wake/badge

  // Wake an open panel; if there's no receiver, the panel is closed → badge + a
  // desktop notification (Agent Go has the notifications permission; Local LLM doesn't).
  let delivered = false;
  try { await chrome.runtime.sendMessage({ type: "scheduled_pending" }); delivered = true; }
  catch { /* no receiver = side panel not open */ }
  await refreshBadge();
  if (!delivered) notify(sc.name);
  return true;
}

async function enqueuePending(entry) {
  const got = await chrome.storage.local.get(PENDING_KEY);
  const q = Array.isArray(got[PENDING_KEY]) ? got[PENDING_KEY] : [];
  q.push(entry);
  await chrome.storage.local.set({ [PENDING_KEY]: q });
}

// Account switch (2026-09-02): drop queued scheduled runs that belong to the previous
// account so the next sign-in never executes another owner's shortcut, and rebuild the
// alarms from the (now current) owner's list — getShortcuts() is owner-scoped.
export async function resetForAccountChange() {
  try { await chrome.storage.local.set({ [PENDING_KEY]: [] }); } catch {}
  await refreshBadge();
  return syncAlarms();
}

// Atomically read AND clear the pending queue (the panel calls this, then runs
// each entry visibly). Clearing the badge here too.
export async function drainPending() {
  const got = await chrome.storage.local.get(PENDING_KEY);
  const q = Array.isArray(got[PENDING_KEY]) ? got[PENDING_KEY] : [];
  await chrome.storage.local.set({ [PENDING_KEY]: [] });
  await refreshBadge();
  return q;
}

async function peekPendingCount() {
  const got = await chrome.storage.local.get(PENDING_KEY);
  return Array.isArray(got[PENDING_KEY]) ? got[PENDING_KEY].length : 0;
}

async function refreshBadge() {
  const n = await peekPendingCount();
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#C586C0" }); // accent-purple, matches sub-agent panels
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  } catch {}
}

function notify(name) {
  try {
    chrome.notifications.create("sched-" + name + "-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Scheduled task ready",
      message: `"/${name}" is queued. Open the Agent Go side panel to run it.`,
      priority: 1
    });
  } catch {}
}

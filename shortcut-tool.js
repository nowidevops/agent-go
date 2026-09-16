// shortcut-tool.js — the agent's own door into the extension's "/" shortcuts and
// their schedules (create_shortcut / list_shortcuts), 2026-09-08a.
//
// Why: the resume-tailoring run (owner export 2026-09-08 01:00) asked "Open the
// shortcuts panel, create /jobwatch, Weekdays, 8:00, active hours 8 to 9, with
// this prompt: …". The model had no tool for that, so it hunted the page for a
// "Shortcuts" button (found only "Submit application"), then tried read_page on
// chrome-extension://…/options.html, which Chrome refuses. Four turns, nothing
// saved. Shortcuts live in chrome.storage, not on any page; this module writes
// them the same way the Options form does (saveShortcut + syncAlarms) and can
// open Settings scrolled to the new entry so the user sees the schedule UI.
//
// The schedule builder is pure so node shortcut-tool.test.mjs can pin it.
// Author: iDevOpsLLC

import { getShortcuts, saveShortcut, normalizeSchedule, computeNextFire, formatSchedule, slug, RECURRENCES, DAY_MODES } from "./shortcuts.js";
import { syncAlarms } from "./scheduler.js";

export const SHORTCUT_TOOL_NAMES = new Set(["create_shortcut", "list_shortcuts"]);

// "8", "8:00", "08:00", "8am", "8:00 AM", "5 p.m.", "17:30" → "HH:MM" (24h); "" when unparseable.
export function parseClock(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23) return String(v).padStart(2, "0") + ":00";
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i.exec(String(v));
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const mer = (m[3] || "").toLowerCase().replace(/\./g, "");
  if (mm > 59) return "";
  if (mer) {
    if (h < 1 || h > 12) return "";
    if (mer === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return "";
  return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

// "weekdays" / "Mon–Fri" / "workdays" → "weekdays"; "market days" / "trading days" → "market"; else "all".
export function normalizeDays(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "all";
  if (DAY_MODES.includes(s)) return s;
  if (/market|trading|nyse|exchange/.test(s)) return "market";
  if (/week ?days?|mon\w*\s*(-|–|to|through)\s*fri|work ?days?|business/.test(s)) return "weekdays";
  return "all";
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// "Monday" / "mon" / 1 → 1; null when not a single day.
export function normalizeWeekday(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  const s = String(v).trim().toLowerCase().slice(0, 3);
  const i = WEEKDAYS.indexOf(s);
  return i >= 0 ? i : null;
}

// Flat tool args → { schedule (raw, for saveShortcut) | null, label, notes[] } or { error }.
// Precedence: an explicit `recurrence` wins; otherwise the kind is inferred from the
// fields given (date → once, interval/active hours → interval, weekday → weekly,
// time → daily, nothing → manual). "Weekdays, 8:00, active hours 8 to 9" therefore
// lands as: every 60 min, 8:00 AM–9:00 AM, weekdays — the exact combination the
// Options form offers (active hours exist only on the "Every…" recurrence).
export function buildScheduleFromArgs(a = {}) {
  const notes = [];
  const time = parseClock(a.time);
  const ws = parseClock(a.window_start);
  const we = parseClock(a.window_end);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || "").trim()) ? String(a.date).trim() : "";
  const interval = parseInt(a.interval_minutes, 10);
  const hasInterval = Number.isInteger(interval) && interval >= 1;
  const hasWindow = !!(ws && we);
  const weekday = normalizeWeekday(a.weekday);
  const days = normalizeDays(a.days);

  if (a.time != null && String(a.time).trim() && !time) return { error: `time "${a.time}" is not a clock time — use "HH:MM" (24h) or "8:00 AM".` };
  if ((a.window_start != null && String(a.window_start).trim() && !ws) || (a.window_end != null && String(a.window_end).trim() && !we)) {
    return { error: `window_start/window_end must both be clock times like "8:00" and "9:00" (got "${a.window_start}" / "${a.window_end}").` };
  }
  if (a.date != null && String(a.date).trim() && !date) return { error: `date "${a.date}" must be YYYY-MM-DD.` };

  let r = String(a.recurrence || "").trim().toLowerCase();
  const explicit = !!r;
  if (["off", "none", "manual", "never", ""].includes(r)) r = explicit ? "off" : "";
  if (["every", "hourly", "minutes", "repeat", "repeating"].includes(r)) r = "interval";
  if (r === "off") return { schedule: null, label: "manual only (no schedule)", notes: ["runs only when the user types /name"] };
  if (r && !RECURRENCES.includes(r)) return { error: `recurrence "${a.recurrence}" is not one of off, once, daily, weekly, interval.` };
  if (!r) {
    if (date) r = "once";
    else if (hasInterval || hasWindow) r = "interval";
    else if (weekday != null) r = "weekly";
    else if (time) r = "daily";
    else return { schedule: null, label: "manual only (no schedule)", notes: ["no schedule fields given — saved as a manual shortcut; add time/days/interval_minutes to schedule it"] };
  }

  if (r === "once" && !date) return { error: "a one-time schedule needs date (YYYY-MM-DD) plus time." };
  if (r !== "interval" && hasWindow) notes.push(`active hours (${ws}–${we}) apply only to an interval schedule and were not saved; the shortcut runs ${r} at ${time || "09:00"}`);
  if (r === "interval" && !hasInterval) notes.push(`no interval_minutes given — runs every 60 min${hasWindow ? ` inside ${ws}–${we}` : ""}`);
  if (r !== "interval" && !time) notes.push("no time given — defaulted to 09:00");
  if (r === "weekly" && weekday == null) notes.push("no weekday given — defaulted to Monday");
  if (r === "weekly" && days !== "all") notes.push("days (weekdays/market) applies to daily/interval only and was not saved");

  const raw = {
    enabled: true,
    recurrence: r,
    date,
    time: time || "09:00",
    weekday: weekday == null ? 1 : weekday,
    intervalMinutes: hasInterval ? interval : 60,
    windowStart: hasWindow ? ws : "",
    windowEnd: hasWindow ? we : "",
    days
  };
  const norm = normalizeSchedule(raw);
  if (!norm) return { error: "that schedule cannot run (the Options form would reject it too) — check the date/time." };
  if (hasWindow && r === "interval" && !norm.windowStart) return { error: `window_end (${we}) must be later than window_start (${ws}).` };
  return { schedule: raw, label: formatSchedule(norm) || "", notes };
}

// One-line schedule text for the approval card / previews (never throws).
export function describeShortcutArgs(args = {}) {
  try {
    const b = buildScheduleFromArgs(args);
    if (b.error) return "schedule: " + b.error;
    return "schedule: " + (b.label || "manual only");
  } catch (e) {
    return "schedule: (unreadable — " + (e && e.message ? e.message : e) + ")";
  }
}

function summarize(sc) {
  const norm = sc.schedule && sc.schedule.enabled ? normalizeSchedule(sc.schedule) : null;
  const next = norm ? computeNextFire(norm) : null;
  return {
    name: "/" + sc.name,
    id: sc.id,
    category: (sc.category || "").trim() || "General",
    schedule: norm ? (formatSchedule(norm) + (next ? "" : " (cannot run — date passed)")) : "manual only",
    next_run: next ? new Date(next).toLocaleString() : null,
    start_from: sc.startFrom || "",
    model: sc.model || "",
    prompt_preview: String(sc.prompt || "").slice(0, 160) + (String(sc.prompt || "").length > 160 ? "…" : "")
  };
}

// Open (or refocus) the extension's Settings page scrolled to the Shortcuts
// section, with ?highlight=<id> so options.js outlines the saved entry.
async function openShortcutsPanel(id) {
  const base = chrome.runtime.getURL("options.html");
  const url = base + (id ? "?highlight=" + encodeURIComponent(id) : "") + "#shortcuts";
  try {
    const open = await chrome.tabs.query({ url: base + "*" });
    if (open && open.length) {
      await chrome.tabs.update(open[0].id, { url, active: true });
      try { await chrome.windows.update(open[0].windowId, { focused: true }); } catch {}
      return { opened: true, reused: true };
    }
  } catch { /* query pattern unsupported — fall through to create */ }
  await chrome.tabs.create({ url, active: true });
  return { opened: true, reused: false };
}

export async function runShortcutTool(name, args = {}, ctx = {}) {
  if (name === "list_shortcuts") {
    let list;
    try { list = await getShortcuts(); } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
    return { count: list.length, shortcuts: list.map(summarize), note: "Run one by typing /name in the side panel; edit or delete in ⚙ Settings → Shortcuts." };
  }
  if (name !== "create_shortcut") return { error: `Unknown shortcut tool "${name}".` };

  const nm = slug(args.name);
  if (!String(args.name || "").trim() || nm === "shortcut") return { error: "create_shortcut needs a name (letters, digits, - or _), e.g. 'jobwatch' for /jobwatch." };
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return { error: "create_shortcut needs the prompt text the shortcut will run." };

  let list;
  try { list = await getShortcuts(); } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
  const existing = list.find((s) => s.name === nm);
  if (existing && !args.replace_existing) {
    return {
      error: `A shortcut /${nm} already exists (${summarize(existing).schedule}). Pass replace_existing:true to update it in place, or choose another name.`,
      existing: summarize(existing)
    };
  }

  const built = buildScheduleFromArgs(args);
  if (built.error) return { error: built.error };

  const rec = {
    id: existing ? existing.id : undefined,
    name: nm,
    prompt,
    startFrom: String(args.start_from || "").trim(),
    model: String(args.model || "").trim(),
    category: String(args.category || "").trim(),
    schedule: built.schedule
  };
  let saved;
  try { saved = await saveShortcut(rec); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
  const sc = existing ? saved.find((s) => s.id === existing.id) : saved[saved.length - 1];
  if (!sc) return { error: "The shortcut was not found after saving — open ⚙ Settings → Shortcuts to check." };

  let armed = null;
  try { armed = await syncAlarms(); } catch { armed = null; }

  let panel = null;
  if (args.show_in_settings) {
    try { panel = await openShortcutsPanel(sc.id); } catch (e) { panel = { opened: false, error: e && e.message ? e.message : String(e) }; }
  }

  const sum = summarize(sc);
  const out = {
    ok: true,
    action: existing ? "updated" : "created",
    name: sum.name,
    id: sc.id,
    category: sum.category,
    schedule: sum.schedule,
    next_run: sum.next_run,
    schedules_armed: armed,
    notes: built.notes,
    run_now: `Type ${sum.name} in the side panel to run it immediately.`,
    where: "⚙ Settings → Shortcuts (/ commands) shows it with its schedule badge."
  };
  if (panel) {
    out.settings_page = panel.opened
      ? `Settings opened at the Shortcuts section with ${sum.name} highlighted. It is an extension page — do NOT call page tools on it; report the saved schedule and next run and finish.`
      : `Could not open Settings automatically (${panel.error}); the shortcut is saved — the user can open ⚙ Settings → Shortcuts.`;
  }
  if (sum.next_run == null && sc.schedule && sc.schedule.enabled) out.warning = "The schedule was saved but cannot fire (its date/time has passed).";
  return out;
}

export const SHORTCUT_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_shortcut",
      description: "Create (or update) one of the extension's OWN '/' shortcuts — a saved prompt the user runs by typing /name in the side panel — optionally on a SCHEDULE. This IS the 'shortcuts panel' / 'schedule a task' / 'scheduler': shortcuts live INSIDE the extension, not on any web page, so NEVER hunt for a shortcuts panel or the Settings page with page tools (chrome-extension:// pages are unreachable) — call this tool. Schedule kinds: daily at `time` (days: all / weekdays / market), weekly on `weekday` at `time`, once on `date` at `time`, or interval every `interval_minutes` limited to active hours `window_start`–`window_end`. Example 'Weekdays, 8:00, active hours 8 to 9' → { days:'weekdays', time:'8:00', window_start:'8:00', window_end:'9:00' } (saved as: every 60 min, 8:00 AM–9:00 AM, weekdays). Omit every schedule field for a manual shortcut. Pass show_in_settings:true when the user asked to OPEN or SEE the shortcuts panel. The result gives the saved name, the schedule exactly as Settings shows it, and the next run — report those verbatim; do not verify with page tools.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Shortcut name WITHOUT the slash, e.g. 'jobwatch' (becomes /jobwatch). Letters, digits, - and _." },
          prompt: { type: "string", description: "The FULL prompt the shortcut runs — the user's text verbatim (never shortened or rephrased)." },
          recurrence: { type: "string", enum: ["off", "once", "daily", "weekly", "interval"], description: "Optional. Omit to infer it from the other fields (date → once; interval_minutes or active hours → interval; weekday → weekly; time only → daily; nothing → manual)." },
          time: { type: "string", description: "Clock time for daily / weekly / once: '08:00', '8:00', '8:00 AM', '17:30'." },
          date: { type: "string", description: "Once only: 'YYYY-MM-DD'." },
          weekday: { type: "string", description: "Weekly only: day name ('Monday') or 0–6 (0 = Sunday)." },
          interval_minutes: { type: "integer", description: "Interval only: run every N minutes (5, 10, 15, 30, 60, 120, 240, 1440…). Default 60 when active hours are given without it." },
          window_start: { type: "string", description: "Interval only: active hours START, e.g. '8:00' — fires only inside the window each allowed day." },
          window_end: { type: "string", description: "Interval only: active hours END, e.g. '9:00' (must be later than window_start)." },
          days: { type: "string", enum: ["all", "weekdays", "market"], description: "Which calendar days may fire (daily / interval): every day, Mon–Fri ('weekdays'), or Mon–Fri minus NYSE holidays ('market')." },
          category: { type: "string", description: "Optional group shown in Settings (e.g. 'Career'). Empty = General." },
          start_from: { type: "string", description: "Optional http(s) URL the shortcut navigates to before running." },
          model: { type: "string", description: "Optional model override for this shortcut. Leave empty for the default." },
          replace_existing: { type: "boolean", description: "true = update an existing /name in place (keeps its id). Default false → an existing name is an error." },
          show_in_settings: { type: "boolean", description: "true = open the extension's Settings page at the Shortcuts section with the saved shortcut highlighted (use when the user asked to open/see the panel). Default false." }
        },
        required: ["name", "prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_shortcuts",
      description: "List the extension's saved '/' shortcuts: name, category, schedule as Settings shows it, next run, and a prompt preview. Read-only, no tab involved. Use it when the user asks what shortcuts or scheduled tasks exist, or before create_shortcut when a name might be taken.",
      parameters: { type: "object", properties: {} }
    }
  }
];

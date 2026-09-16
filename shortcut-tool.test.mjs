// shortcut-tool.test.mjs — the agent can create the extension's own "/" shortcuts
// and schedules with a tool, instead of hunting web pages for a "shortcuts panel".
//
// Live run (owner export 2026-09-08 01:00, resume-tailoring rehearsal): "Open the
// shortcuts panel, create /jobwatch, Weekdays, 8:00, active hours 8 to 9, with this
// prompt: …" — the model searched the application-form page for a Shortcuts
// button (found only "Submit application"), then read_page on
// chrome-extension://…/options.html was refused, and it gave up four turns in a
// row. Same export, turn 3: a research answer that ended on a source URL was judged
// "cut off" (trailing slash), and the model's reply to the continuation prompt —
// "I cannot complete this request because there is no previous message … that was
// cut off" — was appended to the shipped answer.
//
// Pinned here:
//   1. parseClock / normalizeDays / normalizeWeekday accept what people type.
//   2. buildScheduleFromArgs maps the flat tool args to the Options form's schedule
//      shapes; "Weekdays, 8:00, active hours 8 to 9" → every 60 min, 8–9, weekdays.
//   3. executeTool("create_shortcut") saves through saveShortcut, arms the alarm,
//      refuses a duplicate name unless replace_existing, and opens Settings at the
//      new entry only when asked.
//   4. list_shortcuts is read-only and reports the same labels Settings shows.
//   5. looksTruncated ignores a trailing URL; isNonContinuation drops a "nothing was
//      cut off" reply; background.js wires both.
// Run: node shortcut-tool.test.mjs   Author: iDevOpsLLC

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + (typeof extra === "string" ? extra : JSON.stringify(extra)))); };

// ---- chrome mock (must exist BEFORE tools.js is evaluated) --------------------
const store = { llmgo_auth: { email: "tester@example.com", idToken: "t" } }; // Agent Go (free) scopes shortcuts per signed-in owner
const alarms = new Map();
const calls = { alarmCreates: [], tabCreates: [], tabUpdates: [], tabQueries: [] };
let optionsTabs = [];
const OPTIONS_BASE = "chrome-extension://abcdefghijklmnop/";
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => {
        if (k == null) return JSON.parse(JSON.stringify(store));
        const keys = Array.isArray(k) ? k : (typeof k === "object" ? Object.keys(k) : [k]);
        const out = {};
        for (const key of keys) if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
      remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete store[key]; }
    },
    onChanged: { addListener: () => {} }
  },
  alarms: {
    getAll: async () => [...alarms.values()],
    clear: async (name) => alarms.delete(name),
    create: async (name, opts) => { alarms.set(name, { name, ...opts }); calls.alarmCreates.push({ name, ...opts }); }
  },
  runtime: { getURL: (p) => OPTIONS_BASE + p, sendMessage: async () => ({}), lastError: null },
  windows: { update: async () => ({}) },
  tabs: {
    query: async (q) => { calls.tabQueries.push(q); return q && q.url && String(q.url).startsWith(OPTIONS_BASE) ? optionsTabs : [{ id: 7, url: "https://example.com/", status: "complete", active: true, windowId: 1 }]; },
    get: async (id) => ({ id, url: "https://example.com/", status: "complete", active: true, windowId: 1 }),
    create: async (o) => { calls.tabCreates.push(o); const t = { id: 90 + calls.tabCreates.length, windowId: 1, ...o }; optionsTabs = [t]; return t; },
    update: async (id, o) => { calls.tabUpdates.push({ id, ...o }); return { id, ...o }; },
    sendMessage: async () => { throw new Error("Could not establish connection."); },
    onUpdated: { addListener: () => {}, removeListener: () => {} }
  },
  scripting: { executeScript: async () => [] }
};
if (!globalThis.crypto || !globalThis.crypto.randomUUID) globalThis.crypto = { randomUUID: () => "id-" + Math.random().toString(36).slice(2) };

const { parseClock, normalizeDays, normalizeWeekday, buildScheduleFromArgs, describeShortcutArgs, SHORTCUT_TOOLS } = await import("./shortcut-tool.js");
const { computeNextFire, normalizeSchedule, formatSchedule } = await import("./shortcuts.js");
const { looksTruncated, isNonContinuation } = await import("./loop-guards.js");
const { executeTool, validateArgs, TOOLS } = await import("./tools.js");

console.log("\n1. CLOCK / DAYS / WEEKDAY parsing");
{
  const cases = [["8", "08:00"], ["08:00", "08:00"], ["8:00", "08:00"], ["8am", "08:00"], ["8:00 AM", "08:00"], ["5 p.m.", "17:00"], ["17:30", "17:30"], ["12:00 pm", "12:00"], ["12 am", "00:00"], [9, "09:00"], ["", ""], ["noon", ""], ["25:00", ""], ["8:75", ""], ["13 pm", ""]];
  for (const [inp, want] of cases) ok(`parseClock(${JSON.stringify(inp)}) → ${JSON.stringify(want)}`, parseClock(inp) === want, parseClock(inp));
  ok("days: 'Weekdays' → weekdays", normalizeDays("Weekdays") === "weekdays");
  ok("days: 'Mon–Fri' → weekdays", normalizeDays("Mon–Fri") === "weekdays");
  ok("days: 'monday to friday' → weekdays", normalizeDays("monday to friday") === "weekdays");
  ok("days: 'market days' → market", normalizeDays("market days") === "market");
  ok("days: '' → all", normalizeDays("") === "all");
  ok("days: 'every day' → all", normalizeDays("every day") === "all");
  ok("weekday: 'Friday' → 5", normalizeWeekday("Friday") === 5);
  ok("weekday: 'mon' → 1", normalizeWeekday("mon") === 1);
  ok("weekday: 0 → 0", normalizeWeekday(0) === 0);
  ok("weekday: '3' → 3", normalizeWeekday("3") === 3);
  ok("weekday: 'weekdays' → null", normalizeWeekday("weekdays") === null);
}

console.log("\n2. buildScheduleFromArgs — flat args → the Options form's schedule shapes");
{
  const job = buildScheduleFromArgs({ days: "weekdays", time: "8:00", window_start: "8:00", window_end: "9:00" });
  ok("jobwatch phrase → no error", !job.error, job);
  ok("→ interval recurrence (active hours exist only there)", job.schedule && job.schedule.recurrence === "interval", job.schedule);
  ok("→ every 60 min by default", job.schedule && job.schedule.intervalMinutes === 60);
  ok("→ window 08:00–09:00", job.schedule && job.schedule.windowStart === "08:00" && job.schedule.windowEnd === "09:00");
  ok("→ weekdays", job.schedule && job.schedule.days === "weekdays");
  ok("→ label as Settings shows it", job.label === "Every 1 h · 8:00 AM–9:00 AM · weekdays", job.label);
  const norm = normalizeSchedule(job.schedule);
  const tue7 = new Date(2026, 8, 8, 7, 0, 0, 0).getTime();   // Tue 2026-09-08 07:00 local
  const sat = new Date(2026, 8, 12, 12, 0, 0, 0).getTime();  // Sat 2026-09-12
  ok("next fire on a Tuesday at 07:00 = 08:00 that day", computeNextFire(norm, tue7) === new Date(2026, 8, 8, 8, 0, 0, 0).getTime(), new Date(computeNextFire(norm, tue7)).toString());
  ok("next fire on a Saturday = Monday 08:00", computeNextFire(norm, sat) === new Date(2026, 8, 14, 8, 0, 0, 0).getTime(), new Date(computeNextFire(norm, sat)).toString());

  const daily = buildScheduleFromArgs({ recurrence: "daily", days: "weekdays", time: "8:00", window_start: "8", window_end: "9" });
  ok("explicit daily + window → stays daily 08:00 weekdays", daily.schedule && daily.schedule.recurrence === "daily" && daily.schedule.time === "08:00" && daily.schedule.days === "weekdays", daily);
  ok("… and says the window was not saved", daily.notes.some((n) => /active hours/.test(n)), daily.notes);
  ok("… label Daily · 8:00 AM · weekdays", daily.label === "Daily · 8:00 AM · weekdays", daily.label);

  const once = buildScheduleFromArgs({ date: "2027-01-05", time: "9:30" });
  ok("date + time → once", once.schedule && once.schedule.recurrence === "once" && once.schedule.date === "2027-01-05" && once.schedule.time === "09:30", once);
  ok("once without a date → error", /date/.test(buildScheduleFromArgs({ recurrence: "once", time: "9:00" }).error || ""));
  const weekly = buildScheduleFromArgs({ weekday: "friday", time: "17:00" });
  ok("weekday + time → weekly Fri 17:00", weekly.schedule && weekly.schedule.recurrence === "weekly" && weekly.schedule.weekday === 5 && weekly.schedule.time === "17:00", weekly);
  const iv = buildScheduleFromArgs({ interval_minutes: 30, days: "market" });
  ok("interval_minutes 30 + market → interval 30 market days", iv.schedule && iv.schedule.recurrence === "interval" && iv.schedule.intervalMinutes === 30 && iv.schedule.days === "market" && iv.label === "Every 30 min · market days", iv);
  const manual = buildScheduleFromArgs({});
  ok("no schedule fields → manual (null schedule, no error)", manual.schedule === null && !manual.error && /manual/.test(manual.label));
  ok("recurrence off → manual", buildScheduleFromArgs({ recurrence: "off", time: "8:00" }).schedule === null);
  ok("bad time → error names it", /8h/.test(buildScheduleFromArgs({ time: "8h" }).error || ""));
  ok("window end before start → error", /later than/.test(buildScheduleFromArgs({ window_start: "9:00", window_end: "8:00" }).error || ""), buildScheduleFromArgs({ window_start: "9:00", window_end: "8:00" }));
  ok("unknown recurrence → error", /recurrence/.test(buildScheduleFromArgs({ recurrence: "fortnightly" }).error || ""));
  ok("describeShortcutArgs never throws and carries the label", /Every 1 h · 8:00 AM–9:00 AM · weekdays/.test(describeShortcutArgs({ days: "weekdays", window_start: "8:00", window_end: "9:00" })));
}

console.log("\n3. TOOL wiring: schemas exposed, args validated");
{
  const names = TOOLS.map((t) => t.function && t.function.name);
  ok("TOOLS carries create_shortcut", names.includes("create_shortcut"));
  ok("TOOLS carries list_shortcuts", names.includes("list_shortcuts"));
  ok("SHORTCUT_TOOLS schema requires name + prompt", JSON.stringify(SHORTCUT_TOOLS[0].function.parameters.required) === JSON.stringify(["name", "prompt"]));
  ok("description forbids page tools on the Settings page", /chrome-extension/.test(SHORTCUT_TOOLS[0].function.description) && /NEVER/.test(SHORTCUT_TOOLS[0].function.description));
  ok("validateArgs: missing prompt → error", /prompt/.test((validateArgs("create_shortcut", { name: "x" }) || {}).error || ""));
  ok("validateArgs: missing name → error", /name/.test((validateArgs("create_shortcut", { prompt: "x" }) || {}).error || ""));
  ok("validateArgs: long name → error", /too long/.test((validateArgs("create_shortcut", { name: "n".repeat(61), prompt: "x" }) || {}).error || ""));
  const a = { name: "x", prompt: "y", interval_minutes: 999999 };
  ok("validateArgs: interval clamped to a week", validateArgs("create_shortcut", a) == null && a.interval_minutes === 10080, a);
}

const PROMPT = 'Open the three saved search pages in Career/searches/ one at a time. List every posting newer than the "Last run" date in Career/new-postings.md that mentions ServiceNow or ITSM. Rewrite Career/new-postings.md with today\'s date as the last run, the new rows added at the top, and the existing rows kept.';

console.log("\n4. create_shortcut — /jobwatch, Weekdays, 8:00, active hours 8 to 9");
let jobId = null;
{
  const r = await executeTool("create_shortcut", { name: "jobwatch", prompt: PROMPT, days: "Weekdays", time: "8:00", window_start: "8:00", window_end: "9:00", category: "Career" }, {});
  ok("ok:true, action created", r && r.ok === true && r.action === "created", r);
  ok("name reported with the slash", r && r.name === "/jobwatch");
  ok("schedule label as Settings shows it", r && r.schedule === "Every 1 h · 8:00 AM–9:00 AM · weekdays", r && r.schedule);
  ok("next_run is a real time", r && typeof r.next_run === "string" && r.next_run.length > 5, r && r.next_run);
  ok("no Settings tab opened when not asked", calls.tabCreates.length === 0 && calls.tabUpdates.length === 0);
  const list = await (await import("./shortcuts.js")).getShortcuts();
  const sc = list.find((s) => s.name === "jobwatch");
  jobId = sc && sc.id;
  ok("stored once via saveShortcut", list.filter((s) => s.name === "jobwatch").length === 1);
  ok("stored prompt is the user's text verbatim", sc && sc.prompt === PROMPT);
  ok("stored category", sc && sc.category === "Career");
  ok("stored schedule = interval 60 / 08:00–09:00 / weekdays", sc && sc.schedule && sc.schedule.enabled && sc.schedule.recurrence === "interval" && sc.schedule.intervalMinutes === 60 && sc.schedule.windowStart === "08:00" && sc.schedule.windowEnd === "09:00" && sc.schedule.days === "weekdays", sc && sc.schedule);
  ok("alarm armed for it (periodInMinutes 60)", calls.alarmCreates.some((a) => a.name === "sched:" + jobId && a.periodInMinutes === 60), calls.alarmCreates);
  ok("result names how to run it now", r && /\/jobwatch/.test(r.run_now || ""));
}

console.log("\n5. duplicate name → error unless replace_existing");
{
  const dup = await executeTool("create_shortcut", { name: "jobwatch", prompt: "other" }, {});
  ok("duplicate refused", dup && dup.error && /already exists/.test(dup.error) && /replace_existing/.test(dup.error), dup);
  ok("refusal shows the existing schedule", dup && dup.existing && dup.existing.schedule === "Every 1 h · 8:00 AM–9:00 AM · weekdays", dup && dup.existing);
  const before = calls.alarmCreates.length;
  const upd = await executeTool("create_shortcut", { name: "JobWatch", prompt: PROMPT + " Also email me.", replace_existing: true, recurrence: "daily", time: "8:00", days: "weekdays" }, {});
  ok("replace_existing → updated, same id", upd && upd.ok && upd.action === "updated" && upd.id === jobId, upd);
  ok("… schedule now Daily · 8:00 AM · weekdays", upd && upd.schedule === "Daily · 8:00 AM · weekdays", upd && upd.schedule);
  const list = await (await import("./shortcuts.js")).getShortcuts();
  ok("still exactly one /jobwatch", list.filter((s) => s.name === "jobwatch").length === 1);
  ok("alarms re-synced after the update", calls.alarmCreates.length > before);
}

console.log("\n6. show_in_settings opens Settings at the entry; a second call reuses the tab");
{
  const r = await executeTool("create_shortcut", { name: "standup", prompt: "Summarise my open tabs.", show_in_settings: true }, {});
  ok("manual shortcut saved", r && r.ok && r.schedule === "manual only" && r.next_run === null, r);
  ok("Settings tab created with ?highlight=<id>#shortcuts", calls.tabCreates.length === 1 && calls.tabCreates[0].url === OPTIONS_BASE + "options.html?highlight=" + encodeURIComponent(r.id) + "#shortcuts", calls.tabCreates);
  ok("result warns not to use page tools on it", /do NOT call page tools/.test(r.settings_page || ""), r.settings_page);
  const r2 = await executeTool("create_shortcut", { name: "standup2", prompt: "x", show_in_settings: true }, {});
  ok("second call updates the existing Settings tab instead of opening another", calls.tabCreates.length === 1 && calls.tabUpdates.length === 1 && /highlight=/.test(calls.tabUpdates[0].url) && calls.tabUpdates[0].active === true, calls.tabUpdates);
  ok("…", !!r2.ok);
}

console.log("\n7. list_shortcuts is read-only and matches Settings");
{
  const before = JSON.stringify(store);
  const r = await executeTool("list_shortcuts", {}, {});
  ok("count 3", r && r.count === 3, r);
  const jw = r.shortcuts.find((s) => s.name === "/jobwatch");
  ok("/jobwatch listed with its schedule + next run", jw && jw.schedule === "Daily · 8:00 AM · weekdays" && typeof jw.next_run === "string", jw);
  ok("prompt preview capped", jw && jw.prompt_preview.length <= 161);
  ok("storage untouched", JSON.stringify(store) === before);
}

console.log("\n8. create_shortcut needs both name and prompt at the executor too");
{
  const r = await executeTool("create_shortcut", { name: "   ", prompt: "x" }, {});
  ok("blank name refused", r && /name/.test(r.error || ""), r);
  const r2 = await executeTool("create_shortcut", { name: "ok", prompt: "" }, {});
  ok("blank prompt refused", r2 && /prompt/.test(r2.error || ""), r2);
}

console.log("\n9. TRUNCATION: a trailing URL is not a cut-off; a 'nothing was cut off' reply is dropped");
{
  const filler = "Line of the answer with enough words to be judged a long answer.\n".repeat(30);
  const urlTail = filler + "**Sources (Web Search):**\n1. Glassdoor: https://www.glassdoor.com/Salaries/baltimore-md-servicenow-developer-salary-SRCH_IL.0,12_IM63_KO13,33.htm\n5. Reddit r/servicenow certification discussion: https://www.reddit.com/r/servicenow/comments/1s7nwri/which_certification_should_i_take_next_whats_the/";
  ok("answer ending on a URL with a trailing slash → complete", looksTruncated(urlTail, "Search the web") === "", looksTruncated(urlTail, "Search the web"));
  ok("answer ending on a bare URL in parentheses → complete", looksTruncated(filler + "See the guide (https://example.com/a/b/).", "x") === "");
  ok("answer ending mid-sentence still flagged", /mid-sentence/.test(looksTruncated(filler + "The next step is to open the record and", "x")));
  ok("open code fence still flagged", /code block/.test(looksTruncated(filler + "```js\nconst a = 1;", "x")));
  ok("short answers never flagged", looksTruncated("Done. https://example.com/", "x") === "");
  const denial = "I cannot complete this request because there is no previous message in our conversation that was cut off. Looking at our exchange:\n\n1. You asked me to read a job posting - I completed this";
  ok("export's denial → non-continuation", isNonContinuation(denial) === true);
  ok("'None of my responses were truncated' → non-continuation", isNonContinuation("None of my responses were truncated or cut off mid-sentence.") === true);
  ok("'nothing left to continue' → non-continuation", isNonContinuation("There is nothing left to continue — the document above is complete.") === true);
  ok("NOTHING_MISSING sentinel → non-continuation", isNonContinuation("NOTHING_MISSING") === true);
  ok("empty → non-continuation", isNonContinuation("") === true);
  ok("a real continuation passes", isNonContinuation("## I. Verification checklist\n- [ ] The business rule was cut down to one query\n- [ ] Tests pass") === false);
  ok("prose that merely mentions truncation passes", isNonContinuation("The field truncates values over 40 characters, so the second column shows them in full below.") === false);
}

console.log("\n10. WIRING in the shipped files");
{
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const cfg = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  const tl = readFileSync(new URL("./tools.js", import.meta.url), "utf8");
  const sp = readFileSync(new URL("./sidepanel.js", import.meta.url), "utf8");
  const op = readFileSync(new URL("./options.js", import.meta.url), "utf8");
  const oh = readFileSync(new URL("./options.html", import.meta.url), "utf8");
  ok("background imports looksTruncated + isNonContinuation from loop-guards", /import \{[^}]*looksTruncated[^}]*isNonContinuation[^}]*\} from "\.\/loop-guards\.js"/.test(bg));
  ok("background no longer defines its own looksTruncated", !/^function looksTruncated\(/m.test(bg));
  ok("background drops a denial instead of appending it", /isNonContinuation\(content\) \? truncPrefix/.test(bg));
  ok("continuation prompt offers NOTHING_MISSING", /NOTHING_MISSING/.test(bg));
  ok("create_shortcut is an action tool (approval in ask mode, hidden in read-only)", /const ACTION_TOOLS = new Set\(\["create_shortcut"/.test(bg));
  ok("sub-agents do not get create_shortcut", /n !== "create_shortcut"/.test(bg));
  ok("system prompt rule: shortcuts are a tool, not a page", /- create_shortcut \/ list_shortcuts —/.test(cfg) && /chrome-extension/.test(cfg.split("- create_shortcut / list_shortcuts —")[1].split("\n")[0]));
  ok("tools.js spreads SHORTCUT_TOOLS and routes before any tab is resolved", /\.\.\.SHORTCUT_TOOLS/.test(tl) && tl.indexOf("SHORTCUT_TOOL_NAMES.has(name)") < tl.indexOf("const tab = await resolveTab(ctx);"));
  ok("side panel approval card previews the shortcut", /name === "create_shortcut"/.test(sp) && /describeShortcutArgs/.test(sp));
  ok("options page highlights ?highlight=<id> and re-renders on storage change", /highlight/.test(op) && /storage\.onChanged/.test(op) && /dataset\.scId/.test(op));
  ok("options.html has the #shortcuts anchor", /id="shortcuts"/.test(oh));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

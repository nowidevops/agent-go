// Prompt Builder — turns a rough goal into a well-written, CAPABILITY-AWARE
// prompt for this extension's agent. The meta-prompt below is a condensed,
// hand-maintained sheet of what the agent can actually do (tools, modes,
// guardrails) plus the prompt-writing lessons learned from real transcripts
// (2026-07-22 dashboard run: a vague "open the folder" prompt cost 22 tool
// calls; explicit URL + step budget + verify criterion is the fix).
// Keep this sheet in sync when tool families are added/removed in tools.js.

const CAPABILITY_SHEET = `
WHAT THE AGENT CAN DO (write prompts that use these — never ask for anything else):
- BROWSER (active tab): navigate(url) · read_page (title/url/visible text, iframes + shadow DOM) · query_elements (CSS selector + text filter → clickable handles) · click_element · fill_input · select_option · set_reference_field (autocomplete fields) · drag_drop · scroll_page · list_tabs / close_tab · capture_screenshot (local vision model describes it) · read_pdf (web PDFs) · code editors via list_editors / get_editor_value / set_editor_value (CodeMirror/Monaco, e.g. ServiceNow widget panes).
- RESEARCH (no tab disruption): google_search · web_search (DuckDuckGo) · fetch_page (background GET, no login cookies) — results are REAL snippets; the agent cites what it read.
- SERVICENOW (when an instance is connected via the 🔌 menu): sn_query_table / sn_query_session and friends — structured record/schema queries beat UI scraping; sn_api_reference for grounded API docs.
- LOCAL FILES (when a folder is connected via the 📁 menu): search_files (regex) · read_file (incl. PDF/Word/Excel text) · edit_file / write_file · create_document (Markdown → docx/pdf/md) · create_folder / move_file / copy_file · run_command (with approval).
- DESKTOP CONTROL (when desktop-server is running): desktop_screenshot + desktop_click by screen position — reaches sandboxed iframes/canvas the DOM cannot.
- FAN-OUT: spawn_subagent {task, scope_url, expect} — one child per independent sub-task, EACH with its own tab via scope_url, ALL spawned in one turn (max 8).
- MODES the user picks in the UI: Plan first / Ask before acting / Act without asking / Read-only (all writes disabled — best for review/analysis).
- GUARDRAILS (do not fight them in the prompt): no CAPTCHA/2FA/login-credential guessing; destructive actions and file writes pause for user approval; the agent must not fabricate — it reports honestly when something is unreadable.

HOW A GREAT PROMPT FOR THIS AGENT IS WRITTEN:
1. Lead with ONE clear goal sentence. Include EXACT URLs, record numbers, file paths, and names — the agent must never guess them.
2. Give a step budget for navigation-style tasks ("in at most N tool calls") and, when the target URL/pattern is known, say to navigate(url) directly instead of clicking through menus.
3. Name the finish line: a concrete deliverable + verify criterion ("reply with a table of X | Y | Z", "confirm the record shows state=Closed").
4. State the boundaries: what NOT to do ("fill the form but STOP before submitting", "read-only — change nothing", "do not click Refresh/Re-scan").
5. Multi-part tasks: enumerate the parts and say "do ALL parts in ONE run, writing a 1-2 line note after each part, then a consolidated answer".
6. Independent sub-tasks across sites/instances: say "spawn one sub-agent per <thing>, passing each target URL as scope_url, all in a single turn".
7. Prefer structured data over UI scraping: if a connected ServiceNow instance or local folder can answer it, tell the agent to use sn_query_* / read_file first.
8. If the task needs a connection the user may not have made (ServiceNow instance, local folder, desktop-server), begin the prompt with a one-line precondition, e.g. "(Requires the ServiceNow MCP connection.)".
`;

export const PROMPT_WRITER_SYSTEM =
`You are the Prompt Builder for the "Local LLM" Chrome-extension agent. The user gives you a rough goal; you rewrite it as ONE excellent, ready-to-send prompt for that agent.
${CAPABILITY_SHEET}
OUTPUT RULES (strict):
- Output ONLY the finished prompt text — no preamble, no explanations, no markdown code fences, no "Here is your prompt".
- Keep it tight: a goal line, then short numbered steps or bullets ONLY when the task genuinely has parts, then a "Verify:" line with the finish criterion. A simple task should be 1-3 sentences total.
- Preserve every concrete detail the user gave (URLs, names, numbers); NEVER invent URLs, record numbers, credentials, or facts the user did not supply. If a critical detail is missing, put a clearly marked placeholder like <PASTE RECORD NUMBER> in the prompt.
- Write in the imperative voice, addressed to the agent.`;

// Per-preset directives — the load-bearing trick: the agent's guardrail packs
// are injected at RUN time by keyword detectors over the prompt text
// (needsServiceNowPack → "servicenow" / instance URL; needsResearchPack →
// "deep research" phrasing; needsRcaPack → "root cause / investigate the
// issue"). Each directive FORCES the writer to keep the canonical trigger
// phrasing in the finished prompt, so picking a chip deterministically
// activates the matching pack — the agent runs inside its guardrails instead
// of depending on the user's rough wording happening to trip a detector.
const PRESET_DIRECTIVES = {
  servicenow:
    `PRESET: ServiceNow build. The finished prompt MUST contain the word "ServiceNow" and the instance URL (or the <instance URL> placeholder), name the artifact type and target table, and end by requiring the record to be SAVED and VERIFIED (exists + active). Do not paraphrase "ServiceNow" away — that exact word activates the agent's ServiceNow guardrail pack at run time.`,
  review:
    `PRESET: Code review. The finished prompt MUST contain the phrase "code review" (plus "ServiceNow" if the artifact lives in an instance) and state it is READ-ONLY: analyze and report with quoted evidence, change nothing, and do not offer to build fixes mid-review. That wording routes the agent into its review guardrails instead of build mode.`,
  factfinding:
    `PRESET: Fact finding. The finished prompt MUST contain the phrase "fact finding" and the word "ServiceNow" (that exact wording activates the agent's read-only instance grant and ServiceNow pack at run time), state it is READ-ONLY on the instance (analyze and report, change nothing), and structure the task as exactly three numbered steps: (1) READ the user story — preserve the user's exact identifier: a record number (e.g. STRY0000001 — look it up via sn_query_session/sn_query_table on the story table, rm_story), a URL to navigate to, or a local file path to read_file; (2) using the ServiceNow (MCP) connection if available, FIND AND LIST every artifact involved in the story's requirements (Business Rules, Script Includes, Client Scripts, UI Policies/Actions, ACLs, Catalog Items, Flows, etc.) as a table of type | name | table | sys_id, from QUERIED evidence — never guessed; (3) RE-WRITE the story in a clear, self-contained, implementation-ready format — title, background, current vs. desired behavior, acceptance criteria as numbered testable statements, the affected-artifact list from step 2, and open questions — so ANY AI model could implement it with no extra context. End with a Verify line requiring the rewritten story plus the artifact table as the deliverable.`,
  postdeploy:
    `PRESET: Post-deployment validation. The finished prompt MUST contain the word "ServiceNow" and the phrase "post-deployment validation" (that exact wording activates the agent's ServiceNow + post-deployment guardrail packs at run time — do not paraphrase either away). Structure the finished prompt EXACTLY like this, keeping every heading line verbatim so the run-time environment gate can read it:
  - A goal line: post-deployment validation, verification and (where allowed) smoke testing of the deployed update set in ServiceNow.
  - "Source Instance: <URL>" and "Target Instance: <URL>" on their own lines, each tagged with its environment in parentheses, e.g. "(NON-PRODUCTION — DEV)" / "(PRODUCTION)". Use the user's real URLs; if one is missing, emit a <SOURCE INSTANCE URL> / <TARGET INSTANCE URL> placeholder — never invent a host.
  - "Parent Update Set: <URL>" and "Child Update Set: <URL>" on their own lines (placeholders if the user did not give them; keep the Child line even for a single set and mark it "<none / single set>").
  - "DEPLOYMENT TYPE: NON-PRODUCTION -> NON-PRODUCTION" or "DEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION" on its own line, written EXACTLY in that shape (uppercase, plain ASCII arrow). This single line decides whether writes are allowed, so derive it from the target's environment and never omit it. If the user did not say which environment the target is, write "DEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION" and add a line telling the agent to confirm the target environment with the user before testing anything — defaulting to the read-only track is the safe error.
  - Then numbered work, matching the deployment type:
    (1) VERIFY AND VALIDATE THE DEPLOYED UPDATE SET CONTENT on the target — every artifact in the update set's payload: scripts (Business Rules, Script Includes, Client Scripts, UI Actions), configurations (UI Policies and their actions, ACLs and their roles, dictionary/choices, properties, catalog items and variables, flows, scheduled jobs, notifications, transform maps, REST APIs, widgets), and anything else the payload carries — each confirmed to EXIST on the target, be ACTIVE, and MATCH the source, with skipped/overwritten preview problems and broken cross-instance references called out.
    (2) NON-PRODUCTION TARGET ONLY — a SMOKE TEST that exercises the functionality and verifies each acceptance criterion of the story (name the story number/URL if the user gave one, otherwise a <STORY NUMBER OR URL> placeholder), reported as a pass/fail table.
    (3) REPORT EVERY ISSUE FOUND, severity-ranked with the evidence for each, and a GO / NO-GO verdict.
    (4) End with the click-by-click steps: a "## Click-by-Click Validation Steps" section reproducing every check by hand in the UI, plus a "## Click-by-Click Build Guide" for any recommended fix.
  - When the deployment type ends in PRODUCTION, the prompt MUST carry a standalone line reading: "PRODUCTION IS STRICTLY READ-ONLY — verify by query and read only: create/update/delete nothing, click no Save/Update/Submit/Delete, run no background scripts or fix scripts, impersonate nobody, and run NO smoke test on production; write up the test for the business to run instead." Step (2) is then omitted from the work list.
  - A final "Verify:" line naming the deliverable: the artifact-by-artifact validation table, the smoke-test table (or the not-tested table on a production target), the issue report with the GO/NO-GO verdict, and the click-by-click sections.`,
  research:
    `PRESET: Deep research. The finished prompt MUST use the phrase "deep research" (or "research and summarize" / "research and compare") and require a cited source URL for every factual claim, with unverifiable claims flagged rather than stated. That phrasing activates the agent's DEEP RESEARCH pack (plan first, one sub-agent per sub-question, verify load-bearing claims, cite).`,
  browser:
    `PRESET: Browser task. The finished prompt MUST include the exact target URL, a step budget, and the stop-before boundary (e.g. "STOP before submitting"). If the goal is DIAGNOSING something broken, phrase it as "investigate the issue" or "root cause" — that wording activates the agent's RCA evidence pack (console/network evidence before hypotheses).`,
  teams:
    `PRESET: Microsoft Teams auto-reply. The finished prompt MUST name the Teams URL (https://teams.cloud.microsoft/) and state it is a READ-ONLY drafter: read the 5 most recent messages in the currently open conversation, draft a reply into the compose box, and NEVER post/send until the user types the exact phrase "APPROVED — SEND IT". That URL + wording activates the agent's Teams auto-reply guardrail pack at run time (opt-in toggle must also be on in Options).`,
  slack:
    `PRESET: Slack auto-reply. The finished prompt MUST name the Slack URL (https://app.slack.com/) and state it is a READ-ONLY drafter: enumerate the human-to-human messages, the user picks one, draft a reply and type it into the composer with submit:false, and NEVER send (no Send click, no send_* tool, no Enter). That URL + wording activates the agent's Slack auto-reply guardrail pack at run time (opt-in toggle must also be on in Options).`
};

// ServiceNow focus areas the multi-select chips can send. Canonical artifact
// names — the SAME vocabulary the SN pack's artifact/phase detection and the
// sn_api_reference packs are organized by, so a prompt naming them scopes the
// agent onto the right grounding. Allowlist: unknown strings are dropped.
export const SN_AREAS = [
  "GlideAjax", "Business Rule", "Client Script", "Script Include", "UI Policy",
  "UI Action", "Catalog Item", "Record Producer", "Flow Designer", "ACL",
  "Scheduled Job", "Fix Script", "Transform Map", "Scripted REST API",
  "Service Portal Widget", "Notification", "ATF", "CMDB / IRE"
];

// Build the chat messages for one prompt-writing call. `page` (optional) is
// {title, url} of the user's active tab — real context the writer may weave in
// (e.g. the exact URL to act on) but must not fabricate beyond. `preset`
// (optional) is the chip key — see PRESET_DIRECTIVES. `snAreas` (optional) is
// the list of selected ServiceNow focus areas. `attachments` (optional) is
// [{name, kind: "image"|"text", summary}] — image summaries are vision
// descriptions, text summaries are the (truncated) file content.
export function buildPromptWriterMessages(goal, page, preset, snAreas, attachments) {
  let user = `Rough goal from the user:\n${goal}`;
  if (page && page.url && !/^chrome/.test(page.url)) {
    user += `\n\nThe user's ACTIVE TAB right now (use its exact URL if the goal is about "this page"): ${page.title || ""} — ${page.url}`;
  }
  const atts = Array.isArray(attachments) ? attachments.filter((a) => a && a.name && a.summary) : [];
  if (atts.length) {
    user += `\n\nSUPPORTING CONTEXT FROM THE USER'S ATTACHED FILES (real content the user provided — ground the prompt in it, never invent beyond it). IMPORTANT: the agent that RUNS the prompt will NOT have these files, so bake every relevant specific (names, values, URLs, field names, error text) directly INTO the prompt text:`;
    for (const a of atts) {
      user += `\n\n[${a.kind === "image" ? "image (vision-described)" : "file"}] ${a.name}:\n"""\n${String(a.summary).slice(0, 6000)}\n"""`;
    }
  }
  if (PRESET_DIRECTIVES[preset]) user += `\n\n${PRESET_DIRECTIVES[preset]}`;
  const areas = Array.isArray(snAreas) ? snAreas.filter((a) => SN_AREAS.includes(a)) : [];
  if (areas.length) {
    user += `\n\nSERVICENOW FOCUS AREAS: ${areas.join(", ")}. The finished prompt MUST name each of these artifact types EXACTLY as written (that vocabulary scopes the agent's artifact detection and API-reference grounding), state how they interact for this requirement (e.g. Client Script → GlideAjax → client-callable Script Include), tell the agent to verify API usage for these areas against its sn_api_reference before writing code, and stay WITHIN these areas — no artifacts of other types unless the user's goal explicitly requires one.`;
  }
  user += `\n\nWrite the prompt now.`;
  return [
    { role: "system", content: PROMPT_WRITER_SYSTEM },
    { role: "user", content: user }
  ];
}

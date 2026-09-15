// research-pack.js — Deep-Research method pack. Injected (background.js) when the
// task is research-shaped. Turns the single-pass web_search habit into a
// decompose → parallel-gather → verify → synthesize-with-citations workflow using
// the existing spawn_subagent fan-out. Kept concise for smaller local models.
// Author: iDevOpsLLC

export function needsResearchPack(taskText) {
  const t = String(taskText || "");
  // Deliberately does NOT match plain "investigate" (that's RCA territory).
  return /\b(deep|thorough|comprehensive|detailed|in[- ]depth) (research|analysis|report|review|comparison)\b|\bresearch (report|paper|this topic|and (write|summarize|compare))\b|\b(market|competitor|literature) (research|analysis|review)\b|\bcompare .{3,60} (options|alternatives|vendors|tools|products)\b/i.test(t);
}

export const RESEARCH_PACK = `DEEP RESEARCH MODE — produce a VERIFIED, CITED report, not a memory dump. Your built-in knowledge is stale; everything current must come from searches and pages read THIS run.

⛔ MANDATORY PLAN FIRST (no dive-in): before you run a single search or spawn any child, POST a RESEARCH PLAN as your reply — (a) the QUESTION restated + the 3-6 sub-questions/angles, (b) the SOURCES / searches you will run per sub-question, (c) what INDEPENDENT check would VERIFY each load-bearing claim, (d) the SYNTHESIS outline. Only AFTER the plan is posted do you gather. Diving into searches before the plan is written is a failure of the method.

HARD RULE (never skip, no exceptions — even for a "small" question): spawn EXACTLY 3 sub-agents (not fewer, and NOT more — extra sub-agents blow the per-task turn budget and the run gets cut off mid-research) and cite AT LEAST 3 DIFFERENT sources (distinct domains). Fewer than 3 sub-agents or fewer than 3 distinct sources means the research is INCOMPLETE — say so and keep going; do not present a final answer built on less.
ESCAPE HATCH (prevents endless looping on a thin topic): if after 2 ADDITIONAL search rounds you still cannot reach 3 distinct navigable sources, STOP — present what you DID find and explicitly name the gap ("only N independent sources exist for this"). Do NOT keep spawning agents just to satisfy the count when the sources genuinely don't exist.
1. DECOMPOSE the question into EXACTLY 3 sub-questions/angles — pick the 3 that matter most (e.g. current state / numbers, comparisons or alternatives, criticisms-risks or recency). Merge the rest into those 3; do not create a 4th.
2. GATHER in parallel — spawn_subagent ONE child per sub-question, ALL IN A SINGLE TURN, EXACTLY 3 CHILDREN. Each child opens its OWN tab and works IN THE OPEN. Each child's task: "web_search ONE clear phrasing of <sub-question> (a 2nd only if the first returns nothing — searches are limited); then NAVIGATE the live tab to the 1-2 most authoritative results and read_page each (do NOT fetch silently — the user must see the pages open); return the findings WITH the exact source URL for each fact." Keep each child tight — few searches, real page reads — so the whole task finishes inside its turn budget. Never collapse this to a single direct search — the 3-sub-agent, 3-source rule is mandatory.
3. VERIFY — for each load-bearing claim (a number, date, price, ranking, or "X is better/available"), run ONE more independent web_search that tries to REFUTE or confirm it from a DIFFERENT source, and navigate to it. A claim only one source supports gets flagged; a claim you cannot confirm gets dropped or moved to "Unverified".
4. SYNTHESIZE — direct answer first, then a section per sub-question built from the children's findings, then a "Conflicting / unverified" section for anything sources disagreed on.
5. CITE — every factual claim carries its source URL (inline or a Sources section mapping claim → URL). Cite ONLY urls you actually navigated to and read_page THIS run — never a remembered or invented URL, and never a bare search snippet. The Sources section must list AT LEAST 3 distinct domains.
6. EXPORT — offer to save the report with create_document (docx/pdf) into the connected folder.
RULES: search snippets are pointers, not sources — navigate + read_page before quoting a number. Prefer primary sources (vendor docs, official announcements) over blogs. Date-stamp anything that changes over time. If searches fail, say the research is incomplete — NEVER fill gaps from memory. For stock/analyst data specifically, do not fetch_page wsj.com, barrons.com, or investors.com as a source — they reliably return 401/404 to automated reads; use TipRanks, MarketBeat, StockAnalysis.com, Yahoo Finance, or Nasdaq instead, and prefer navigate + read_page over fetch_page for any page that might require a session.`;

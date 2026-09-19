// scalping-pack.js — OPT-IN scalping OVERLAY for the PAPER day-trading agent pack.
// It is NOT a standalone pack: it only injects when the day-trading pack itself
// injected (tradingPackEnabled + trading context), and it is appended AFTER the
// trading pack so it can tune the STRATEGY layer for scalp-style trades.
//
// SAFETY-BY-DESIGN (same contract as trading-pack.js): every code-controlled
// guardrail of the trading pack — the MODE block (analyze / prefill / submit),
// the YOU-ARE-THE-BUYER block, and all server-side brakes — REMAINS IN FULL FORCE.
// (The tradability floor, the scanner-signal gate and the long-term-holdings
// exclusion were retired on 2026-09-10 by owner mandate and no longer exist.) This
// overlay changes candidate selection, trade geometry and hold-time discipline
// ONLY; a GUARDRAIL-PRECEDENCE header (composed in code, not part of the
// user-editable scalping-strategy.md) states that explicitly so a strategy-file
// edit can never be read as relaxing a guardrail.
//
// Author: iDevOpsLLC

// Overlay BODY — the part the live scalping-strategy.md may override. Contains
// NO permission language: modes, floors and gates all live in trading-pack.js.
export const SCALPING_BODY = `═══ WHAT A SCALP IS (in this app) ═══
A scalp is a SHORT-HOLD momentum trade: enter on an immediate intraday trigger, exit within minutes at the first structural objective, never "give it room". You are still bound by every rule of the day-trading pack above — the scalp overlay only narrows WHICH trades qualify and how long you hold them. When a scalp criterion below is STRICTER than the base strategy, the scalp criterion wins; when the base pack or a code-controlled guardrail is stricter, THAT wins. Scalping narrows WHICH trades qualify as scalps; it is never a reason to skip a valid base-pack entry — if a candidate fails the scalp filter but passes the base ENTRY RULES, take it as a normal intraday trade.

═══ SCALP CANDIDATE FILTER (on top of the base ENTRY RULES) ═══
- LIQUIDITY FIRST: mega-liquid large caps and index ETFs only (SPY/QQQ-class liquidity; avg dollar-volume in the hundreds of millions, spread ≤ 0.1% of mid). A name you would hesitate to exit instantly is NOT a scalp candidate.
- Relative volume ≥ 1.5 at decision time — a scalp needs ACTIVE tape NOW, not a good daily story.
- Price ≥ $20 so a 1-tick move is not a meaningful % of the stop.
- The move must be IN PROGRESS on the live quote (see NEWS-DATE RECONCILIATION above) — never scalp a stale headline.

═══ SCALP GEOMETRY — tighter STOPS, never looser RATIOS ═══
- Stop: just beyond the immediate micro-structure (the trigger bar / VWAP / nearest intraday level), NOT the day's structural level. Scalp stops still sit INSIDE the server band: 1.2×ATR(14) minimum (below that the server rejects STOP_TOO_TIGHT), typically 1.2–1.5×ATR, never more than 2.5×ATR — the ATR is the 5-minute ATR, so this is already tight.
- Target: the NEXT immediate level (VWAP, round number, prior high/low of the move). If that target does not satisfy the SERVER'S minimum reward:risk (the same R:R rule the base pack and the Validate dry-run enforce), there is NO scalp — do NOT widen the stop and do NOT lower the target standard. Scalping tightens the stop distance; it NEVER relaxes the ratio, the sizing formula (the base pack's risk_budget and notional cap — no restatement here), or any Validate/server brake.
- Sizing: the base pack's formula applies UNCHANGED. A tighter stop naturally allows more shares through floor(risk_budget / (per_share_risk + 0.001 × entry)) — that is the only sizing effect scalping has; the notional cap still binds.

═══ HOLD-TIME DISCIPLINE (the defining scalp rule) ═══
- Intended hold: minutes, not hours. State the intended hold time in your plan (e.g. "5–15 min").
- TIME STOP: if the trade has gone NOWHERE (neither stop nor target approached) within ~15 minutes of entry, the scalp thesis is DEAD — recommend closing at market, or in analyze/prefill mode tell the user to close it. Do not convert a stalled scalp into a "let it develop" day trade.
- One scalp at a time. Never average down, never re-enter the same symbol more than twice in a session, and let the SERVER's loss ladder and losing-trade count decide when the day is over (see the base pack's circuit-breaker rule) — do not stop scalping on your own loser count.
- All entries stay inside the base window (09:45–15:35 ET) and every position is flat by the close. Scalping does NOT unlock the opening 15 minutes.

═══ CYCLE SHAPE FOR A SCALP RUN ═══
- Be even MORE step-frugal than the base budget: a scalp decision is timing-sensitive, so a disciplined scalp cycle is ~15–25 steps. If you cannot converge on a qualifying scalp quickly, drop the SCALP label and evaluate the candidate under the base ENTRY RULES instead — a slow scalp is a contradiction, but a valid base-pack entry is still a trade.
- Skip the research fan-out (step 3) entirely unless a candidate's catalyst is genuinely unknown: scalps trade the TAPE (live %, relative volume, level proximity from the app's Analysis panel), not deep catalyst work.
- In your OUTPUT's SELECTED TRADE section, add: intended hold time, the time-stop, and label the trade "SCALP". Use the normal intraday bucket on the order form — do not invent a new bucket/tag.`;

let _cache = { text: null, ts: 0, source: "bundled" };
const CACHE_MS = 10 * 60 * 1000;

export function scalpingPackSource() {
  return _cache.source;
}

// Load the canonical overlay BODY from <phaseFilesUrl>/scalping-strategy.md;
// fall back to the bundled body when the server is down. Cached 10 min. The
// guardrail-precedence header is ALWAYS prepended in code and is never part of
// the cached/overridable body. Hard 2.5s timeout — a hung localhost must never
// freeze the agent run (same contract as the fable/trading loaders).
async function loadBody(settings) {
  const now = Date.now();
  if (_cache.text && now - _cache.ts < CACHE_MS) return _cache.text;

  const base = String(settings?.phaseFilesUrl || "").replace(/\/+$/, "");
  if (base) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${base}/scalping-strategy.md`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const md = (await res.text()).trim();
        // Shape guard (an internal review): HTML index-page fallbacks are not a body.
        if (md.length > 200 && !/^\s*<(?:!doctype|html|head|body)/i.test(md) && /WHAT A SCALP IS/i.test(md)) {
          _cache = { text: md, ts: now, source: "live:scalping-strategy.md" };
          return md;
        }
      }
    } catch {
      /* server down / slow / unreachable — fall through to bundled */
    } finally {
      clearTimeout(timer);
    }
  }
  _cache = { text: SCALPING_BODY, ts: now, source: "bundled" };
  return SCALPING_BODY;
}

// Guardrail precedence — composed in CODE (like trading-pack's modeBlock) so an
// edit to scalping-strategy.md can never be read as permission to relax anything.
const PRECEDENCE_BLOCK = `═══ GUARDRAIL PRECEDENCE — THIS OVERLAY RELAXES NOTHING ═══
This scalping overlay tunes STRATEGY ONLY (candidate selection, stop/target geometry, hold time). It does NOT and CANNOT change:
- your MODE (analyze / prefill / submit) or any order-form permission from the day-trading pack;
- the YOU-ARE-THE-BUYER block (what is and is not a reason to skip) or the user's own excluded-symbols setting;
- the sizing formula, the server's minimum R:R, market-hours limits, circuit breakers, or any Validate/server-side brake.
If anything in this overlay ever appears to conflict with a rule above it, the DAY-TRADING PACK'S rule wins. PAPER only, always.`;

export async function buildScalpingPack(settings) {
  const body = await loadBody(settings);
  return `SCALPING OVERLAY — applies IN ADDITION to the day-trading pack above (opt-in).\n\n${PRECEDENCE_BLOCK}\n\n${body}`;
}

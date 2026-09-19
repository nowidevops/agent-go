# Changelog

## 0.2.25 — 2026-09-19

- Settings page fix. A packaging step had dropped a closing `</code>` tag from `options.html`, so the
  browser treated the rest of the page as one code block: monospace headings, a six-column limits
  row, and the Shortcuts and Saved workflows sections showing under every page. Both the download
  pack and this repository carried the broken page; here the tag came back in the commit just
  before this release, and the packaging step now stops at `<`.
- Settings field labels are semi-bold 13px in the accent colour, so a field is easier to find.
  Switch rows keep their neutral text.
- Model lists: `deepseek-v4-flash:cloud` is out of the picker and `qwen3.5:397b:cloud` is out of the
  default review and reverify chains, because Ollama Cloud retires both on 2026-09-25.
  `minimax-m3:cloud` heads the reverify chain. This change is in the source ahead of the 0.2.25
  download pack; the pack picks it up in its next build.

## 0.2.23 and 0.2.24 — 2026-09-18

- Paper-trading pack: the agent's instructions now describe the service's three entry brakes
  (a cap on how far a stock has already moved that day, a limit on exposure after a losing streak,
  and limit orders that are cancelled if still wholly unfilled after about five minutes).
- When the submit switch refuses an order, the message says which setting refused it.

## 0.2.12 to 0.2.22 — 2026-09-05 to 2026-09-15

- Redesigned side panel and Settings (paged Settings with a left menu and search, light and dark
  themes, first-run screen), saved workflows recorded with Teach, scheduled shortcuts, and the
  Listen voice input. The public source skipped these versions: it went from 0.2.6 to 0.2.22.

## 0.2.11 — 2026-09-05

- Screenshots are described by `glm-5.3-flash` by default (was `gemma4:31b`, which misread exact
  strings such as version numbers and prices on dense pages). Existing profiles move over once;
  re-selecting `gemma4:31b` in Options sticks. Same flat charge.

## 0.2.10 — 2026-09-05

- GPT-6 Astra (`gpt-6-astra`) is in the bring-your-own-key OpenAI model list. The service runs
  the GPT-6 family through OpenAI's `/v1/responses` endpoint, because `/v1/chat/completions`
  refuses function tools for it; tool calls, streaming and multi-turn tool results work the same
  as for every other model. Platform-key turns on GPT-6 are output-bounded.

## 0.2.9 — 2026-09-04

- Five knowledge-worker packs: knowledge article / SOP writer (draft only), contract playbook
  review (read only), RFP response (cited answers plus a gap list), meeting follow-up (quoted
  action items, gated send), and inbox triage / reply drafter for Gmail and Outlook (read only;
  sending stays blocked in code until the user approves the draft).

## 0.2.8 — 2026-09-04

- Options: packs are grouped by use case (ServiceNow, stocks trading, chat and collaboration,
  writing and working method, admin-only extras).
- The paper-trading pack, order-form prefill and paper submit default to on for plans that can
  see them; a research block precedes any trade suggestion.

## 0.2.7 — 2026-09-04

- The "implementation phases" pipeline pack is on by default. Profiles saved under the old
  default are switched on once; unchecking it in Options turns it off for good.
- The Prompt Builder is free: the request is tagged `purpose: "prompt_builder"` and the service
  runs it on the included model with no tools, no charge, and a per-account hourly cap.
- The day-trading packs (paper trading, scalping overlay, order-form prefill, paper submit, risk
  posture, excluded symbols) are available on the usage plan as well as admin. The Fable behavior
  pack and the M1 Finance pack stay admin-only.

## 0.2.6 — 2026-09-04

First public source release.

- Signed-out sends show the sign-in steps with an Open Settings button before any run starts.
- Classic workflow publish that reads itself back and flushes the workflow cache; Fix Script
  route for activity inputs; graph pre-flight (dangling, unreachable, dead-end nodes).
- Test-record guard and a ledger of every record a run created on the instance.
- Truncated final answers are continued instead of shipped short.
- BYOK: load a key from a file; custom OpenAI-compatible endpoint (server allow-list).
- Update notice when a newer pack is published.

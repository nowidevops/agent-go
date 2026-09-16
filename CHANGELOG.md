# Changelog

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

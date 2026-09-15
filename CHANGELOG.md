# Changelog

## 0.2.6 — 2026-09-04

First public source release.

- Signed-out sends show the sign-in steps with an Open Settings button before any run starts.
- Classic workflow publish that reads itself back and flushes the workflow cache; Fix Script
  route for activity inputs; graph pre-flight (dangling, unreachable, dead-end nodes).
- Test-record guard and a ledger of every record a run created on the instance.
- Truncated final answers are continued instead of shipped short.
- BYOK: load a key from a file; custom OpenAI-compatible endpoint (server allow-list).
- Update notice when a newer pack is published.

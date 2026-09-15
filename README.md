# Agent Go

A browser agent for ServiceNow and everyday web work. It reads the page you are on, calls
tools, and gets the task done: forms, catalog items, classic workflows, research, documents.
Inference runs on the Agentic Copilot service, so there is nothing to install except this
extension. No local model, no API key.

Download the ready-to-load pack and the full install guide at
https://ai.nowidevops.com/agent-go.html. This repository is the source of that pack.

Version 0.2.6. Works in Chrome, Edge and Brave (desktop), loaded as an unpacked extension.

## What it does

- Reads the page and acts on it: click, fill, select, navigate, screenshot and describe.
- ServiceNow, through your own signed-in browser session, so no instance password is needed
  for the normal flow (an optional Basic-auth connection you add yourself is stored in the
  browser's local extension storage): record lookups, schema, scripts, classic-workflow
  activities, Fix Scripts, a publish that reads itself back and flushes the workflow cache,
  and a ledger of every record it created.
- Knowledge packs for ServiceNow work (workflow, code review, RCA, incident resolution,
  post-deployment checks) that load only when the task calls for them.
- Guardrails in code, not only in the prompt: read-only modes, approval gates on anything that
  sends or deletes, loop and cycle breakers, a test-record guard, and honest 401/403 messages.
- Scheduled shortcuts, per-account, with a market-day calendar for timed runs.
- Optional local bridges (separate pack): voice input transcribed on your machine (the
  browser's built-in speech service is the fallback when the bridge is off), desktop control,
  shell commands in a project folder, text from local PDFs. They listen on 127.0.0.1 only.

## Install from source

1. Clone or download this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the
   folder that contains `manifest.json`.
3. Open the side panel (click the icon or press Ctrl+Shift+G), click **Settings**, sign in with
   your Agentic Copilot account (https://ai.nowidevops.com), and send your first message.

`INSTALL.md` has the step-by-step guide that ships with the download, including the sign-in
steps and the troubleshooting list.

## Account, cost, privacy

The extension talks to the Agentic Copilot service; a signed-in account with credits is
required. Reading pages and ServiceNow lookups do not cost credits; each model answer (one
agent turn) does, at the rates on the download page. Page content and screenshots you send go
to the service and the model that answers, so do not send confidential data. The extension
works through your signed-in ServiceNow session; if you add a stored connection with a
username and password, it lives in the browser's local extension storage on your machine and
nowhere else. A bring-your-own-key, if you configure one, stays on your machine too.

Permissions, in plain terms: it needs access to the pages you point it at (any site), a
content script that idles until asked, a console tap so it can read page errors when
debugging, alarms for scheduled shortcuts and the daily check for a newer pack, and tab
capture only for the opt-in meeting listener.

Two constants are empty in this repository on purpose and are yours to fill:
`SN_RESEARCH_INSTANCES` in `background.js` (hosts that get an automatic read-only grant for
research tasks) and `SN_EXCLUDED_HOSTS` in `sn-tools.js` (hosts the ServiceNow tools must
never touch).

## Tests

Plain Node, no framework: `node <file>.test.mjs` for any suite, or run them all:

    for f in *.test.mjs test/*.mjs; do node "$f"; done

## Contributing and security

See `CONTRIBUTING.md` and `SECURITY.md`. Support: info@nowidevops.com.

This is an independent project and is not affiliated with, endorsed by, or sponsored by
ServiceNow, Inc. SERVICENOW is a registered trademark of ServiceNow, Inc.

License: MIT (see `LICENSE`). Author: iDevOpsLLC.

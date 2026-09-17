# Agent Go

The agent that does the work for you, on any website. Give it a task in the side panel and it
reads the page you are on, clicks, types, navigates, searches and reads sources, drafts the
email or chat message, fills the form, and reports what it did. It is not limited to
ServiceNow: it handles everyday web work anywhere you are signed in (mail, chat, research,
documents, admin consoles). Method packs teach it one kind of work at a time - research,
inbox and chat replies, meeting follow-ups, knowledge articles, contract review, RFP answers -
and load only when the task calls for one. ServiceNow is where the tooling goes deepest, with
packs for the platform's own tables, scripts and classic workflows.

Inference runs on the Agentic Copilot service, so there is nothing to install except this
extension. No local model, no API key.

Download the ready-to-load pack and the full install guide at
https://ai.nowidevops.com/agent-go.html. This repository is the source of that pack.

Version 0.2.22. Works in Chrome, Edge and Brave (desktop), loaded as an unpacked extension.

## What it does

- Any site: reads the page and acts on it (click, fill, select, navigate, screenshot and
  describe), opens and reads sources for research, composes mail and chat messages for your
  approval, works through multi-step forms, and can split a task across sub-agents in their
  own tabs.
- ServiceNow, through your own signed-in browser session, so no instance password is needed
  for the normal flow (an optional Basic-auth connection you add yourself is stored in the
  browser's local extension storage): record lookups, schema, scripts, classic-workflow
  activities, Fix Scripts, a publish that reads itself back and flushes the workflow cache,
  and a ledger of every record it created.
- Method packs for knowledge work, each one a way of working the agent picks up only when the
  task calls for it: deep research (decompose the question, gather in parallel, verify, cite
  every claim), inbox triage and reply drafts in Gmail or Outlook, Slack and Teams reply drafts
  (read-only, nothing is sent), meeting follow-ups (decisions, action items, minutes), knowledge
  articles, SOPs and runbooks, contract and NDA review against your playbook, RFP, RFI and
  security-questionnaire answers, root-cause analysis, and a closing pass that strips the AI
  tells out of the prose it hands you.
- Method packs for ServiceNow work: the platform core, classic Workflow, Workflow Studio, code
  review, incident resolution, RCA and post-deployment checks.
- Packs are plain files in this repository, so you can read what one teaches before you trust
  it, edit it, or write your own. The knowledge-work packs ship bundled in full. Seven packs
  (the ServiceNow core, the behaviour packs and the market ones) also pull a newer copy from
  the service at run time and fall back to the bundled text when it is unreachable.
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

## Use cases

`USE_CASES.md` holds worked examples with the exact prompt to paste: a classic ServiceNow
workflow built and published from one request (the launch video), and a knowledge-worker task
outside ServiceNow (research in the open, a cited brief, an email draft left for approval).

## Account, cost, privacy

The extension talks to the Agentic Copilot service; a signed-in account with credits is
required. Reading pages and ServiceNow lookups do not cost credits; each model answer (one
agent turn) does, at the rates on the download page. The Prompt Builder is free (capped at 20
prompts an hour, priced by the service, not the extension); an image attached to it is described
first at the included-model rate. Page content and screenshots you send go
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

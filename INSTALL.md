# Agent Go — Chrome extension

Agent Go is a browser agent for ServiceNow and everyday web work. It reads the page you are
on, calls tools, and acts on your behalf. Inference runs on the Agentic Copilot service, so there is
nothing to install besides this extension — no local models, no API keys.

Version: 0.2.22   Built: 2026-09-15   (same text as https://ai.nowidevops.com/agent-go.html)

## Requirements

- Google Chrome 114 or newer on Windows or macOS (the side panel needs 114+). Edge and Brave
  also work since they load Chrome extensions.
- An Agentic Copilot account (https://ai.nowidevops.com) with credits. Each agent turn is
  metered from your balance.

## Install (Load unpacked)

1. Unzip this download to a PERMANENT folder, e.g. `Documents\Agent Go`. Chrome loads the
   extension from that folder every time it starts, so do not move or delete it afterwards.
2. In Chrome open `chrome://extensions` (paste it into the address bar).
3. Turn on **Developer mode** — the toggle at the top right in Chrome and Brave; in Edge it is in the
   left-hand panel.
4. Click **Load unpacked** and choose the `agent-go-extension` folder — the one that
   contains `manifest.json`. The card that appears shows the ID `igpadcnljdbbhklmgemlflnodnoihheb`;
   that ID is the same on every computer and is what the service recognises. Any other ID means
   the wrong folder was picked or `manifest.json` was edited.
5. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to Agent Go.
6. Open the side panel: click the Agent Go icon, or press **Ctrl+Shift+G** (macOS: **Cmd+Shift+G**).
   If the shortcut does nothing, another extension took it — assign one at `chrome://extensions/shortcuts`.
7. Sign in (required before the first message — otherwise the panel answers
   "Not signed in to Agent Go" and shows these same steps with an **Open Settings** button):
   a. In the side panel click **⚙ Settings** (top right) — or right-click the Agent Go icon → **Options**.
   b. In the **Account** card type the **email** and **password** of your Agentic Copilot account
      (the same account as https://ai.nowidevops.com).
   c. Click **Sign in**. The card switches to your email, plan badge and credit balance.
   d. No account yet? Click **Create one** under the Sign in button — it opens the sign-up page;
      sign up there, then come back and sign in.
   e. Close Options, return to the side panel and send your message.
8. Go to any page, type what you want done in the side panel, and press Enter.

## Updating

Download the new zip, EMPTY the folder you installed from, unzip the new files into that same
folder, then on `chrome://extensions` click the reload arrow on the Agent Go card. The extension
has a fixed ID (`igpadcnljdbbhklmgemlflnodnoihheb`), so from this release on your sign-in,
settings and shortcuts survive an update; they live in Chrome's storage, not in the folder.
Never click **Remove** to update: removing the extension deletes your / shortcuts, schedules
and settings from Chrome. Before any update, open Settings and use **Export** under Shortcuts
to keep a JSON backup; **Import** restores it if anything goes wrong.

One-time exception. If your Agent Go card shows a DIFFERENT ID, you installed a pack from before
the fixed ID. A reload keeps that old ID and sign-in keeps failing ("temporarily unavailable").
Click **Remove** on the card, then **Load unpacked** again from the updated folder. Chrome treats
this as a new extension: sign in again and re-enter any settings or shortcuts.

## Troubleshooting

- "Disable developer mode extensions" popup when Chrome starts — expected for an unpacked
  extension; click Cancel (or the X). It never affects Agent Go.
- Developer mode is greyed out, or the extension disappears after a restart — your browser is
  managed by an organisation policy that blocks unpacked extensions. Ask your IT team to allow
  it, or install on a personal profile / machine.
- "Manifest file is missing or unreadable" — you picked the wrong folder. Choose the
  `agent-go-extension` folder that contains `manifest.json`, not the zip or its parent.
- "Not signed in to Agent Go" — you skipped step 7 or signed out: ⚙ Settings → Account →
  email + password → Sign in, then resend the message. Your sign-in lasts until you sign out
  (it is kept in Chrome's local storage, not in the folder).
- Sign-in says the account has no access yet — write to info@nowidevops.com and the
  account is enabled for Agent Go.
- The side panel is blank or a tool never answers — on `chrome://extensions` click the reload
  arrow on the Agent Go card, then reopen the panel.

## Privacy

Page content and screenshots you send are transmitted to the Agentic Copilot service and the model
provider. Do not send confidential data. Your password is never stored by the extension; a
bring-your-own-key, if you configure one, stays on this machine only.

## Uninstall

`chrome://extensions` → Agent Go → Remove. Then delete the folder you unzipped.

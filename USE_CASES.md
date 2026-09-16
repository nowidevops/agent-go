# Use cases

Worked examples you can paste into the Agent Go side panel as they are. Each one names what
you need open first, what the agent does on screen, and what it hands back. Videos are linked
where one exists.

## 1. Build and publish a classic ServiceNow workflow from one request

Open first: the Workflow Editor on a sub-production instance
(`https://your-instance.service-now.com/workflow_ide.do`), signed in.

What happens: the agent checks the instance for a duplicate, reads the API reference, posts a
test plan, creates the workflow version and the activities (If gate for new records only, a
notification to the caller, a 30-minute timer, a Run Script that opens the child incident),
wires the transitions, applies the activity inputs through a Fix Script run from your own tab
when direct writes are refused, reads every input back, publishes with a graph pre-flight and
a cache flush, then proves it with one test incident and one negative test. It ends with a
build guide, a ledger of every record it created, and the question whether to clean up. It
never deletes on its own.

Video: the launch video on the Agentic Master Mind channel
(https://www.youtube.com/@AgenticMasterMind).

Prompt (verbatim from the recorded run; replace `your-instance`):

```
You are a ServiceNow developer. Build a complete Legacy Workflow (the classic
graphical Workflow engine, NOT Flow Designer) that fires when a new incident is
created and performs two actions, in order:

Implement this in:  https://your-instance.service-now.com/workflow_ide.do?sysparm_nostack=true&sysparm_use_polaris=false

  Open https://your-instance.service-now.com/workflow_ide.do?sysparm_nostack=true&sysparm_use_polaris=false - so I can follow along.

  1. Immediately send an email to the incident's caller.
  2. Wait 30 minutes, then create a child incident linked back to the parent.

Deliver every artifact a ServiceNow engineer needs to build this by hand in the
Workflow Editor. Be concrete and complete — no placeholders, no "configure as
needed". Use exact table names, field names, activity names, transition
conditions, and script bodies.

OUTPUT REQUIREMENTS — provide all of the following:

A. WORKFLOW RECORD (sys_wf_workflow)
   - Name, Table (incident), Description, and the "If condition matches" /
     "Run script" start behavior you recommend and why.

B. WORKFLOW VERSION (sys_wf_workflow_version) — checked-out draft fields.

C. START ACTIVITY
   - The "If" condition script that lets the workflow run only on a NEW
     incident (operation() == 'insert'). Show the exact script.

D. NOTIFICATION ACTIVITY — "Send Email" activity that emails the caller.
   - Activity name.
   - The exact email subject and body, pulling from incident fields
     (number, short_description, caller_id, opened_by, assignment_group,
     priority, opened_at). Use ${} variable syntax.
   - Recipient: caller_id (the incident caller).
   - Any "advanced" script needed to set the recipient from current.caller_id.
   - Which notification template or inline body approach you use.

E. TIMER / WAIT ACTIVITY — 30-minute wait between the email and the child-incident
   creation. Name the activity type (Wait / Timer), the duration value, and the
   exact field you set (e.g. 30 minutes, 1 day). State why a Wait activity is
   preferred over a scheduled job here.

F. CREATE-INCIDENT ACTIVITY — creates the child incident.
   - Activity name and activity type (Run Script, since there is no native
     "Create Incident" workflow activity).
   - The FULL server script that:
       * Creates a new incident record via GlideRecord.initialize()/insert().
       * Sets the parent_incident field to the current (parent) sys_id so the
         new record is a child of the original.
       * Copies short_description, caller_id, assignment_group, and priority
         from the parent.
       * Prefixes the child short_description with "[Child of INCxxxxxx] ".
       * Inserts with setWorkflow(false) and a justifying comment to prevent
         downstream business-rule/notify storms.
       * Uses current.getUniqueValue() for the parent sys_id — not a hardcoded
         id.
       * Returns the new incident sys_id in the workflow scratchpad or answer.
   - Include a dedupe guard: if a child incident already exists for this parent
     with the same short_description prefix, do NOT create a second one.

G. TRANSITIONS — the exact transitions between activities:
   - Start -> Notification  (condition: Always / "Yes")
   - Notification -> Wait   (condition: Always / "Yes")
   - Wait -> Create Child   (condition: Always / "Yes")
   - Create Child -> End    (condition: Always / "Yes")
   - End activity (Terminal)

H. PUBLISHING STEPS — the manual steps to validate and publish the workflow
   (Workflow Editor: Validate -> Workflow Actions -> Publish) and how to test
   it on a sub-prod instance by creating an incident and watching the workflow
   context advance.

I. ASSUMPTIONS / GUARDRAILS the engineer should verify on their instance:
   - The parent_incident field exists on incident (it is OOB on task/incident).
   - Caller has an email address on the sys_user record.
   - Workflow scope (global vs scoped) and any cross-scope considerations.
   - That the workflow is not also firing on incident updates (insert-only).

CONVENTIONS (follow strictly):
- Use ServiceNow server-side JavaScript (GlideRecord, gs, GlideDateTime).
- Never branch on gr.query() — it returns undefined. Use gr.next()/hasNext().
- Never call current.update() inside a before business rule; in workflow Run
  Script activities you are not in a before rule, but still avoid unnecessary
  current.update() on the parent.
- Use setValue() / getValue() rather than direct property assignment.
- Every script must be wrapped in an IIFE where appropriate and must be
  syntactically complete and ready to paste.
- Include a short header comment on every script naming the activity and table.

Produce the answer as a step-by-step build guide with the scripts inline.
End with a "Verification checklist" the engineer can tick off.
```

## 2. Prepare a meeting brief from live sources and leave the email as a draft

Not a ServiceNow task. Open first: your webmail (Outlook on the web, Gmail) in a tab, signed
in. Nothing else.

What happens: the agent opens three sources in new tabs and reads them on screen (you watch
it visit the real pages), writes a cited one-page brief, drafts it as an email in the mail tab
you have open, and stops with the draft on screen. Sending is yours. It closes with the list
of tabs it opened, what it could not verify, and one question for the meeting.

Prompt:

```
I have a 30-minute team meeting tomorrow about moving our internal documentation
from wiki pages into a knowledge base. Prepare me for it.

1. Research in the open: open three current, vendor-neutral sources on knowledge-base
   migration in NEW tabs and read each one on screen (skip product ads and anything
   older than 2024). Do not research silently in the background.

2. Write a one-page brief with three parts:
   - the five decisions we must make before migrating
   - the three most common migration mistakes and how to avoid them
   - a six-week plan as a table (week, milestone, owner role)
   Put a citation (page title + URL) next to every claim it supports.

3. Draft the brief as an email to my manager in the webmail tab I already have open.
   Subject: "KB migration: brief for tomorrow". Plain text, no emojis.
   Leave the draft open. Do NOT send it.

4. Finish with: the tabs you opened, anything you could not verify, and one question
   you think I should ask the team.
```

Variations that work the same way: a pricing comparison of three tools for a 25-seat team
posted to a Teams channel after your approval; a Monday status email rolled up from three
project pages, with a one-line RAG per project, left as a draft.

## Writing your own

- Say what to open and where to work ("in the tab I have open", "in a new tab").
- Ask for research in the open when trust matters; the agent then visits sources on screen
  instead of fetching them silently.
- Name the stopping point ("leave the draft open", "wait for my approval"). Anything that
  sends or deletes asks first anyway; saying it keeps the run short.
- Ask for the ledger at the end on ServiceNow tasks: every record the run created, so cleanup
  is one decision, not a search.

Author: iDevOpsLLC.

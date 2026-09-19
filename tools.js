// tools.js — tool schema (sent to the model) + dispatch (runs in the service worker).
// Author: iDevOpsLLC

import { captureAndDescribe, describeImage } from "./vision.js";
import { listEditors, getEditorValue, setEditorValue, saveServiceNowRecord, snCheckDuplicate, snQuerySession, setServiceNowField, getServiceNowFormFields, pageSnSave } from "./editors.js";
import { isServiceNowUrl, normalizeSnPolarisUrl, isServiceNowInstanceHost, lookupSnApiReference, wrapSnClassicTarget } from "./servicenow-pack.js";
import { isM1ReadOnlyRoute, isM1DashboardUrl } from "./m1-pack.js";
import { addLesson } from "./learning.js";
import { snQueryTable, snQueryRecord, snQuerySchema, snFetchScriptByName, snFetchScriptBySysId, snWorkflowActivityVars, snWorkflowActivitySet, snWorkflowDeleteActivity, snWorkflowFixScript, snWorkflowPublish, snSearchScriptBody, snWriteRecord, snRecentChanges, snCompareRecord, resolveSnTarget, resolveSnTargetByInstance, listSnInstances, getSnConnections, ARTIFACT_TYPES } from "./sn-tools.js";
import { readConsoleTap, readNetLog } from "./diagnostics.js";
import { extractDocumentText, looksLikePdf, pdfUrlFromViewer, classifyPdfRef } from "./extract.js";
import { SHORTCUT_TOOLS, SHORTCUT_TOOL_NAMES, runShortcutTool } from "./shortcut-tool.js";

// Strip a fetched HTML document down to readable text (scripts/styles/markup
// removed, entities decoded, whitespace collapsed) for fetch_page. Deliberately
// simple — no DOM in the service worker; regex is adequate for a text digest.
function htmlToReadableText(html) {
  let s = String(html || "");
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1] || "";
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ")
       .replace(/<style[\s\S]*?<\/style>/gi, " ")
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
       .replace(/<!--[\s\S]*?-->/g, " ")
       .replace(/<(head)[\s\S]*?<\/\1>/gi, " ")
       .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
       .replace(/<[^>]+>/g, " ")
       .replace(/&nbsp;/gi, " ")
       .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
       .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return " "; } })
       .replace(/[ \t]+/g, " ")
       .replace(/\n\s*\n\s*\n+/g, "\n\n")
       .trim();
  return { title: title.replace(/\s+/g, " ").trim(), text: s };
}

// Tool definitions in the OpenAI/Ollama function-calling format.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Read a web page: returns its title, URL, and visible text content. With no `url` it reads the ACTIVE tab. Give `url` to read a specific page — it navigates the tab there first, waits for the load, then reads. Reading several pages means one call PER page, ONE AT A TIME (wait for each result before the next); they share a single tab, so issuing them together makes the later ones read the wrong page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Optional. The page to open and read (http:// or https://). Omit to read whatever the active tab is already showing." },
          max_chars: { type: "integer", description: "Maximum characters of page text to return (default 6000)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_api_reference",
      description: "Look up the OFFICIAL ServiceNow API Reference (C:\\redacted\\path's authoritative API documentation) ON DEMAND, in any phase. Use it whenever you are unsure how a ServiceNow API method, class, table field, or event actually behaves — a method signature, whether a method exists, valid event names, a GlideRecord/GlideAjax/RESTMessageV2/g_form usage, etc. Pass a free-text `query` naming the API/method/class/table/event (e.g. 'GlideAggregate', 'g_form.getReference', 'RESTMessageV2', 'business rule current.update') or an artifact type. It returns authoritative reference text that OVERRIDES your training memory — prefer it over recollection and cite it when asserting how an API behaves. Use query 'index' to see which references are available. This is a READ-ONLY reference lookup; it does not touch the instance.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The API method/class/table/event or artifact type to look up (e.g. 'GlideAggregate', 'client script onChange', 'scripted rest'). Use 'index' to list available references." },
          artifact: { type: "string", description: "Optional artifact-type hint to target the right reference: business_rule, script_include, client_script, ui_policy, ui_action, service_portal_widget, scripted_rest, flow_designer, atf_test, fix_script, scheduled_job, catalog_item, acl_script." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "capture_screenshot",
      description: "Take a screenshot of the visible part of the active tab and have a local vision model describe it. Use for image-heavy pages, canvas/PDF, charts, or when read_page returns little usable text.",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "Optional: what to look for in the screenshot, e.g. 'the price' or 'error message'." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_elements",
      description: "Find visible elements on the active page by CSS selector and optional visible-text filter. Searches the whole page INCLUDING inside iframes (e.g. ServiceNow gsft_main) and open Shadow DOM web components. Returns a list where each match has an opaque 'selector' handle — pass that exact handle to click_element/fill_input. Form fields also report their live STATE: 'checked', 'value', 'type', 'disabled'/'readonly'. ICON-ONLY buttons (chevrons, pager arrows, accordion toggles that have no visible text) report 'icon_hint' (e.g. 'next', 'prev', 'expand', 'close', 'menu') and disclosure widgets report 'aria_expanded' (false = collapsed → click to expand; true = expanded → click to collapse). The text filter matches these too — so text:'next' finds a text-less ▶ arrow, text:'prev' finds ◀, and text:'expand' finds a collapsed accordion toggle. Cite reported values as evidence; if a field is absent, say so — never guess. Tip: query broadly (e.g. selector 'button, a, [role=button], [aria-expanded]' with a text filter) since framework UIs use non-obvious markup.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector, e.g. 'a', 'button', 'input', '.btn', or 'button, [role=button], [aria-expanded]' to catch icon buttons." },
          text: { type: "string", description: "Optional filter (case-insensitive). Matches visible text AND icon hints: 'next'/'prev'/'back'/'forward' for arrow buttons, 'expand'/'collapse'/'open'/'close'/'menu' for toggles." },
          limit: { type: "integer", description: "Max results (default 20)." }
        },
        required: ["selector"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Click an element using the exact 'selector' handle returned from query_elements (works across iframes and Shadow DOM). Pass double:true for a DOUBLE-click (fires a real dblclick) — e.g. double-click an empty spot mid-form on a ServiceNow record to toggle the technical field-name pills.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The exact 'selector' handle from query_elements (e.g. 'lc-12')." },
          double: { type: "boolean", description: "true = double-click (two click sequences + a dblclick event). Default false." }
        },
        required: ["selector"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_computed_style",
      description: "Read an element's REAL computed CSS (getComputedStyle after the full cascade, incl. runtime-injected styles): color, background, font, visibility — plus the EFFECTIVE background (first non-transparent ancestor) and the text/background CONTRAST RATIO with a verdict. THE tool for 'is this invisible / white-on-white / wrong color?' questions — never judge colors from a screenshot, and never try to open DevTools (F12 is outside the page and unreachable). Read-only.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "A 'selector' handle from query_elements (e.g. 'lc-12') OR a raw CSS selector (first match, searches iframes + shadow DOM)." },
          properties: { type: "array", items: { type: "string" }, description: "Extra CSS properties to include beyond the defaults (color, background-color, background-image, font-size, font-weight, display, visibility, opacity, z-index, border-color, text-decoration-line, pointer-events)." }
        },
        required: ["selector"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_input",
      description: "Type a value into a text field using the exact 'selector' handle from query_elements (works across iframes and Shadow DOM). Handles standard <input>/<textarea> AND contenteditable rich-text composers. For SENDING A CHAT MESSAGE prefer the send_chat_message tool (it targets the right recipient and verifies). If you do use fill_input with submit:true on a chat composer, it tries to send and returns an honest `sent` field — sent:false means the text is still in the box (NOT sent), so do not claim success.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The exact 'selector' handle from query_elements (e.g. 'lc-12'). For a chat composer, find it with selector '[contenteditable=\"true\"], [role=\"textbox\"]'." },
          value: { type: "string", description: "Text to type into the field." },
          submit: { type: "boolean", description: "If true, press Enter after typing — this SENDS the message in chat apps (Slack/Teams/etc.) or submits the form." }
        },
        required: ["selector", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_chat_message",
      description: "PREFERRED way to send a message in a chat app (Slack, Teams, Discord, etc.). Give the recipient/conversation name and the text; it finds the composer whose label matches `recipient`, types the message, and sends it (clicks the send button, falls back to Enter). It REFUSES if no open composer matches `recipient` — so you can never post to the wrong channel; if it refuses, open that conversation first (click the recipient in the sidebar) and retry. Returns `sent`: true means the composer cleared (success); `sent:false` means the text is STILL in the box (NOT sent) — only tell the user it was sent when sent is true. NOTE: an unsent draft also appears in read_page, so text being on the page is NOT proof of sending; verify by the message showing in the conversation history above the composer.",
      parameters: {
        type: "object",
        properties: {
          recipient: { type: "string", description: "Person or channel to send to, e.g. 'Alex Rivera' or 'general'. Must match an open conversation's composer label." },
          message: { type: "string", description: "The message text to send. Plain text only — no emojis/emoticons unless the user's own wording included them." }
        },
        required: ["recipient", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_chat_messages",
      description: "FAST chat reader (Slack/Teams/Discord/etc.) — call this FIRST for ANY read/summarize/reply task in a chat app. ONE call returns: the open conversation's name, the last N visible messages (sender + text + time, OLDEST first), and the composer state (composers lists the open conversation labels for draft/send targeting). Skips sidebar noise, needs NO scrolling, and replaces get_tab_info + read_page + manual parsing — do NOT read_page a chat thread first. Read-only; never changes the page. If it errors (not a chat view), fall back to read_page.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many of the most recent messages to return (default 5, max 30)." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_chat_message",
      description: "Type a DRAFT reply into the correct chat composer WITHOUT sending — the user reviews and sends it themselves. Use this whenever the user wants a reply drafted/typed/proposed but NOT sent (draft-for-approval workflows); use send_chat_message ONLY when the user explicitly wants it sent. Targets the composer matching `recipient` exactly like send_chat_message (REFUSES if no open conversation matches, so a draft can never land in the wrong channel), auto-opens Microsoft Teams' hidden 'Post in channel' compose box, and VERIFIES the text landed. Returns drafted:true + sent:false on success. After drafting NEVER press Enter, never click Send/Post, and never call send_chat_message unless the user then approves.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The draft text to type into the composer. Plain text only — no emojis/emoticons unless the user's own wording included them." },
          recipient: { type: "string", description: "Person or channel the draft is for, e.g. 'Alex Rivera' or 'general'. Must match an open conversation's composer label; omit only when a single conversation is open." },
          subject: { type: "string", description: "Optional subject line (Teams channel posts have an 'Add a subject' field)." }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_chat_message",
      description: "Delete ONE of YOUR OWN chat messages (Slack/Teams) by its EXACT visible text. You ONLY pass the text — the tool does the ENTIRE flow itself (hovers the message, opens its More-actions ⋮ menu, clicks Delete, confirms the modal) and VERIFIES the message vanished. You do NOT click the ⋮ button yourself, and you must NEVER refuse a delete by saying you 'cannot access the UI' / 'cannot click ⋮' / 'deletion requires manual interaction' — that is FALSE; just CALL this tool. DESTRUCTIVE — it always asks the user for approval first (even in act-without-asking mode). Returns ok:false if it can't confirm the delete (never claims an unverified delete). You can only delete messages you sent. Delete ONE message per call (loop for several); scroll the message into view first if it isn't visible.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The EXACT full visible text of the message to delete, e.g. 'Hi Brother man!'. Exact match prevents deleting the wrong message." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_reference_suggestions",
      description: "DISCOVER valid values for a reference/autocomplete field WITHOUT committing anything. Types `query` (a single letter or partial name works), collects the dropdown suggestions, then restores the field. Use this when the user did not name an exact person/group — present the suggestions or ask the user, THEN commit with set_reference_field. Never invent names.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The 'selector' handle of the reference field's visible input." },
          query: { type: "string", description: "Partial text to search with, e.g. 'a' or 'soft'." }
        },
        required: ["selector", "query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_reference_field",
      description: "Set a REFERENCE / AUTOCOMPLETE field (e.g. ServiceNow Caller, Assigned to, Configuration item — fields with a magnifier icon). Types the value, waits for the suggestion dropdown, clicks the best match, and verifies the value committed. Use the visible input's 'selector' handle from query_elements (ServiceNow ids look like 'sys_display.incident.caller_id'). Check 'verified' in the result.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The exact 'selector' handle of the reference field's visible input." },
          value: { type: "string", description: "Text to type, e.g. 'David Miller'." },
          option_text: { type: "string", description: "Optional: exact suggestion text to click if it differs from the typed value." }
        },
        required: ["selector", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description: "Set a DROPDOWN (<select>) to an option by its visible text (e.g. 'Solution provided') or value. Use this for choice lists like ServiceNow's Resolution code, State, Impact — NOT fill_input or click_element. query_elements with selector 'select' shows each dropdown's available options.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The exact 'selector' handle from query_elements." },
          option: { type: "string", description: "Visible option text (preferred) or option value to select." }
        },
        required: ["selector", "option"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "drag_drop",
      description: "DRAG one element and DROP it onto another — for HTML5 drag-and-drop UIs (sortable lists, kanban boards, card-sorting quizzes, drag-into-zone activities, file-less uploads). This is how you complete 'drag the card into the category' tasks that click_element cannot do. Get BOTH handles from query_elements first: the item to drag (source) and the drop zone/target (target). It fires the full HTML5 drag sequence (dragstart→dragover→drop) plus a mouse-drag fallback, then reports whether the item landed in the target. To sort several items, call it once per item.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "The 'selector' handle (from query_elements) of the element to DRAG — the card/item/row being moved." },
          target: { type: "string", description: "The 'selector' handle of the DROP ZONE / target element to drop it onto." }
        },
        required: ["source", "target"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "control_media",
      description: "Control a <video>/<audio> player on the page: change PLAYBACK SPEED, play/pause, mute, or seek — by setting the media element directly, so it works even when the player's on-screen speed menu is fragile or hidden. Use this for 'play the video at 2x', 'speed up the training video', 'skip/pause the video'. To get a gated lesson video done faster, set a high rate (e.g. 2) AND action:'play' so it actually plays through. Doesn't work on players embedded from another site (cross-origin iframe).",
      parameters: {
        type: "object",
        properties: {
          rate: { type: "number", description: "Playback speed multiplier, e.g. 2 for 2x, 1.5, 1 for normal. Clamped to 0.1–16." },
          action: { type: "string", enum: ["play", "pause", "mute", "unmute"], description: "Optional transport action applied to the main player." },
          seek: { description: "Optional: jump to 'start', 'end', or a number of seconds. Note: seeking to the end usually does NOT satisfy watch-completion tracking — use rate+play for that." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_form_section",
      description: "Open a named FORM SECTION TAB on a classic ServiceNow form — e.g. a Business Rule's 'When to run', 'Actions', or 'Advanced' tab, or a UI Policy's 'Script' tab. Classic forms hide most fields behind these tabs: when an expected field/checkbox/editor is not on the page, call this with the section's name instead of scrolling or re-querying. It finds the tab by its visible name, clicks it, and reports which fields became visible. If the tab only exists behind a controlling checkbox (a Business Rule's Condition + Script fields exist ONLY while the header's 'Advanced' checkbox is checked), it checks that checkbox automatically first. On failure it returns available_sections so you can pick the right name.",
      parameters: {
        type: "object",
        properties: {
          section: { type: "string", description: "Visible section tab name (case-insensitive; partial match ok), e.g. 'Advanced', 'When to run', 'Actions', 'Script'." }
        },
        required: ["section"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_check_duplicate",
      description: "Check whether a ServiceNow record ALREADY EXISTS before you create one — call this FIRST on any create task so you never add a duplicate. Queries the record's table through the logged-in UI session (works even when the plain REST tool sn_query_table returns HTTP 401). Checks by NAME first (truncation-safe), then by sys_id if you pass one. Returns duplicate:true with the matching sys_id(s) if found — in which case open/update the existing record instead of creating a new one.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "The record's OWN table, e.g. 'sys_script' for a Business Rule, 'sys_ui_action' for a UI Action, 'sys_script_include' for a Script Include." },
          name: { type: "string", description: "The record's Name to look for (checked first). Pass the full intended name; the tool handles fields that truncate it." },
          sys_id: { type: "string", description: "Optional: a specific sys_id to also confirm exists." }
        },
        required: ["table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_query_session",
      description: "Query ANY ServiceNow table through the logged-in UI session (bypasses the HTTP 401 that sn_query_table hits under a Basic-Auth Restriction). Use this to read SIBLING / RELATED records the open form doesn't show — the key one for a code review: find OTHER active Business Rules on the SAME table to catch ORDERING CONFLICTS and OVERLAPPING logic (e.g. query sys_script for collection=<table>^active=true and compare their order/when/action flags against the rule under review). READ-ONLY; the returned records are citable evidence. Requires a ServiceNow tab open on the target instance.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "The REAL table name, e.g. 'sys_script' (Business Rules), 'sys_script_include', 'sys_ui_policy', 'sys_data_policy2', 'sys_security_acl', 'sc_cat_item' (catalog items), 'item_option_new' (catalog VARIABLES; filter cat_item=<item sys_id>), 'item_option_new_set' (variable sets), 'catalog_ui_policy', 'catalog_script_client'. An HTTP 400 means the table name (or a query field) is WRONG -- fix it, never retry the same call. Unsure? Query sys_db_object (labelLIKE<words>) to find the table." },
          query: { type: "string", description: "An encoded sysparm_query (NO quotes around values). E.g. to find sibling active Business Rules on incident: 'collection=incident^active=true^ORDERBYorder'. Contains: field LIKE value. Empty = all rows (up to limit)." },
          fields: { type: "string", description: "Comma-separated fields to return (recommended, keeps results focused). For Business Rules: 'name,sys_id,order,when,active,action_insert,action_update,action_delete,action_query,condition,collection'. Omit to return all fields." },
          limit: { type: "number", description: "Max rows (default 20, max 50). Lower is FASTER -- on a large production instance every extra row costs an ACL pass per field." },
          display_value: { type: "string", description: "'true' (default) = reference fields come back as readable labels. 'false' = raw stored values, so reference fields come back as SYS_IDS -- use this when you are building an artifact table of sys_ids, and because it is the FASTEST option (the instance skips resolving every reference). 'all' is the slowest; only use it if you need both forms." }
        },
        required: ["table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_record",
      description: "SAVE the current classic ServiceNow form and VERIFY the record actually persisted. Use this instead of click_element on the 'Submit'/'Update' button — a plain click reports only that the button was clicked, NOT that the record saved, so a mandatory-field block or a client script can silently refuse the insert (a click that 'succeeds' can create ZERO records). This drives the form's own g_form.save() (save-and-stay: insert-and-stay on a new record, so you land back ON the saved record), returns ok:false with the empty field names if a required field blocks the save (the record was NOT created), and only returns ok:true after confirming a real 32-char sys_id. CONFIRMATION DIALOGS: the ACL 'Verify Security Rules' dialog is handled automatically (Continue is clicked and the save re-verified); any OTHER dialog is reported back with blocked_by:'confirmation_dialog' plus its title and buttons — that is NOT a validation failure, so don't re-fill the form: click the confirming button or ask the user. No arguments — it saves whatever classic form is open.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_set_field",
      description: "SET any classic ServiceNow form field via the form's OWN g_form.setValue() — the RELIABLE way to populate REFERENCE, GLIDE_LIST (list collector / slushbucket, e.g. Catalogs / Watch list / Groups), CHOICE, and plain fields. It drives the authoritative model directly, so there is NO fighting the slushbucket DOM, NO 'Lookup using list' popup window, NO autocomplete race — the field is set and verified instantly. For a REFERENCE or GLIDE_LIST field, `value` MUST be the target record's sys_id(s) and `display` the shown name(s): first get the sys_id with sn_query_session on the reference table (e.g. sc_catalog for Catalogs, sys_user for a user), then call this. For a CHOICE field pass the choice value; for a plain field pass the text. Use sn_form_fields first if you don't know the field names/types. This is how you build a record end-to-end without getting stuck on a widget.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", description: "Field NAME (bare, e.g. 'sc_catalogs', 'assigned_to', 'category' — a '<table>.field' prefix is stripped automatically)." },
          value: { type: "string", description: "For reference/glide_list: the sys_id (comma-separated sys_ids for multiple list items). For choice: the choice value. For plain fields: the text." },
          display: { type: "string", description: "For reference/glide_list ONLY: the display name(s) shown to the user (comma-separated to match multiple sys_ids). Lets g_form show the name without a lookup." },
          append: { type: "boolean", description: "Glide_list only: add value(s) to the existing list instead of replacing it. Default false." }
        },
        required: ["field", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_form_fields",
      description: "List the fields on the current classic ServiceNow form with each field's name, label, mandatory flag, current value/display, and a best-effort TYPE ('reference_or_list' = set with sn_set_field using a sys_id + display; 'choice' = set with the choice value; otherwise a plain input type). Use this to SEE a record's shape before building it — which fields are required, which are reference/list fields that need a sys_id — so you can populate it end-to-end. No arguments.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "self_feedback",
      description: "Rate YOUR OWN work on the current run — this is your reinforcement-learning signal (the same 👍/👎 a user gives, but self-applied). Call it after finishing a task, and any time you catch yourself erring. Give value:-1 (👎) when you made a MISTAKE this turn — a wrong action, a hallucinated value/sys_id, a stuck or repeated loop, a deliverable that only DESCRIBED the task instead of doing it, or ignoring the task's real intent — and write the `lesson`: one short, GENERAL, imperative rule that would prevent that exact mistake next time. It is saved and injected into your FUTURE runs, so you actually learn from it. Give value:1 (👍) only when you completed the task cleanly and correctly. BE HONEST AND SELF-CRITICAL: an accurate 👎 with a good lesson is far more valuable than a vanity 👍 — never rate yourself Pass/👍 to look good. During self-testing, call this once per task to match the Pass/Fail you recorded.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "integer", enum: [1, -1], description: "1 = 👍 you did it cleanly; -1 = 👎 you made a mistake this turn." },
          reason: { type: "string", description: "One line: what happened, and for a 👎 exactly what the mistake was." },
          lesson: { type: "string", description: "REQUIRED for value:-1 — one short, GENERAL, imperative rule to avoid this mistake next time (≤140 chars; not tied to this specific page/record/handle). E.g. 'Query the instance for a sys_id before citing it — never invent one.'" }
        },
        required: ["value", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_page",
      description: "Scroll the active page to reveal more content.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction." },
          amount: { type: "integer", description: "Pixels for up/down (default 800)." }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a keyboard key on the active page. Main use: 'Escape' to CLOSE a stuck menu / overflow / popover / dialog that is blocking you (e.g. a conversation row's '⋮' options menu) — then retry the real click. Also supports 'Enter', 'Tab', arrow keys. Note: 'Enter' inside a text box may submit/send.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name, e.g. 'Escape', 'Enter', 'Tab', 'ArrowDown'." }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Load a URL in the active tab. Follow with read_page to inspect the new page.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL (must start with http:// or https://)." } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_tab_info",
      description: "Return the active tab's current title and URL without reading full page text.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List ALL the user's currently open browser tabs (normal web pages), each with its tabId, title, and URL. Use this when the user refers to 'my open tabs' / 'these tabs' / 'each tab', OR when your task concerns a site (e.g. ServiceNow) that is NOT your current active tab — you cannot otherwise see tabs other than the active one. Typical flows: for 'summarize each of my open tabs', call list_tabs then one spawn_subagent per tab with scope_tab_id; to WORK on a page open in another tab, call list_tabs then switch_tab to it.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_tab",
      description: "Make an EXISTING background tab the ACTIVE tab, so your page tools (read_page, query_elements, fill_input, click_element, navigate, the sn_* tools, save_record) act on IT. Use this the moment you realize your active tab is NOT the page the task is about — e.g. the task is a ServiceNow build but get_tab_info shows some other site: call list_tabs, find the ServiceNow tab (its URL contains service-now.com or your instance host), then switch_tab to its tabId and proceed there. Do NOT navigate your current tab away to reach another site if that site is already open in another tab — switch to it instead (keeps both tabs, and lands you on the exact record the user already has open). tabId MUST be a real id from list_tabs.",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "integer", description: "The id of the tab to activate — a REAL id from list_tabs / get_tab_info, never an invented number." }
        },
        required: ["tabId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web and get REAL result snippets (title, url, snippet). Use this FIRST for ANY question about current or external facts — latest versions, news, prices, dates, 'does X exist', or research topics — instead of answering from memory. It does NOT change your active tab. After searching you may navigate to a result's url (or spawn_subagent with scope.url) and read_page for full detail. CRITICAL: state ONLY facts that appear in these snippets or a page you actually read — never invent statistics, product names, company names, or quotes. NOTE: this uses DuckDuckGo, which RATE-LIMITS after several quick queries — if it returns 0 results, switch to google_search (richer results + an AI Overview summary).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          limit: { type: "integer", description: "Max results to return (default 6, max 10)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "google_search",
      description: "Search GOOGLE and get REAL result snippets (title, url, snippet) PLUS Google's AI Overview summary when present. This is the PREFERRED research search — Google's results are far richer and less rate-limited than web_search (DuckDuckGo), and its AI Overview often answers a current-fact question directly (e.g. 'latest version of X', 'is Y released'). It opens a background tab to render Google, reads it, and closes it — it does NOT disturb or change your active tab. Reach for this FIRST on research/current-fact questions, or whenever web_search comes back empty or thin. The AI Overview is AI-generated — verify a key figure against a linked source before stating it as certain. State ONLY facts present in these results / the AI Overview / a page you then open; never invent statistics, names, dates, or quotes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          limit: { type: "integer", description: "Max organic results to return (default 6, max 10)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description: "Close the active browser tab. IRREVERSIBLE — it discards any unsaved changes on the page. Only use it when the user EXPLICITLY asks to close the tab.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_editors",
      description: "List the CODE EDITORS (CodeMirror/Monaco) on the page — e.g. the ServiceNow widget panes (HTML Template, CSS, Client controller, Server script). Returns each editor's index, label, size, and a preview. ALWAYS call this before get_editor_value/set_editor_value.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_editor_value",
      description: "Read the FULL text of a code editor by its index from list_editors. Use this to see existing code before modifying it (read_page only shows the visible lines of code editors).",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Editor index from list_editors." }
        },
        required: ["index"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_editor_value",
      description: "Set the text of a code editor (CodeMirror/Monaco) by its index from list_editors. Use this — NOT fill_input — for code panes like ServiceNow widget HTML/CSS/Client/Server editors. Replaces the entire content unless append=true. After setting, click the page's Save button to persist.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Editor index from list_editors." },
          value: { type: "string", description: "The code/text to put in the editor." },
          append: { type: "boolean", description: "If true, append to existing content instead of replacing." }
        },
        required: ["index", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_sms",
      description: "Send a real text message (SMS) to a US mobile number via a FREE carrier email-to-SMS gateway. Requires the recipient's CARRIER (Verizon/AT&T/T-Mobile/etc.) — a WRONG carrier means the text is silently NOT delivered, so if you don't know it, ASK the user; never guess. Opens a Gmail compose tab (the user must be signed into Gmail at mail.google.com) and sends. Carrier gateways can delay or drop messages — tell the user to confirm receipt. Supported carriers: verizon, att, tmobile, uscellular, boost, cricket, metropcs, googlefi, mint, xfinity.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "string", description: "Recipient US mobile number, 10 digits (e.g. '555-010-0199' or '5550100199')." },
          carrier: { type: "string", description: "Recipient's mobile carrier, e.g. 'verizon', 'att', 'tmobile'. ASK the user if unknown — a wrong carrier means no delivery." },
          message: { type: "string", description: "The text message body to send." }
        },
        required: ["number", "carrier", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send a normal email to an email address via the user's Gmail. MORE RELIABLE than send_sms (carrier email-to-SMS gateways often silently drop texts) — prefer this when you have an email address, or as a fallback when an SMS isn't received. Opens a Gmail compose tab (the user must be signed into Gmail at mail.google.com) and sends. Pass {to, subject, message}.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address, e.g. 'name@example.com'." },
          subject: { type: "string", description: "Email subject line (optional but recommended)." },
          message: { type: "string", description: "The email body." }
        },
        required: ["to", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Delegate ONE focused, independent sub-task to a child agent that has its own fresh context and step budget, then get its result back. Use this when a task splits into independent parts (e.g. 'summarize each of these 3 tabs', 'open each incident and return its caller + state') — issue ONE spawn_subagent per part (you may issue several in the same turn). When you fan out 2+ children, each AUTOMATICALLY gets its OWN new browser tab (so they never share or overwrite one tab); if a child's task names a URL it opens there. The child does ONLY the task you give it and returns ONLY the requested result. Do NOT use it for a single linear task you can do yourself, and a child cannot itself spawn sub-agents.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The child's instruction — fully self-contained (it does not see this conversation). e.g. 'Read the page and return a one-line summary.'" },
          scope_url: { type: "string", description: "Optional. Absolute http(s) URL to open a NEW tab for the child (auto-closed when it finishes). Use this to give each child its own page — e.g. one URL per child." },
          scope_tab_id: { type: "integer", description: "Optional. Id of an EXISTING tab to bind the child to. It MUST be a REAL id from list_tabs / get_tab_info — NEVER invent ids like 1,2,3. Omit all scope_* to use the current active tab." },
          scope_tab_match: { type: "string", description: "Optional. Bind the child to an ALREADY-OPEN tab by a hostname/URL substring — e.g. 'dev000000' or 'dev000000.service-now.com' to target that instance's open tab. Use this (instead of guessing a tab id) when the task names a site/instance that is already open in a tab. The child reuses that tab (not closed afterward)." },
          scope_instance: { type: "string", description: "Optional. For ServiceNow MCP work: the child's default instance by name/host (e.g. 'dev000000'). Its sn_* tools target that CONNECTED instance via stored credentials — NO open tab required. Use this to fan out across instances that aren't open in tabs." },
          max_steps: { type: "integer", description: "Child step budget (default 8, max 20)." },
          expect: { type: "string", description: "What the child should return, e.g. 'one-line summary' or 'JSON {caller, state}'." }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and sub-folders inside the user's connected LOCAL folder (Filesystem MCP, read-only). Use this FIRST to explore the folder before reading files. Only works if the user has connected a folder via '📁 Local files (MCP)' in the side panel. Paths are RELATIVE to the connected root; pass an empty path (or omit) for the root. Vendor/build dirs (node_modules, .git, dist, …) are skipped. Files flagged [blocked] cannot be read (sensitive/unsupported/oversized) — everything else CAN, including .pdf/.docx/.xlsx/.pptx (text extracted) and images (vision-described).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path relative to the connected root, e.g. '' for the root or 'src/modules'. No leading slash, no '..'. MULTI-FOLDER: if more than one folder is connected, PREFIX with the folder name (e.g. 'Project Files/src'); an empty path then lists the connected folders." },
          recursive: { type: "boolean", description: "If true, list all subdirectories recursively (depth ≤ 8, ≤ 2000 entries). Default false (single level)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the user's connected LOCAL folder (Filesystem MCP, read-only). Reads text/code files as-is, EXTRACTS the text from binary documents (.pdf, .docx, .xlsx, .pptx, .rtf — up to 25MB), and DESCRIBES image files (.png/.jpg/.webp/.gif/.bmp) via the vision model — so you CAN read PDFs, Word/Excel/PowerPoint files, and images; never claim otherwise. Only works if a folder is connected via '📁 Local files (MCP)'. The path is RELATIVE to the connected root (e.g. 'src/index.js' or 'Invoices/Invoice_97.pdf'). For large files use start_line/end_line (text: max 1MB; 200K chars/response). Sensitive files (.env, keys) stay blocked. A PDF with no usable text layer (scanned, or an undecodable font) is AUTOMATICALLY handed to the desktop-server (PyMuPDF + Tesseract OCR) — one read_file call is enough; if that fallback fails the result says why (usually the desktop-server is not running — tell the user in one line, do not retry).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the connected root, e.g. 'README.md' or 'src/app.js'. No leading slash, no '..'. MULTI-FOLDER: if more than one folder is connected, PREFIX with the folder name (e.g. 'Project Files/README.md') — a bare path is ambiguous." },
          start_line: { type: "integer", description: "1-indexed start line for a partial read (use with end_line for big files)." },
          end_line: { type: "integer", description: "1-indexed end line for a partial read. Omit with start_line to read to end (up to the response cap)." },
          max_chars: { type: "integer", description: "Max characters to return (default 200000)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (create or OVERWRITE) a text file in the user's connected LOCAL folder. The path is RELATIVE to the connected root (e.g. 'notes/out.md'); missing parent folders are created. Requires the folder to be connected with WRITE access, and the user must APPROVE every write. OVERWRITES the whole file — when editing an existing file, read_file it FIRST and pass the complete updated content. Use only when the user asked you to create or change a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the connected root, e.g. 'out.txt' or 'src/new.js'. No leading slash, no '..'." },
          content: { type: "string", description: "The FULL text to write. Replaces the file's entire contents." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Create a folder (and any missing parent folders) inside the user's connected LOCAL folder. Path is RELATIVE to the connected root (e.g. '01_Invoicing/Invoices'). Idempotent if the folder already exists. Requires WRITE access. Use this when ORGANIZING the folder: create the target structure first, then move_file items into it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path relative to the connected root, e.g. 'archive/2026'. No leading slash, no '..'." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "MOVE or RENAME a file OR folder inside the user's connected LOCAL folder — THE tool for organizing/tidying it. Works on EVERY file type (.pdf, .docx, .png, .db, …): bytes are transferred directly without reading the content. Folders move with ALL their contents. 'from' = the existing path; 'to' = the destination — if 'to' is an EXISTING folder (or ends with '/'), the item moves INTO it keeping its name; otherwise 'to' is the full new path (a rename). Missing destination folders are created automatically. NEVER 'move' a file by read_file + write_file (that breaks binaries) — use this tool. An existing FILE at the destination is only replaced with overwrite:true; folders are never overwritten or merged.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Existing file or folder path relative to the connected root, e.g. 'Invoice_101.pdf' or 'UPDATED INVOICES'." },
          to: { type: "string", description: "Destination path relative to the root. An existing folder (or trailing '/') = move INTO it keeping the name (e.g. '01_Invoicing/Invoices/'); otherwise the full new path/name (e.g. 'notes/renamed.md'). '.' = the root." },
          overwrite: { type: "boolean", description: "If true, replace an existing FILE at the destination (never folders). Default false." }
        },
        required: ["from", "to"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "copy_file",
      description: "COPY a file OR folder inside the user's connected LOCAL folder (the source stays in place). Same semantics as move_file: works on every file type including binaries (bytes are transferred, never read), folders copy with all contents, 'to' = existing folder (or trailing '/') → copy INTO it, otherwise the full new path. Missing destination folders are created. Use for backups/duplicates while organizing; use move_file to relocate.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Existing file or folder path relative to the connected root." },
          to: { type: "string", description: "Destination path relative to the root. Existing folder (or trailing '/') = copy INTO it; otherwise the full new path/name." },
          overwrite: { type: "boolean", description: "If true, replace an existing FILE at the destination (never folders). Default false." }
        },
        required: ["from", "to"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "PERMANENTLY delete a file or folder inside the user's connected LOCAL folder. IRREVERSIBLE — the user must approve EVERY delete, even in act-without-asking mode. A non-empty folder is only deleted with recursive:true (which deletes everything inside it). When the user didn't EXPLICITLY ask to delete, prefer move_file into an archive folder instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or folder path relative to the connected root. No leading slash, no '..'." },
          recursive: { type: "boolean", description: "Required true to delete a NON-EMPTY folder and all its contents. Default false." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a SURGICAL edit to an existing text/code file in the connected LOCAL folder: replace an exact snippet with new text. PREFER THIS over write_file when changing part of a file — you pass only the snippet, not the whole file (safer, no risk of corrupting the rest). old_text must match EXACTLY (whitespace/indentation included) and must be UNIQUE in the file (include surrounding context if needed), or the edit is refused. It never creates a file. Requires WRITE access; ALWAYS asks for approval (shows a diff).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the connected root." },
          old_text: { type: "string", description: "The EXACT existing text to replace (copy it from read_file, including indentation). Must be unique unless replace_all is true." },
          new_text: { type: "string", description: "The replacement text (empty string deletes the matched snippet)." },
          replace_all: { type: "boolean", description: "Replace EVERY occurrence of old_text. Default false (requires a unique match)." }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search the connected LOCAL folder's text/code files by REGEX and get path:line:matched-line hits — the 'where is this defined/used?' tool. Much faster than list_files + read_file when hunting a symbol, string, or pattern across a codebase. Skips vendor/build dirs and binaries. Read-only.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex to search for (e.g. 'function\\\\s+parseFoo', 'TODO', 'api_key')." },
          path: { type: "string", description: "Optional subfolder to limit the search to (relative to root). Omit to search the whole folder." },
          glob: { type: "string", description: "Optional filename filter, e.g. '*.js' or '*.{ts,tsx}'." },
          case_sensitive: { type: "boolean", description: "Case-sensitive match. Default false." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a SHELL command (npm/yarn/pnpm, git, node, python, tests, builds, linters) on the local machine and get back stdout, stderr, and the exit code. This is how you VERIFY a code change actually works — run the tests/build after editing. Requires the desktop-server running AND 'Run commands' enabled in Options. ALWAYS asks for approval on every command (even in act-without-asking mode). Runs in the configured project directory unless you pass cwd. Use git through this (git status/diff/log/add/commit). Not for long-lived servers (it waits for the command to exit); default timeout 120s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command, e.g. 'npm test', 'git status', 'git diff HEAD~1', 'python -m pytest -q'. Chaining with && is fine." },
          cwd: { type: "string", description: "Absolute working directory. Omit to use the project directory from Options." },
          timeout_s: { type: "integer", description: "Max seconds to wait (default 120, max 600). The process tree is killed on timeout." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description: "Call ANY HTTP(S) API and get the status + response body back — a generic API client for testing endpoints, webhooks, and REST services (not just ServiceNow). GET is read-only; other methods (POST/PUT/PATCH/DELETE) CHANGE remote state and ALWAYS ask for approval. The response body is capped. Do NOT put secrets the user hasn't given you in the request. For ServiceNow prefer the sn_* tools (they handle auth).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http:// or https:// URL." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], description: "HTTP method. Default GET." },
          headers: { type: "object", description: "Optional request headers as a flat object, e.g. { \"Authorization\": \"Bearer …\", \"Content-Type\": \"application/json\" }." },
          body: { type: "string", description: "Optional request body (string; JSON-stringify objects yourself). Ignored for GET/HEAD." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Fetch a web page IN THE BACKGROUND (a GET) and return its readable text — WITHOUT touching or navigating your active tab. Use this for research/reading source pages so you don't disrupt what the user is looking at. Returns title + extracted text (scripts/styles stripped). For pages requiring the user's login/session, use navigate + read_page instead (fetch_page has no page cookies). Read-only.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http:// or https:// URL to fetch." },
          max_chars: { type: "integer", description: "Max characters of text to return (default 8000)." },
          offset: { type: "integer", description: "Skip this many characters before returning (default 0). PAGE THROUGH a long file (e.g. a huge CSS/JS source) by re-calling with offset = the previous response's next_offset instead of giving up at the truncation cap." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_pdf",
      description: "Read a PDF and return its REAL text. Works on (1) a web URL: direct https://…​.pdf, or the chrome-extension://… viewer URL of the current PDF tab (unwrapped automatically); (2) a LOCAL FILE by absolute path (C:\redacted\path); and (3) a file in a connected 📁 Local files (MCP) folder by its RELATIVE path exactly as list_files shows it (e.g. 'Records/scan.pdf') — for (2) and (3) the desktop-server extracts the text with PyMuPDF and automatically OCRs scanned pages with Tesseract, so even image-only PDFs return exact text (needs the desktop-server running). PREFER this over scrolling+screenshotting a PDF preview (email attachments: download or use the saved copy, then read_pdf its local path — ONE call replaces dozens of screenshots), and use it when read_file returns garbled/unreadable PDF content. Read-only.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The PDF to read: a direct https://…​.pdf, a chrome-extension://…/https://…​.pdf viewer URL, an ABSOLUTE local path (C:\\redacted\\path), or a path RELATIVE to a connected 📁 Local files (MCP) folder (Records/scan.pdf)." },
          max_chars: { type: "integer", description: "Max characters of text to return (default 12000)." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_console",
      description: "RCA evidence: read the page's captured console ERRORS/WARNINGS (real JavaScript exceptions, uncaught errors, unhandled promise rejections) from the active/bound tab — top frame AND iframes. This is how you see WHY a page is broken; read_page cannot show these. Captured from page load onward — if the tool says the tap isn't installed, navigate to the page URL (reload), reproduce the failure, and read again. Read-only.",
      parameters: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["error", "warn", "all"], description: "Filter by severity. Default 'all'." },
          pattern: { type: "string", description: "Optional case-insensitive regex to filter entries (e.g. 'TypeError|undefined')." },
          limit: { type: "integer", description: "Max entries (most recent first cut, default 50, max 200)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_network",
      description: "RCA evidence: read the FAILED network requests (HTTP 4xx/5xx and connection errors) recorded for the active/bound tab — URL, method, status/error, time. This is how you see WHICH request broke a page (401/403 = auth/ACL, 404 = wrong URL, 5xx = server side). Only failures are recorded, from when the extension loaded onward — if empty, reproduce the problem (reload / trigger the failing action) and read again. Read-only.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Optional case-insensitive regex to filter by URL, status, or error (e.g. 'api/now|403')." },
          limit: { type: "integer", description: "Max entries (default 50, max 200)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_recent_changes",
      description: "RCA evidence (ServiceNow, read-only): list what CUSTOMIZATIONS changed on the instance in a time window — business rules, client scripts, forms, ACLs, properties (sys_update_xml: name, type, who, when, update set). THE first question when something broke: what changed right before? Pass record_sys_id to also get field-level value changes for that one record (sys_audit). Needs a connected instance or logged-in SN tab (same as sn_query_table).",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "integer", description: "Look-back window in hours (default 24, max 720). Ignored if 'since' is given." },
          since: { type: "string", description: "Optional absolute start 'YYYY-MM-DD HH:MM:SS' (instance time) instead of 'hours'." },
          user: { type: "string", description: "Optional: only changes by this user id (sys_updated_by)." },
          name_contains: { type: "string", description: "Optional: only changes whose artifact name contains this text." },
          record_sys_id: { type: "string", description: "Optional 32-hex sys_id: also return field-level audit history for that record." },
          limit: { type: "integer", description: "Max rows per list (default 20, max 50)." },
          instance: { type: "string", description: "Optional connected instance name (e.g. 'dev000000'); omit to use the current SN tab." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_compare_record",
      description: "Cross-instance diff (ServiceNow, read-only): fetch the SAME record from TWO connected instances and return only the fields whose stored values DIFFER — the 'works in dev, broken in test' tool. Identify the record by sysId (32-hex; sys_ids usually match across cloned instances) or exact name. Both instances must be connected in the side panel ('🔌 ServiceNow (MCP)'). Volatile audit fields (sys_updated_on etc.) are reported separately from real drift.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table holding the record, e.g. sys_script, sys_script_include, sys_properties." },
          sysId: { type: "string", description: "32-hex sys_id of the record (preferred)." },
          name: { type: "string", description: "Exact value of the 'name' field, when the sys_id differs/is unknown." },
          fields: { type: "string", description: "Optional comma-separated fields to compare (default: all)." },
          instance_a: { type: "string", description: "First connected instance name (e.g. 'dev000000')." },
          instance_b: { type: "string", description: "Second connected instance name." }
        },
        required: ["table", "instance_a", "instance_b"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_note",
      description: "Persist a named note that SURVIVES across runs, sessions, and browser restarts (stored locally in the extension). Use for WATCH/monitoring tasks (save a snapshot of what you observed so the next scheduled run can compare), for long multi-session work, or when the user says 'remember this'. Overwrites the note of the same name; pass empty content to DELETE a note. Not for file output — use write_file for that.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short note name (key), e.g. 'watch-dashboard-snapshot' or 'project-context'." },
          content: { type: "string", description: "The note text (max 20,000 chars). Empty string deletes the note." }
        },
        required: ["name", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_note",
      description: "Read a note saved with save_note (persists across runs/restarts). Call WITHOUT a name to LIST all saved notes. For a scheduled WATCH task: get_note the previous snapshot FIRST, compare with what you observe now, alert (e.g. send_email) only on a real change, then save_note the new snapshot.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The note name. Omit to list all notes (names + sizes + timestamps)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_document",
      description: "Create a formatted DOCUMENT from Markdown and SAVE it into the user's connected LOCAL folder. Renders common Markdown (headings, **bold**/*italic*, `code`, fenced code blocks, bullet/numbered lists) into a real Word .docx or a PDF, or saves the raw Markdown as .md. (Tables and blockquotes are NOT specially formatted — they save as plain text; for .md they remain valid Markdown.) Use this when the user asks for a REPORT / write-up / export 'as Word', 'as a PDF', or 'as a document' — NOT for source-code files (use write_file for those). Path is RELATIVE to the connected root; missing parent folders are created. Requires the folder connected with WRITE access; the user APPROVES every document. OVERWRITES if the file exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the connected root, e.g. 'reports/summary.docx'. No leading slash, no '..'. If the extension is missing or doesn't match 'format', the correct extension is appended." },
          content: { type: "string", description: "The FULL document body as Markdown. Use # / ## headings, **bold**, tables, - bullets, ```code``` etc. — they are rendered into the chosen format." },
          format: { type: "string", enum: ["docx", "pdf", "md"], description: "Output format: 'docx' (Word), 'pdf', or 'md' (raw Markdown). Default 'docx'." }
        },
        required: ["path", "content", "format"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_query_table",
      description: "ServiceNow MCP (read-only): query ANY table on the ServiceNow instance the user is logged into (the active ServiceNow tab) by an encoded query, to find REAL records and their sys_ids. This is how you GROUND a solution in the instance instead of inventing names/sys_ids. Examples: sys_db_object (tables), sys_dictionary (fields), sys_choice (stored choice values), sys_script (business rules), sys_ux_list, interaction, incident. Returns records with stored values + display values + sys_ids.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name, e.g. incident, sys_script, sys_choice, sys_db_object." },
          query: { type: "string", description: "Optional ServiceNow ENCODED query. ^=AND, ^OR=OR, ^NQ=new OR-group. e.g. 'active=true^priority=1', 'name=incident^element=state' (choices for incident.state). Omit to list the first records." },
          fields: { type: "string", description: "Optional comma-separated fields to return (e.g. 'number,short_description,sys_id'). Omit for all fields. Keep sys_id." },
          limit: { type: "number", description: "Max records (default 10, max 50)." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host (e.g. 'dev000000') WITHOUT an open tab — resolves to its stored connection. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_query_record",
      description: "ServiceNow MCP (read-only): fetch ONE record by its number (e.g. INC0012345, CHG0001234, RITM0005678) from the logged-in instance. Returns all fields with values + display values. The table is inferred from the prefix.",
      parameters: {
        type: "object",
        properties: {
          recordNumber: { type: "string", description: "Record number including prefix, e.g. INC0012345." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host (e.g. 'dev000000') WITHOUT an open tab. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["recordNumber"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_query_schema",
      description: "ServiceNow MCP (read-only): get field definitions for a table from sys_dictionary on the logged-in instance — field name, label, type, max length, reference target, mandatory, default. Use this to confirm REAL field names/types before building a query or solution.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name, e.g. incident, change_request." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host (e.g. 'dev000000') WITHOUT an open tab. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_fetch_script_by_name",
      description: "ServiceNow MCP (read-only): get the COMPLETE script body of a ServiceNow artifact by its name and type — great for reviewing a Business Rule, Script Include, Client Script, etc. against the live instance. Returns the full, untruncated source.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact artifact name (e.g. 'Calculate Priority')." },
          artifactType: { type: "string", enum: ARTIFACT_TYPES, description: "Artifact type, e.g. business_rule, script_include, client_script, ui_action." },
          targetTable: { type: "string", description: "Optional: the table the artifact is on (e.g. incident) — improves precision for table-scoped types." }
        },
        required: ["name", "artifactType"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_fetch_script_by_sysid",
      description: "ServiceNow MCP (read-only): get the COMPLETE script/record by its sys_id and table — use when you already have a sys_id from a prior query or search.",
      parameters: {
        type: "object",
        properties: {
          sysId: { type: "string", description: "The 32-char sys_id of the record." },
          table: { type: "string", description: "The table to read from (e.g. sys_script, sys_script_include, sys_script_client)." }
        },
        required: ["sysId", "table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_wf_activity_vars",
      description: "ServiceNow MCP (read-only): read a CLASSIC WORKFLOW activity's INPUT VALUES — the Catalog Task / Create Task activity's advanced_script (the task.short_description = … script), short_description, description, values (Set Values), assignment_group; a Run Script's script; an Approval's groups — as ONE element→value map per activity. THIS is how you read an activity's script: those inputs are NOT columns on wf_activity (querying wf_activity for advanced_script/script/vars/input returns nothing) and NOT in wf_activity_variable (that is the input model, no values); they are sys_variable_value rows (document=wf_activity, document_key=<activity sys_id>), which this tool joins for you. Pass activity_sys_id (one or a comma list) OR workflow_version (the wf_workflow_version sys_id = the sysparm_sys_id in a workflow_ide.do URL) to get EVERY activity of that version in one call. Do not read the workflow canvas or click activity nodes to get a script — call this. Works over REST, and falls back to the logged-in tab session on a 401.",
      parameters: {
        type: "object",
        properties: {
          activity_sys_id: { type: "string", description: "One wf_activity sys_id, or several comma-separated (max 60). Get them from sn_query_table {table:'wf_activity', query:'workflow_version=<v>', fields:'sys_id,name,activity_definition'} — or skip that and pass workflow_version instead." },
          workflow_version: { type: "string", description: "A wf_workflow_version sys_id — read all of its activities at once. The published version is the live one (wf_workflow_version.published=true); a checked-out draft has published=false." },
          element: { type: "string", description: "Optional comma list of input names to return, e.g. 'advanced_script,values,short_description,description'. Omit for every non-empty input." },
          max_chars: { type: "number", description: "Per-value cap (default 6000, max 60000). Values longer than this are truncated with a marker; re-call with element:'<name>' and a higher cap for the full text." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host WITHOUT an open tab. Omit to use the current/bound ServiceNow tab." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_search_script_body",
      description: "ServiceNow MCP (read-only): search INSIDE script bodies (source code) for a keyword/pattern across artifact types — finds artifacts by what they DO (e.g. 'GlideRecord(\"sys_user\")', 'getManager', 'current.assigned_to'). Returns matching artifacts with a snippet around the matching line + their sys_ids (then drill in with sn_fetch_script_by_name/sysid). Use multiple calls with different patterns for best coverage.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Code pattern/keyword to find inside script bodies (2–200 chars)." },
          artifactTypes: { type: "array", items: { type: "string", enum: ARTIFACT_TYPES }, description: "Up to 5 artifact types to search (e.g. ['script_include','business_rule','client_script']). Defaults to those three." },
          artifactType: { type: "string", enum: ARTIFACT_TYPES, description: "A single artifact type to search (use artifactTypes for several)." },
          targetTable: { type: "string", description: "Optional: limit to artifacts on this table (e.g. incident)." },
          includeInactive: { type: "boolean", description: "Include inactive artifacts. Default false (active only)." }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_update_record",
      description: "ServiceNow MCP (WRITE): update ONE record by its sys_id on a given table — the only tool that CHANGES the instance. Use it to set/append field values (e.g. add a note to a description, change state). You MUST already have the sys_id (get it first with sn_query_table or sn_query_record); this NEVER updates by query, to avoid mass/wrong writes. In 'ask' mode the user must approve; it is fully DISABLED in read-only mode. System columns (sys_id, sys_updated_on, sys_created_*, sys_mod_count) cannot be set. Returns the updated record.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name, e.g. incident, change_request, sys_user." },
          sysId: { type: "string", description: "The 32-hex-char sys_id of the record to update (from a prior query). NOT the record number." },
          fields: { type: "object", description: "Object of field→value to set, e.g. { \"description\": \"updated text\", \"state\": \"2\" }. Pass STORED values (the same values sn_query_* returns: sys_ids for reference fields, stored values for choices) unless inputDisplayValue is true." },
          inputDisplayValue: { type: "boolean", description: "Optional. Set true if the values in 'fields' are human display labels (e.g. state: 'In Progress') instead of stored values. Default false (stored values)." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host (e.g. 'dev000000') WITHOUT an open tab — resolves to its stored connection. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["table", "sysId", "fields"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_create_record",
      description: "ServiceNow MCP (WRITE): create ONE record via POST Table API. Intended for AUTHORING tables — above all the legacy-workflow build plan (wf_workflow_version with the workflow field omitted, then wf_activity, sys_variable_value, wf_transition, wf_stage) where server business rules auto-scaffold the rest — and other config records; for TASK-type records on an open form prefer the UI path (fill + save_record) so client scripts/UI policies run. Other tables are not blocked, but check for duplicates first (sn_check_duplicate / sn_query_table) and NEVER insert into engine-owned runtime tables (wf_context, wf_executing, wf_history). In 'ask' mode the user must approve; fully DISABLED in read-only mode. Returns the new sys_id + display value — verify by querying the record back before building on it.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table to insert into, e.g. wf_workflow_version, wf_activity, wf_transition, sys_variable_value." },
          fields: { type: "object", description: "Object of field→value for the new record, e.g. { \"name\": \"My workflow\", \"table\": \"incident\", \"published\": \"false\" }. Pass STORED values (sys_ids for references) unless inputDisplayValue is true. System columns (sys_id, sys_created_*, …) are dropped." },
          inputDisplayValue: { type: "boolean", description: "Optional. Set true if the values in 'fields' are human display labels instead of stored values. Default false." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host (e.g. 'dev000000') WITHOUT an open tab. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["table", "fields"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_wf_activity_set",
      description: "ServiceNow MCP (WRITE): CHANGE a classic-workflow activity's INPUTS — a Catalog Task / Create Task's advanced_script (task.short_description = …), values (Set Values, e.g. assignment_group=<sys_id>^description=<text>^EQ), short_description, description; a Run Script's script — and VERIFY the stored values, all in ONE call. Pass the wf_activity sys_id from a CHECKED-OUT DRAFT version (published=false; published versions are refused) and an inputs object of element→new value (element names exactly as sn_wf_activity_vars returns them; multi-line text is fine). It writes over the API where the instance allows it and otherwise through the activity's own form in your signed-in tab (the same form the Workflow Editor's double-click dialog opens), then re-reads sys_variable_value and reports per input: verified / unchanged / refused / not_persisted. USE THIS instead of sn_update_record on sys_variable_value (customer instances ACL that table → 403), instead of the sys_variable_value form (Value renders read-only), and instead of hunting the Workflow Editor dialog with DOM tools. In 'ask' mode the user must approve; DISABLED in read-only mode. Publish afterwards with sn_wf_publish (never the Workflow Editor menu).",
      parameters: {
        type: "object",
        properties: {
          activity_sys_id: { type: "string", description: "The wf_activity sys_id of the node to change, on the checked-out draft (from sn_wf_activity_vars {workflow_version:'<draft>'} — activities keep their names but get NEW sys_ids in each version)." },
          inputs: { type: "object", description: "element → new value, e.g. { \"advanced_script\": \"…full script…\", \"values\": \"assignment_group=16c8…^description=Line 1\\nLine 2^EQ\" }. Give the COMPLETE new value for each input (it replaces the stored one), keeping any part of the current value that must stay (e.g. the assignment_group in values)." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host. Omit to use the current/bound ServiceNow tab (needed anyway for the form route)." }
        },
        required: ["activity_sys_id", "inputs"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_wf_delete_activity",
      description: "ServiceNow MCP (WRITE, always needs approval): REMOVE one activity node from a CHECKED-OUT DRAFT workflow version and keep the graph connected — its incoming transitions are re-pointed at rewire_to (normally the node it currently leads to), the activity is deleted with its conditions / transitions / input rows, and the graph is read back to confirm. Refused on published versions and on Begin/End. Use this for 'delete the X task/activity from the workflow' — the Workflow Editor canvas has no DOM for delete/link, so do not click around it. Publish afterwards with sn_wf_publish (pre-flight + publish + cache flush), never the Workflow Editor menu.",
      parameters: {
        type: "object",
        properties: {
          activity_sys_id: { type: "string", description: "The wf_activity sys_id of the node to delete (draft version)." },
          rewire_to: { type: "string", description: "wf_activity sys_id the deleted node's INCOMING transitions should point at instead — usually the node the deleted one leads to (its outgoing transition's `to`). Required when the node has incoming transitions, unless orphan_ok is true." },
          orphan_ok: { type: "boolean", description: "true = delete the incoming transitions instead of re-pointing them (the branches that led here end). Default false." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["activity_sys_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_wf_fix_script",
      description: "ServiceNow MCP (WRITE): the ALTERNATIVE when ServiceNow refuses the direct writes — generate a FIX SCRIPT (sys_script_fix) that edits a classic workflow's checked-out DRAFT server-side with GlideRecord (no table ACLs apply there, so it succeeds where sn_update_record / sn_wf_activity_set / sn_wf_delete_activity get 403 or read-only fields), create the record on the instance, and return the one 'Run Fix Script' step + verification. Describe the whole story in one call: set = activities (by NAME within the draft) with the COMPLETE new value per input (advanced_script, task_set_values, task_short_description, …), remove = activities to delete with the node their incoming transitions should lead to instead. The script is idempotent (a second run changes nothing) and logs each change under a [STRYnnnn] tag. Publish with publish:true in the same script, or afterwards with sn_wf_publish. In 'ask' mode the user must approve; DISABLED in read-only mode.",
      parameters: {
        type: "object",
        properties: {
          workflow_version: { type: "string", description: "The checked-out DRAFT's wf_workflow_version sys_id (published=false)." },
          name: { type: "string", description: "Fix Script name, e.g. 'STRY0000001 Update SCTASK text - R7 User' — start with the story number." },
          set: { type: "array", items: { type: "object", properties: { activity: { type: "string" }, inputs: { type: "object" } }, required: ["activity", "inputs"] }, description: "[{activity:'Active Directory', inputs:{advanced_script:'…complete script…', task_set_values:'assignment_group=…^description=…^EQ'}}, …]. Activity = its exact name in the draft (or its sys_id)." },
          remove: { type: "array", items: { type: "object", properties: { activity: { type: "string" }, rewire_to: { type: "string" } }, required: ["activity"] }, description: "[{activity:'Update R7 UG Group Lists', rewire_to:'Wait for all catalog tasks to be closed.'}] — rewire_to = the activity the deleted node's incoming transitions should point at (omit to drop them)." },
          description: { type: "string", description: "Optional record description (defaults to a summary of the changes)." },
          publish: { description: "Optional. true (or an object {condition_type, condition}) = the same script also PUBLISHES the version (condition_type run_match, validated, checked out cleared) and flushes the workflow caches (GlideCacheManager.flushTable) after the edits — use when the API publish was refused or read back false. May be the only change (re-publish + flush after an edit)." },
          create: { type: "boolean", description: "Default true: create the sys_script_fix record. false = only return the generated script text." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host. Omit to use the current/bound ServiceNow tab." }
        },
        required: ["workflow_version"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_wf_publish",
      description: "ServiceNow MCP (WRITE): PUBLISH a classic (legacy) workflow version so that it actually RUNS — the ONLY publish route to use. In one call: graph pre-flight (transitions with an empty 'to', unreachable nodes, dead ends — blockers stop the publish), condition sanity (the version's condition is an ENCODED QUERY; JavaScript there is refused), condition_type defaulted to run_match, PATCH published=true + validated + checkout cleared, read-back, and the CACHE FLUSH the Table API skips (loads <instance>/cache.do in your signed-in tab, then returns the tab to its page; without a tab the fallback Fix Script flushes with GlideCacheManager). A refused or silently-ignored publish falls back to a publish Fix Script automatically. Live lesson 2026-09-04: a version published over the API read back true and started NOTHING for six test incidents until the cache was flushed. After this call create ONE test record and read wf_context back; count 0 then means the condition/table does not match — not a stale cache. In 'ask' mode the user must approve; DISABLED in read-only mode.",
      parameters: {
        type: "object",
        properties: {
          workflow_version: { type: "string", description: "The wf_workflow_version sys_id to publish (the draft you built), or an already-published version to re-publish + flush after an edit." },
          condition: { type: "string", description: "Optional ENCODED QUERY to store as the version's condition, e.g. 'sys_mod_count=0' (insert-only proxy) or '' (run on every insert/update; gate inside the graph with an If activity). Omit to keep the stored one. Never JavaScript." },
          condition_type: { type: "string", description: "Optional. run_match (default: run the workflow whenever the condition matches) | run_if_no_other." },
          force: { type: "boolean", description: "Optional. true = publish even when the graph pre-flight found blockers (you have verified they are intentional). Default false." },
          instance: { type: "string", description: "Optional. Target a CONNECTED instance by name/host. Omit to use the current/bound ServiceNow tab (needed for the cache.do flush)." }
        },
        required: ["workflow_version"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_session_max_loss",
      description: "Day-trading RISK POSTURE (TIGHTEN-ONLY): lower TODAY's session max-loss cap based on market insights (elevated VIX, choppy tape, losing morning). Server-enforced guardrails: the cap can NEVER loosen past the operator's dashboard ceiling (403), floor is $100 (a tighter cap is a de facto halt — recommend the operator halt instead), max 3 material changes/day with 5 minutes between changes, every change is audited, and the cap auto-expires at the ET session boundary. You have NO access to the hard BLOCK/FLATTEN ladder or stage selection. Only works while on the Day Trading page OR the Live Trading page — targets whichever module owns the active page. Always include a concrete market-insight rationale.",
      parameters: {
        type: "object",
        properties: {
          maxLoss: { type: "number", description: "New session max-loss cap in positive dollars, e.g. 300. Must be <= the operator ceiling and >= 100." },
          rationale: { type: "string", description: "Concrete market-insight justification (min 10 chars), e.g. 'VIX 28 + first trade stopped out — halving daily budget'." }
        },
        required: ["maxLoss", "rationale"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sn_login",
      description: "Log into a ServiceNow instance on the CURRENT/bound tab using STORED credentials. Use this whenever you land on a ServiceNow login page ('Log in | ServiceNow', with User name + Password fields) — it fills the username + password from the matching connected instance (🔌 ServiceNow MCP) and clicks Log in. DO NOT try to type the password yourself: you do not have it, and the login form is often NOT pre-filled (clicking Log in on empty fields gives 'Invalid input in user name!'). After calling, read_page once to confirm you reached the authenticated app. The instance is taken from the tab's URL; pass `instance` to override which stored credentials to use.",
      parameters: {
        type: "object",
        properties: {
          instance: { type: "string", description: "Optional. Instance name/host (e.g. 'dev000000') selecting which stored credentials to use. Defaults to the current tab's instance." }
        }
      }
    }
  },
  // -------------------------------------------------------------------------
  // Windows DESKTOP CONTROL (desktop_*) — OS-level mouse/keyboard/screenshot via
  // the local desktop-server bridge. These reach OUTSIDE the browser sandbox
  // (native apps, taskbar, other windows), so they are OPT-IN (Settings →
  // "Enable desktop control", OFF by default): when disabled they are hidden
  // from the model and hard-refused at the executor. Every mutating desktop
  // action also routes through the normal approval prompt. Coordinates are the
  // full-screen pixel space returned by desktop_screenshot (its `width`/`height`).
  // -------------------------------------------------------------------------
  {
    type: "function",
    function: {
      name: "desktop_screenshot",
      description: "SEE THE WHOLE WINDOWS DESKTOP (not just the browser tab): captures the primary screen and a local vision model describes it. Use this to look at native apps, the taskbar, dialogs, or any window outside the browser, and to find where things are before clicking. Returns a description PLUS the true screen `width`/`height` in pixels — desktop_click/desktop_move_mouse use that same pixel coordinate space. Requires desktop control to be enabled in Settings and the desktop-server running. EFFICIENCY — do NOT screenshot after every action (that wastes steps): act, and take ONE screenshot only when you need to LOCATE something you can't predict or VERIFY the end result. PREFER KEYBOARD FLOWS over click-by-coordinate (a click needs a screenshot to find the target; a keystroke does not). To open an app: press Win+R, type the app name (e.g. 'notepad'), press Enter — then type your text directly; this opens+focuses the app and needs NO screenshot. Take a single final screenshot to confirm the result. The final screenshot's description is recorded as citable evidence of completion.",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "Optional: what to look for, e.g. 'the Save button' or 'the Start menu search box'." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_get_screen_size",
      description: "Return the primary screen's pixel dimensions { width, height } (the coordinate space for desktop_click/desktop_move_mouse). Cheap; use it to sanity-check bounds without a full screenshot.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_move_mouse",
      description: "Move the OS mouse pointer to absolute screen pixel coordinates (0,0 = top-left). Use desktop_screenshot first to locate the target; coordinates are clamped to the screen. Does NOT click.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "X pixel (0 = left edge)." },
          y: { type: "integer", description: "Y pixel (0 = top edge)." }
        },
        required: ["x", "y"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_click",
      description: "Click the OS mouse. Give x,y (absolute screen pixels from desktop_screenshot) to click there, or omit both to click at the current pointer position. DESTRUCTIVE — asks for approval. Locate the target with desktop_screenshot first.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "Optional X pixel to click at. Omit (with y) to click where the pointer already is." },
          y: { type: "integer", description: "Optional Y pixel to click at." },
          button: { type: "string", description: "'left' (default), 'right', or 'middle'." },
          clicks: { type: "integer", description: "1 (default) or 2 for a double-click." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_click_hold",
      description: "A FIRM OS click: moves to x,y, real mouse-down, a deliberate pause (default 120ms), mouse-up. Use when a normal click gets swallowed by an SPA widget (e.g. ServiceNow Workflow Studio menus/buttons — click_element ok:true but nothing opens, or desktop_click did nothing). Optionally give hold_ms for a longer press, and x2,y2 to release at a DIFFERENT point (press-open menus that select on release). DESTRUCTIVE — asks for approval. Locate targets with desktop_screenshot first.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "X pixel to press at (from desktop_screenshot). Omit with y to press at the current pointer." },
          y: { type: "integer", description: "Y pixel to press at." },
          hold_ms: { type: "integer", description: "How long to hold the button down before release, in ms (default 120; max 3000)." },
          x2: { type: "integer", description: "Optional X pixel to move to WHILE HELD and release at (press-drag-release menus)." },
          y2: { type: "integer", description: "Optional Y pixel to release at." },
          button: { type: "string", description: "'left' (default), 'right', or 'middle'." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_type",
      description: "Type text on the OS keyboard into whatever window/field currently has focus (click it first with desktop_click). Types literal characters — for Enter/Tab/shortcuts use desktop_press_keys. DESTRUCTIVE — asks for approval.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The literal text to type into the focused field." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_press_keys",
      description: "Press a single key or a keyboard chord globally, e.g. 'enter', 'escape', or ['ctrl','c'] to copy, ['alt','tab'] to switch windows, ['win'] to open Start. DESTRUCTIVE — asks for approval. Use desktop_type for ordinary text.",
      parameters: {
        type: "object",
        properties: {
          keys: {
            description: "A key name string ('enter', 'ctrl+s'), or an array of key names to press together (['ctrl','shift','esc']).",
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ]
          }
        },
        required: ["keys"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_scroll",
      description: "Scroll the OS mouse wheel at the pointer (or at x,y if given). Positive amount scrolls UP, negative scrolls DOWN. This scrolls the native focused window — for a web page prefer the browser scroll_page tool.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "integer", description: "Wheel clicks; positive = up, negative = down (e.g. -500 scrolls down)." },
          x: { type: "integer", description: "Optional X pixel to scroll at." },
          y: { type: "integer", description: "Optional Y pixel to scroll at." }
        },
        required: ["amount"]
      }
    }
  },
  ...SHORTCUT_TOOLS
];

// Desktop-control tool names (used for gating: hidden when the toggle is off,
// blocked on M1, mutating ones require approval). Kept as a plain set so both
// tools.js (executor guard) and background.js (list filtering) can reference it.
export const DESKTOP_TOOL_NAMES = new Set([
  "desktop_screenshot", "desktop_get_screen_size", "desktop_move_mouse",
  "desktop_click", "desktop_click_hold", "desktop_type", "desktop_press_keys", "desktop_scroll"
]);
// The subset that changes OS state (drives mouse/keyboard). These go through the
// approval gate; the other two (screenshot, get_screen_size) are read-only.
export const DESKTOP_ACTION_TOOL_NAMES = new Set([
  "desktop_move_mouse", "desktop_click", "desktop_click_hold", "desktop_type", "desktop_press_keys", "desktop_scroll"
]);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab found.");
  // The owner opening the extension's own Options/side-panel page (or a chrome://
  // page) mid-run must not hijack the task tab: a-live-run (2026-09-02) navigated
  // "to" the activity form, then every page tool hit chrome-extension://…/options.html
  // ("Cannot access contents of url"). Fall back to the most recently used web tab
  // in that window — the page the run was working on.
  if (!/^https?:\/\//i.test(tab.url || "")) {
    try {
      const web = (await chrome.tabs.query({ windowId: tab.windowId }))
        .filter((t) => /^https?:\/\//i.test(t.url || ""))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (web[0]) return web[0];
    } catch {}
  }
  return tab;
}

// Injected into a ServiceNow LOGIN page to fill credentials + submit. Self-contained
// (runs in the page via chrome.scripting) — receives user/pass as args so the
// password is never built into a string the model can see. Returns a small status.
function snFillLoginInPage(user, pass) {
  const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
  const uEl = pick(["#user_name", 'input[name="user_name"]', 'input[name="username"]', "#username"]);
  const pEl = pick(["#user_password", 'input[name="user_password"]', 'input[type="password"]']);
  if (!uEl || !pEl) return { ok: false, error: "Login fields not found — this may not be a ServiceNow login page." };
  const setVal = (el, v) => {
    try { el.focus(); } catch (e) {}
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setVal(uEl, user);
  setVal(pEl, pass);
  const btn = pick(["#sysverb_login", 'button[id="sysverb_login"]', 'button[type="submit"]', 'input[type="submit"]']);
  if (btn) { try { btn.click(); } catch (e) { return { ok: true, submitted: false, error: "Filled fields but clicking Log in failed: " + e.message }; } return { ok: true, submitted: true, via: btn.id || btn.tagName }; }
  const form = uEl.form || document.querySelector("form");
  if (form) { try { form.submit(); } catch (e) { return { ok: true, submitted: false, error: "Filled fields but form submit failed." }; } return { ok: true, submitted: true, via: "form.submit" }; }
  return { ok: true, submitted: false, error: "Filled fields but found no Log in button or form." };
}

// Run the stored-credential ServiceNow login on a tab. Shared by the sn_login tool
// AND the click_element interception (clicking the Log in button auto-routes here).
// Resolves credentials by instance hint with a shared-credential fallback (all PDIs
// often share one admin/password). The password is injected into the page via
// executeScript args — it never enters the model context.
async function performSnLogin(tabId, instanceHint) {
  const hint = String(instanceHint || "").toLowerCase();
  const conns = await getSnConnections();
  if (!conns.length) return { error: "No ServiceNow credentials stored. Add the instance(s) in the side panel → 🔌 ServiceNow (MCP), then retry." };
  const conn = conns.find((c) => {
    const o = c.url.toLowerCase(); let host = ""; try { host = new URL(c.url).hostname.toLowerCase(); } catch {}
    return o === hint || o.includes(hint) || (host && (host.includes(hint) || hint.includes(host)));
  }) || conns[0];
  if (!conn.username) return { error: `Stored connection ${conn.url} has no username — re-enter it in 🔌 ServiceNow (MCP).` };
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: snFillLoginInPage, args: [conn.username, conn.password || ""] });
    const res = (r && r.result) || { ok: false, error: "No result from the login page." };
    if (!res.ok) return { error: res.error || "Could not fill the login form." };
    return { instance: conn.url, username: conn.username, submitted: !!res.submitted, via: res.via, note: "Submitted login with stored credentials. Call read_page once to confirm you reached the authenticated app (no login form = success)." };
  } catch (e) {
    return { error: "sn_login failed: " + e.message };
  }
}

// Read the ServiceNow CSRF user token (window.g_ck) from a logged-in SN tab. Needed
// as X-UserToken on session-cookie writes (sn_update_record). MAIN world so we can
// see the page's globals. Returns "" if unavailable (no token / not an SN page).
async function snUserToken(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          if (typeof window.g_ck === "string" && window.g_ck) return window.g_ck;
          if (window.NOW && typeof window.NOW.g_ck === "string") return window.NOW.g_ck;
        } catch {}
        return "";
      }
    });
    return (r && typeof r.result === "string") ? r.result : "";
  } catch {
    return "";
  }
}

// Drive a classic ServiceNow FORM in a signed-in tab for sn_wf_activity_set: open
// a .do URL (with the same 404 self-heal navigate has), run a MAIN-world page
// function in whichever frame holds g_form, and save-and-wait-for-reload. The
// tool logic itself lives in sn-tools.js (snWorkflowActivitySet) and only sees
// these three callbacks, so it stays unit-testable without chrome.*.
// Flush the instance's server cache the way the 2026-09-04 run finally did it by
// hand: load <origin>/cache.do in the signed-in tab (the page flushes on load),
// then return the tab to where it was so the owner keeps following along. Used by
// sn_wf_publish after the version reads back published=true. Reports what the
// page said so a login redirect or an error page is never mistaken for a flush.
function snCacheFlusher(tabId, origin) {
  return {
    async flush() {
      let before = "";
      try { before = (await chrome.tabs.get(tabId)).url || ""; } catch {}
      let text = "", url = "";
      try {
        await chrome.tabs.update(tabId, { url: origin + "/cache.do" });
        await waitForLoad(tabId); // bounded: 15 s default timeout
      } catch (e) {
        return { ok: false, via: "cache.do", error: `could not load cache.do in the tab (${e.message || e})` };
      }
      try {
        url = (await chrome.tabs.get(tabId)).url || "";
        const [r] = await withDeadline(chrome.scripting.executeScript({
          target: { tabId }, func: () => { try { return (document.body && document.body.innerText || "").slice(0, 600); } catch (e) { return ""; } }
        }), 5000, [null]);
        text = (r && typeof r.result === "string") ? r.result : "";
      } catch {}
      const ok = /cache/i.test(text) && !/user_name|login\.do|Log in/i.test(text) && !/login\.do|auth_redirect/i.test(url);
      let restored = false, restoreNote = "";
      if (before && /^https?:\/\//i.test(before) && !/\/cache\.do/i.test(before)) {
        try { await chrome.tabs.update(tabId, { url: before }); await waitForLoad(tabId); restored = true; }
        catch (e) { restoreNote = `the tab was left on cache.do (returning to ${before} failed: ${e && e.message || e})`; }
      } else {
        restoreNote = before && /\/cache\.do/i.test(before) ? "the tab was already on cache.do" : "the tab was left on cache.do (previous page was not an http(s) URL)";
      }
      return ok ? { ok: true, via: "cache.do", page: text.replace(/\s+/g, " ").slice(0, 120), tab_restored: restored, ...(restored ? {} : { note: restoreNote }) }
                : { ok: false, via: "cache.do", error: `cache.do did not render the flush page (${url.includes("login") ? "login redirect" : "unexpected page: " + text.replace(/\s+/g, " ").slice(0, 80)})` };
    }
  };
}

function snFormDriver(tabId) {
  const pickGform = (results) => {
    const all = (results || []).map((r) => r && r.result);
    return all.find((r) => r && r.hasGform) || all.find(Boolean) || null;
  };
  return {
    async open(url) {
      await chrome.tabs.update(tabId, { url });
      await waitForLoad(tabId);
      if (await snPageNotFound(tabId)) {
        const wrapped = wrapSnClassicTarget(url);
        if (wrapped === url) throw new Error('ServiceNow rendered "Page not found" for the activity form');
        await chrome.tabs.update(tabId, { url: wrapped });
        await waitForLoad(tabId);
        await waitForSnClassicFrame(tabId, wrapped);
        if (await snPageNotFound(tabId)) throw new Error('ServiceNow rendered "Page not found" for the activity form (bare and polaris-wrapped)');
      }
      // The variable editor + script editors render after the document's load event.
      for (let i = 0; i < 12; i++) {
        const probe = await withDeadline(chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, world: "MAIN",
          func: () => { try { return { hasGform: !!(window.g_form && window.g_form.setValue), vars: document.querySelectorAll('[id*="vars.var__m_"]').length }; } catch (e) { return null; } }
        }).catch(() => null), 3000, null);
        const r = pickGform(probe);
        if (r && r.hasGform && r.vars > 0) return;
        await new Promise((res) => setTimeout(res, 500));
      }
    },
    async run(func, args) {
      const results = await withDeadline(chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN", func, args
      }), 20000, null);
      if (!results) throw new Error("the activity form did not answer within 20s");
      return pickGform(results);
    },
    async url() { try { return (await chrome.tabs.get(tabId)).url || ""; } catch { return ""; } },
    // g_form.save() submits and ServiceNow reloads the form; arm the load
    // listener BEFORE saving so a fast round-trip is not missed, then give the
    // server a beat before the caller re-reads the rows.
    async saveAndSettle() {
      const reloaded = new Promise((resolve) => {
        let sawLoading = false;
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, 15000);
        function listener(id, info) {
          if (id !== tabId) return;
          if (info.status === "loading") sawLoading = true;
          if (info.status === "complete" && sawLoading) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(true); }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
      const results = await withDeadline(chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN", func: pageSnSave
      }), 10000, null);
      const r = pickGform(results);
      if (!r || !r.hasGform) return { error: "g_form disappeared before the save" };
      if (r.blocked || r.error) return r;
      await reloaded;
      await new Promise((res) => setTimeout(res, 800));
      return { saving: true };
    }
  };
}

// ---------------------------------------------------------------------------
// Desktop control — call the local desktop-server bridge (loopback HTTP). No
// browser tab is involved; these drive the OS mouse/keyboard/screen. Gating
// (opt-in toggle, M1 block, approval) happens in executeTool/background.js; this
// helper is just the transport. Returns { error } on any failure so the agent
// never silently assumes an OS action succeeded.
// ---------------------------------------------------------------------------
const DESKTOP_TIMEOUT_MS = 20000;
// `method` (2026-09-07c): the server's /health route is GET-only, and the bridge
// always POSTed, so desktop_get_screen_size had answered "HTTP 405" since day one
// (owner export 17:56). Everything else on the server is POST.
async function desktopBridge(settings, path, body, timeoutMs, method = "POST") {
  const base = String(settings?.desktopUrl || "http://localhost:8777").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings?.desktopToken) headers["X-Desktop-Token"] = String(settings.desktopToken);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
      // /exec waits for the command to finish — give it the command's own timeout
      // plus 15s bridge overhead, so a 120s test run isn't cut off at 20s.
      signal: AbortSignal.timeout(timeoutMs || DESKTOP_TIMEOUT_MS)
    });
  } catch (e) {
    return { error: `Desktop control could not reach the desktop-server at ${base} (${e.name === "TimeoutError" ? "timed out" : e.message}). Start it with desktop-server\\start-desktop.bat and confirm the URL in Settings.` };
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    if (res.status === 404) {
      return { error: `Desktop control error: HTTP 404 — the running desktop-server does not have the ${path} endpoint (it is an OLD build). TELL THE USER: "restart desktop-server\\start-desktop.bat to load the new endpoints", then continue with other tools meanwhile.` };
    }
    const msg = (data && data.error) || `HTTP ${res.status}`;
    return { error: `Desktop control error: ${msg}` };
  }
  return data || { error: "Desktop control returned an empty response." };
}

// Local PDF → desktop-server /pdftext (PyMuPDF text layer + Tesseract OCR for
// scanned pages). Two source shapes (2026-09-07c): {path} for an ABSOLUTE local
// path, or {base64, name} for bytes the side panel pulled out of a connected
// 📁 Local files (MCP) folder — the File System Access API never reveals that
// folder's disk path, so bytes are the only way its PDFs reach the OCR engine.
// Returns the model-facing result, or {error}.
async function desktopPdfText(settings, src, maxChars) {
  const body = { max_chars: Number.isFinite(maxChars) ? Math.max(1000, maxChars) : undefined };
  if (src.base64) { body.data_b64 = src.base64; body.name = src.name || "document.pdf"; }
  else body.path = src.path;
  const r = await desktopBridge(settings, "/pdftext", body, src.base64 ? 180000 : 120000);
  if (r.error) {
    // A 404 means the RUNNING desktop-server predates /pdftext (live conv
    // 2026-07-23: the model got a bare "HTTP 404" and went flailing).
    if (/HTTP 404/.test(r.error)) {
      return { error: "read_pdf (local file): the desktop-server that is running is an OLD build without the /pdftext endpoint. Tell the user to RESTART it (close the 'Local Desktop Control Server' window, run desktop-server\\start-desktop.bat), then retry this same call. Meanwhile you can read the PDF via run_command with a ONE-LINE python: python -u -c \"import fitz; print(fitz.open(r'<path>').get_page_text(0))\"" };
    }
    // An OLD desktop-server caps request bodies at 8 MB (HTTP 413, non-JSON body): a
    // bytes upload of a scanned PDF is the first thing that ever exceeded it.
    if (src.base64 && /HTTP 413/.test(r.error)) {
      return { error: `read_pdf (connected folder): "${src.name}" is larger than the running desktop-server accepts in one upload (an OLD build caps requests at 8 MB; the current build takes 40 MB). Tell the user in one line to RESTART the desktop-server (close the 'Local Desktop Control Server' window, run desktop-server\\start-desktop.bat) and retry ONCE after that; or pass read_pdf the file's FULL absolute path instead. Do NOT retry this call as-is.` };
    }
    // An older /pdftext knows only {path}: it answers "path required" to a bytes upload.
    if (src.base64 && /path required/i.test(r.error)) {
      return { error: `read_pdf (connected folder): the running desktop-server is an OLD build that reads PDFs only by absolute path, so "${src.name}" from the connected folder cannot be OCR'd until the user RESTARTS it (close the 'Local Desktop Control Server' window, run desktop-server\\start-desktop.bat). Tell the user that in one line. Until then the only way to read this file is read_pdf with its FULL absolute path (ask the user for the folder's disk path if you do not know it) — do NOT retry this call as-is.` };
    }
    return { error: `read_pdf (${src.base64 ? "connected folder" : "local file"}): ${r.error}` };
  }
  if (!r.ok) return { error: `read_pdf (${src.base64 ? "connected folder" : "local file"}): ${r.error || "extraction failed"}` };
  // MM 2026-09-07c P3: a server that answers ok:true without `text` must yield the
  // curated restart message, not a TypeError from `.length`.
  const txt = typeof r.text === "string" ? r.text : "";
  if (!txt) return { error: `read_pdf (${src.base64 ? "connected folder" : "local file"}): the desktop-server returned no text for this PDF. Tell the user to RESTART it (desktop-server\\start-desktop.bat) and retry ONCE after that.` };
  const cap = Number.isFinite(maxChars) ? maxChars : 12000;
  const over = txt.length > cap;
  return {
    path: src.base64 ? (src.display || src.name) : r.path, format: "pdf", pages: r.pages, chars: r.chars,
    ocr_pages: r.ocr_pages && r.ocr_pages.length ? r.ocr_pages : undefined,
    text: over
      ? txt.slice(0, cap) + `\n…[truncated at ${cap} of ${txt.length} chars — re-call ONCE with max_chars: ${txt.length + 1000} to get the WHOLE document]`
      : txt,
    truncated: over || r.truncated,
    note: over ? undefined : "COMPLETE document — you now have every page; extract what you need from this text, do NOT re-read it (no more read_pdf calls, no python page dumps)."
  };
}

// ---------------------------------------------------------------------------
// web_search — a real research primitive. The service worker (host_permissions
// <all_urls>) fetches DuckDuckGo's no-JS HTML endpoint and parses the result
// snippets. No tab is opened/changed. This gives the agent (and its sub-agents)
// a reliable way to get REAL facts instead of hallucinating from training data.
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// DuckDuckGo wraps each result link as //duckduckgo.com/l/?uddg=<real-url> — unwrap it.
function ddgRealUrl(href) {
  if (!href) return "";
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href);
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : u.href;
  } catch { return href; }
}

function parseDdgHtml(html) {
  const out = [];
  // The result container class is e.g. "links_main links_deep result__body", so
  // split on the bare class name (not class="result__body) to find each result.
  const blocks = String(html).split(/result__body/).slice(1);
  for (const b of blocks) {
    const titleM = b.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleM) continue;
    const title = decodeEntities(titleM[1]);
    if (!title) continue;
    const hrefM = b.match(/class="result__a"[^>]*href="([^"]*)"/i);
    const snipM = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({
      title: title.slice(0, 200),
      url: ddgRealUrl(hrefM ? hrefM[1] : ""),
      snippet: snipM ? decodeEntities(snipM[1]).slice(0, 400) : ""
    });
  }
  return out;
}

// DuckDuckGo "lite" is a second, separately rate-limited no-JS endpoint (table layout:
// <a class='result-link' href=//duckduckgo.com/l/?uddg=...>title</a> + <td class='result-snippet'>).
function parseDdgLite(html) {
  const out = [];
  // The page is several tables (search form, results, footer); anything after the LAST
  // </table> is footer/ads. (The first </table> is the form: bounding there returned nothing.)
  const full = String(html);
  const tEnd = full.toLowerCase().lastIndexOf("</table>");
  const src = tEnd >= 0 ? full.slice(0, tEnd) : full;
  // attribute order varies (href before class in the live page), so match every anchor
  // and keep the ones classed result-link; the snippet is the next result-snippet cell.
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (!/class=['"]result-link['"]/i.test(attrs)) continue;
    const hrefM = attrs.match(/href=(?:['"]([^'"]*)['"]|([^\s>]+))/i); // quoted or bare (09l)
    const title = decodeEntities(m[2]);
    const url = ddgRealUrl(hrefM ? (hrefM[1] || hrefM[2] || "") : "");
    if (!title || !url) continue; // an item without a url is not citable: hand over rather than serve it
    const rest = src.slice(re.lastIndex);
    const nextA = rest.search(/<a\b[^>]*class=['"]result-link['"]/i);
    const scope = nextA >= 0 ? rest.slice(0, nextA) : rest;
    const snipM = scope.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    out.push({ title: title.slice(0, 200), url, snippet: snipM ? decodeEntities(snipM[1]).slice(0, 400) : "" });
  }
  return out;
}

// Bing's RSS view of a query: <item><title/><link/><description/></item>. Plain XML, no
// consent wall, no JS. (Microsoft's feed copyright limits it to personal, non-commercial
// rendering; it is the LAST resort here, after both DuckDuckGo endpoints.)
function parseBingRss(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml)))) {
    const item = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner); // 09l: unwrap CDATA; decodeEntities then strips any inline tags and decodes entities
    const t = item.match(/<title>([\s\S]*?)<\/title>/i);
    const l = item.match(/<link>([\s\S]*?)<\/link>/i);
    const d = item.match(/<description>([\s\S]*?)<\/description>/i);
    const title = t ? decodeEntities(t[1]) : "";
    const url = l ? decodeEntities(l[1]) : "";
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 200), url, snippet: d ? decodeEntities(d[1]).slice(0, 400) : "" });
  }
  return out;
}

// 09i: three backends in ONE call. Every v2 recording take saw DuckDuckGo rate-limit and
// Google bot-check back to back, and the agent was left to guess a URL. Order: DDG html
// (best snippets), DDG lite (separate limit), Bing RSS (last resort). A backend that
// errors or parses to nothing hands over to the next; the answer says which one served.
// 09l: each backend gets its own deadline (fetch + body), so a stalled engine hands over
// instead of hanging the run; the executor's own race covers only the user's Stop.
const WEB_SEARCH_OPTS = { timeoutMs: 10000 };
const WEB_SEARCH_BACKENDS = [
  { name: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdgHtml },
  { name: "duckduckgo-lite", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite },
  { name: "bing-rss", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`, parse: parseBingRss },
];

async function webSearch(query, limit) {
  const q = String(query || "").trim();
  if (!q) return { error: "web_search requires a non-empty query." };
  const n = Math.min(10, Math.max(1, Number(limit) || 6));
  const tried = [];
  let results = [];
  let served = "";
  for (const b of WEB_SEARCH_BACKENDS) {
    try {
      const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(WEB_SEARCH_OPTS.timeoutMs) : undefined;
      const res = await fetch(b.url(q), { credentials: "omit", redirect: "follow", signal });
      if (!res.ok) { tried.push(`${b.name}: HTTP ${res.status}`); continue; }
      const body = await (signal ? Promise.race([res.text(), new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true }))]) : res.text());
      const parsed = b.parse(body).slice(0, n);
      if (!parsed.length) { tried.push(`${b.name}: 0 results (rate-limit / layout)`); continue; }
      results = parsed; served = b.name; break;
    } catch (e) {
      const msg = e && (e.name === "TimeoutError" || e.name === "AbortError" || e.message === "timeout") ? `timeout after ${WEB_SEARCH_OPTS.timeoutMs} ms` : (e && e.message ? e.message : String(e));
      tried.push(`${b.name}: ${msg}`);
    }
  }
  if (!results.length) {
    return {
      query: q, count: 0, results: [], backends_tried: tried,
      note: "No results from any search backend (" + tried.join("; ") + "). Do NOT re-fire the same query. Try google_search once, or navigate to the most likely official site and read_page it. A 0-result search does NOT license inventing an answer."
    };
  }
  return {
    query: q, count: results.length, results, backend: served, backends_tried: tried.length ? tried : undefined,
    note: "REAL search snippets. Base your answer ONLY on these (or a page you then open with navigate/read_page) and cite the url. Do NOT add statistics, product names, company names, or quotes that are not present here."
  };
}

// web_search, LIVE IN A REAL BROWSER TAB. A headless background scrape of a search
// engine (the old webSearch above) gets captcha'd/rate-limited after a few rapid hits
// — which is why 5 sub-agents firing quick queries all came back empty. Searching in a
// real tab uses the browser's real session (cookies, fingerprint, human pacing), so it
// isn't throttled the same way, AND the search is VISIBLE (no black box). A sub-agent
// searches in ITS OWN bound tab; the top-level agent gets a throwaway background tab so
// the user's active tab is never hijacked. Bing renders results server-side (easy to
// read right after load); if it yields nothing we fall back to the background scrape so
// we never lose the capability entirely.
function parseBingResults() {
  // Runs IN the page (serialized — must be self-contained, no outer refs).
  const out = [];
  const items = document.querySelectorAll('#b_results > li.b_algo');
  for (const li of items) {
    const a = li.querySelector('h2 a[href]');
    if (!a) continue;
    const title = (a.textContent || '').trim();
    const url = a.href;
    if (!title || !/^https?:/i.test(url)) continue;
    const cap = li.querySelector('.b_caption p') || li.querySelector('.b_algoSlug') || li.querySelector('p');
    const snippet = cap ? (cap.textContent || '').trim() : '';
    out.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) });
  }
  return out;
}

async function webSearchLive(query, limit, ctx) {
  const q = String(query || "").trim();
  if (!q) return { error: "web_search requires a non-empty query." };
  const n = Math.min(10, Math.max(1, Number(limit) || 6));

  // FAST PATH FIRST (speed): a background fetch is ~1s; loading a full live search PAGE
  // is several seconds. Try the fetch first so research stays quick, and only fall to the
  // slower live-tab search when the fetch comes back empty (rate-limited / captcha'd). The
  // 3-sub-agent cap + few searches per child keep volume low, so the fast path wins most
  // of the time. The user still SEES the browsing — the visible part is the SOURCE reads
  // (navigate + read_page), which are unchanged; only the search lookup is quick again.
  const fast = await webSearch(q, n);
  if (fast && Array.isArray(fast.results) && fast.results.length) return fast;

  // RELIABLE FALLBACK (only when the fetch was throttled): search LIVE in a real browser
  // tab — a real session isn't throttled like the headless fetch. Sub-agent searches in
  // its own bound tab; the top-level agent uses a throwaway tab so the active tab is safe.
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US&mkt=en-US`;
  const boundId = ctx && ctx.subScope && ctx.subScope.tabId;
  let tabId = boundId;
  let createdTab = false;
  try {
    if (tabId == null) {
      const t = await chrome.tabs.create({ url: bingUrl, active: false });
      tabId = t.id; createdTab = true;
    } else {
      await chrome.tabs.update(tabId, { url: bingUrl });
    }
    await waitForLoad(tabId);
    const inj = await chrome.scripting.executeScript({ target: { tabId }, func: parseBingResults });
    const results = ((inj && inj[0] && Array.isArray(inj[0].result)) ? inj[0].result : []).slice(0, n);
    if (results.length) {
      return {
        query: q, count: results.length, results, engine: "bing-live",
        note: "REAL results read live from a browser search tab (the fast fetch was throttled). Base your answer ONLY on these or a page you then open with navigate/read_page, and cite the url. Do NOT add facts not present here."
      };
    }
  } catch (_e) {
    // fall through — return the fetch result (with its retry/throttle note) below.
  } finally {
    // Close ONLY a throwaway tab we created; never a sub-agent's bound tab or the user's tab.
    if (createdTab && tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_e) {} }
  }
  // Both paths empty — return the fetch result so the model sees the retry/throttled note.
  return fast;
}

// google_search — the research reflex. DuckDuckGo (web_search) rate-limits hard
// after a few fast queries and its no-JS HTML has thin snippets; Google's no-JS
// endpoint returns consent walls / CAPTCHAs, so we scrape Google the ONLY reliable
// way: open a REAL background tab (active:false — never steals focus), let it render
// Google's JS (organic results + the AI Overview summary), extract via executeScript,
// then close the tab. Read-only, non-disruptive — the research counterpart to
// web_search but with Google's far richer, less rate-limited results. host_permissions
// <all_urls> covers the executeScript into google.com.
async function googleSearch(query, limit) {
  const q = String(query || "").trim();
  if (!q) return { error: "google_search requires a non-empty query." };
  const n = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us&num=10`;
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return { error: `google_search could not open a search tab: ${e.message}. Fall back to web_search or navigate+read_page; do NOT fabricate an answer.` };
  }
  try {
    await waitForLoad(tab.id);
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (max) => {
        const clean = (href) => {
          try {
            const u = new URL(href, location.href);
            if (u.pathname === "/url") { const t = u.searchParams.get("q") || u.searchParams.get("url"); if (t) return t; }
            return u.href;
          } catch { return href; }
        };
        const head = ((document.title || "") + " " + ((document.body && document.body.innerText) || "").slice(0, 300)).toLowerCase();
        const blocked = /consent\.google|before you continue|unusual traffic|not a robot|enable javascript/i.test(head);
        const out = [];
        const seen = new Set();
        const hs = Array.from(document.querySelectorAll("#search a h3, #rso a h3, a h3"));
        for (const h3 of hs) {
          const a = h3.closest("a");
          if (!a || !a.href) continue;
          const href = clean(a.href);
          if (!/^https?:/i.test(href)) continue;
          let host = ""; try { host = new URL(href).host; } catch {}
          if (/(^|\.)google\.com$|googleusercontent|webcache|gstatic/i.test(host)) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          let snip = "";
          const cont = a.closest("div.g, div.MjjYud, div.tF2Cxc, div[data-hveid]") || a.parentElement;
          if (cont) snip = (cont.innerText || "").replace(h3.innerText || "", "").replace(/\s+/g, " ").trim().slice(0, 300);
          out.push({ title: (h3.innerText || "").trim(), url: href, snippet: snip });
          if (out.length >= max) break;
        }
        // AI Overview: Google labels the block "AI Overview". Grab the text that follows.
        let aiOverview = "";
        const bodyText = ((document.body && document.body.innerText) || "").replace(/[ \t]+/g, " ");
        const m = bodyText.match(/AI Overview([\s\S]{40,1600}?)(?:\n\s*(?:Show more|People also ask|Sponsored|Related searches|Feedback)\b|$)/i);
        // Cap ≤480 so the phase-engine ledger records it as ONE complete, citable
        // observation (values >500 are truncated → uncitable). A summary fits.
        if (m) aiOverview = m[1].replace(/\s+/g, " ").trim().slice(0, 480);
        return { blocked, results: out, aiOverview, bodyPreview: bodyText.replace(/\s+/g, " ").trim().slice(0, 2500) };
      },
      args: [n]
    });
    const data = (inj && inj.result) || {};
    if (data.blocked) {
      return { query: q, count: 0, results: [], note: "Google showed a consent / 'unusual traffic' / bot-check interstitial — I will NOT accept cookies or solve a CAPTCHA. Fall back to web_search (DuckDuckGo) or navigate to a specific source URL and read_page. Do NOT fabricate an answer." };
    }
    const results = (data.results || []).slice(0, n);
    if (!results.length && !data.aiOverview) {
      return { query: q, count: 0, results: [], bodyPreview: data.bodyPreview || undefined, note: "Google returned no parseable results (layout may have shifted or the query was filtered). Try web_search (DuckDuckGo), rephrase, or navigate to the search URL and read_page. Do NOT fabricate an answer." };
    }
    return {
      query: q,
      count: results.length,
      results,
      aiOverview: data.aiOverview || undefined,
      note: "REAL Google results" + (data.aiOverview ? " + AI Overview summary" : "") + ". Base your answer ONLY on these snippets / the AI Overview / a page you then open (fetch_page or navigate+read_page), and CITE the url. The AI Overview is a helpful synthesis but is itself AI-generated — VERIFY any key figure against a linked source before stating it as certain. Do NOT invent statistics, names, dates, or quotes not present here."
    };
  } catch (e) {
    return { error: `google_search failed: ${e.message}. Fall back to web_search or navigate+read_page; do NOT fabricate an answer.` };
  } finally {
    try { if (tab && tab.id != null) await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ---------------------------------------------------------------------------
// C.1 — Argument validation / clamping. Model output is untrusted: it can be
// malformed, oversized (DOM-flood), or out of range. Guard the dispatch so a bad
// arg returns a clean error the model can react to, instead of silently failing
// or freezing a content-script call. Returns { error } to REJECT, or null to
// proceed. Numeric args are CLAMPED in place (never reject a recoverable value).
// ---------------------------------------------------------------------------
const MAX_TEXT = 100 * 1024;   // 100 KB — fill_input / chat message / page-read text
const MAX_CODE = 500 * 1024;   // 500 KB — code editors legitimately hold larger files
const MAX_SCROLL = 50000;      // px per scroll_page call

function strLen(v) { return v == null ? 0 : (typeof v === "string" ? v.length : String(v).length); }
function clampInt(v, lo, hi) { const n = Math.round(Number(v)); return Math.min(hi, Math.max(lo, n)); }

export const __webSearchInternals = { parseDdgHtml, parseDdgLite, parseBingRss, WEB_SEARCH_BACKENDS, WEB_SEARCH_OPTS, webSearch };
export function validateArgs(name, args) {
  switch (name) {
    case "spawn_subagent": {
      if (!String(args.task || "").trim()) return { error: "spawn_subagent requires a non-empty task." };
      // 6000, not 2000 (2026-09-02 a-live-run): a ServiceNow sub-task that carries
      // sys_ids plus the exact multi-line text to enter blew the old cap on the
      // first try and cost a whole step to re-shorten.
      if (strLen(args.task) > 6000) return { error: "task is too long (max 6000 chars) — keep the instructions, drop pasted page dumps." };
      if (strLen(args.expect) > 500) return { error: "expect is too long (max 500 chars)." };
      if (args.max_steps != null && Number.isFinite(Number(args.max_steps))) args.max_steps = clampInt(args.max_steps, 1, 20);
      // Back-compat: if a model still emits a nested { scope: { url, tabId } },
      // fold it into the flat fields so the rest of the code sees only those.
      if (args.scope && typeof args.scope === "object") {
        if (args.scope.url != null && args.scope_url == null) args.scope_url = args.scope.url;
        if (args.scope.tabId != null && args.scope_tab_id == null) args.scope_tab_id = args.scope.tabId;
        if (args.scope.match != null && args.scope_tab_match == null) args.scope_tab_match = args.scope.match;
        if (args.scope.instance != null && args.scope_instance == null) args.scope_instance = args.scope.instance;
      }
      // An empty/blank scope_url means "no scope" (models often pass "" or null) — allow it
      // through as unscoped instead of erroring (which wasted a whole sub-agent turn on retry).
      if (args.scope_url != null && String(args.scope_url).trim() !== "" && !/^https?:\/\//i.test(String(args.scope_url))) return { error: "scope_url must start with http:// or https://" };
      if (args.scope_tab_id != null && !Number.isInteger(Number(args.scope_tab_id))) return { error: "scope_tab_id must be an integer tab id." };
      if (args.scope_tab_match != null && strLen(args.scope_tab_match) > 200) return { error: "scope_tab_match is too long (max 200 chars)." };
      if (args.scope_instance != null && strLen(args.scope_instance) > 200) return { error: "scope_instance is too long (max 200 chars)." };
      break;
    }
    case "create_shortcut":
      if (!String(args.name || "").trim()) return { error: "create_shortcut requires a name (e.g. 'jobwatch' for /jobwatch)." };
      if (strLen(args.name) > 60) return { error: "name is too long (max 60 chars)." };
      if (!String(args.prompt || "").trim()) return { error: "create_shortcut requires the prompt text the shortcut runs." };
      if (strLen(args.prompt) > 20000) return { error: "prompt is too long (max 20000 chars)." };
      if (args.interval_minutes != null && Number.isFinite(Number(args.interval_minutes))) args.interval_minutes = clampInt(args.interval_minutes, 1, 10080);
      break;
    case "read_file":
      if (!String(args.path || "").trim()) return { error: "read_file requires a file path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      if (args.max_chars != null && Number.isFinite(Number(args.max_chars))) args.max_chars = clampInt(args.max_chars, 100, 1000000);
      if (args.start_line != null && Number.isFinite(Number(args.start_line))) args.start_line = clampInt(args.start_line, 1, 10000000);
      if (args.end_line != null && Number.isFinite(Number(args.end_line))) args.end_line = clampInt(args.end_line, 1, 10000000);
      break;
    case "list_files":
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      break;
    case "write_file":
      if (!String(args.path || "").trim()) return { error: "write_file requires a file path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      if (args.content == null) return { error: "write_file requires content (the full text to write)." };
      if (strLen(args.content) > 2000000) return { error: "content is too large (max 2,000,000 chars)." };
      break;
    case "create_folder":
      if (!String(args.path || "").trim()) return { error: "create_folder requires a folder path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      break;
    case "move_file":
    case "copy_file":
      if (!String(args.from || "").trim()) return { error: `${name} requires 'from' — the existing path relative to the connected folder.` };
      if (!String(args.to || "").trim()) return { error: `${name} requires 'to' — the destination path relative to the connected folder ('.' = the root).` };
      if (strLen(args.from) > 1000 || strLen(args.to) > 1000) return { error: "path is too long (max 1000 chars)." };
      break;
    case "delete_file":
      if (!String(args.path || "").trim()) return { error: "delete_file requires a file or folder path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      break;
    case "read_console":
    case "read_network":
      if (args.pattern != null && strLen(args.pattern) > 300) return { error: "pattern is too long (max 300 chars)." };
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 200);
      break;
    case "edit_file":
      if (!String(args.path || "").trim()) return { error: "edit_file requires a file path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      if (args.old_text == null || args.old_text === "") return { error: "edit_file requires non-empty old_text (the exact snippet to replace)." };
      if (args.new_text == null) return { error: "edit_file requires new_text (use an empty string to delete the snippet)." };
      if (strLen(args.old_text) > 1000000 || strLen(args.new_text) > 1000000) return { error: "old_text/new_text is too large (max 1,000,000 chars)." };
      break;
    case "search_files":
      if (!String(args.pattern || "").trim()) return { error: "search_files requires a non-empty pattern." };
      if (strLen(args.pattern) > 1000) return { error: "pattern is too long (max 1000 chars)." };
      break;
    case "run_command":
      if (!String(args.command || "").trim()) return { error: "run_command requires a command." };
      if (strLen(args.command) > 8000) return { error: "command is too long (max 8000 chars)." };
      if (args.timeout_s != null && Number.isFinite(Number(args.timeout_s))) args.timeout_s = clampInt(args.timeout_s, 5, 600);
      break;
    case "http_request": {
      const u = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(u)) return { error: "http_request requires a full http:// or https:// url." };
      if (strLen(u) > 4000) return { error: "url is too long." };
      const m = String(args.method || "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(m)) return { error: `Unsupported method "${args.method}".` };
      args.method = m;
      if (args.headers != null && (typeof args.headers !== "object" || Array.isArray(args.headers))) return { error: "headers must be a flat object." };
      if (args.body != null && strLen(args.body) > 2000000) return { error: "body is too large (max 2,000,000 chars)." };
      break;
    }
    case "fetch_page":
      if (!/^https?:\/\//i.test(String(args.url || "").trim())) return { error: "fetch_page requires a full http:// or https:// url." };
      if (args.max_chars != null && Number.isFinite(Number(args.max_chars))) args.max_chars = clampInt(args.max_chars, 200, 200000);
      break;
    case "sn_recent_changes":
      if (args.hours != null && Number.isFinite(Number(args.hours))) args.hours = clampInt(args.hours, 1, 720);
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 50);
      if (args.record_sys_id != null && String(args.record_sys_id).trim() && !/^[0-9a-f]{32}$/i.test(String(args.record_sys_id).trim())) {
        return { error: "record_sys_id must be a 32-hex sys_id (or omit it)." };
      }
      break;
    case "sn_compare_record":
      if (!String(args.table || "").trim()) return { error: "sn_compare_record requires a table." };
      if (!String(args.instance_a || "").trim() || !String(args.instance_b || "").trim()) return { error: "sn_compare_record requires instance_a AND instance_b (connected instance names)." };
      if (!/^[0-9a-f]{32}$/i.test(String(args.sysId || "")) && !String(args.name || "").trim()) return { error: "sn_compare_record needs a sysId (32-hex) or an exact name." };
      break;
    case "save_note":
      if (!String(args.name || "").trim()) return { error: "save_note requires a name." };
      if (strLen(args.name) > 100) return { error: "note name is too long (max 100 chars)." };
      if (args.content == null) return { error: "save_note requires content (empty string deletes the note)." };
      if (strLen(args.content) > 20000) return { error: "note content is too large (max 20,000 chars). Split it, or use write_file for large output." };
      break;
    case "get_note":
      if (args.name != null && strLen(args.name) > 100) return { error: "note name is too long (max 100 chars)." };
      break;
    case "create_document": {
      if (!String(args.path || "").trim()) return { error: "create_document requires a file path relative to the connected folder." };
      if (strLen(args.path) > 1000) return { error: "path is too long (max 1000 chars)." };
      if (args.content == null) return { error: "create_document requires content (the document body as Markdown)." };
      if (strLen(args.content) > 2000000) return { error: "content is too large (max 2,000,000 chars)." };
      let fmt = String(args.format || "docx").toLowerCase();
      if (fmt === "markdown") fmt = "md";
      if (fmt !== "docx" && fmt !== "pdf" && fmt !== "md") return { error: `create_document format must be docx, pdf, or md (got "${args.format}").` };
      args.format = fmt;
      // Normalize the path so its extension matches the chosen format.
      if (!new RegExp(`\\.${fmt}$`, "i").test(String(args.path))) {
        args.path = String(args.path).replace(/\.(docx|pdf|md|markdown|txt)$/i, "") + "." + fmt;
      }
      break;
    }
    case "sn_query_table":
      if (!String(args.table || "").trim()) return { error: "sn_query_table requires a table name." };
      if (strLen(args.table) > 200) return { error: "table name is too long." };
      if (strLen(args.query) > 4000) return { error: "query is too long (max 4000 chars)." };
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 50);
      break;
    case "sn_query_record":
      if (!String(args.recordNumber || "").trim()) return { error: "sn_query_record requires a recordNumber (e.g. INC0012345)." };
      if (strLen(args.recordNumber) > 60) return { error: "recordNumber is too long." };
      break;
    case "sn_query_schema":
      if (!String(args.table || "").trim()) return { error: "sn_query_schema requires a table name." };
      if (strLen(args.table) > 200) return { error: "table name is too long." };
      break;
    case "sn_fetch_script_by_name":
      if (!String(args.name || "").trim()) return { error: "sn_fetch_script_by_name requires a name." };
      if (!String(args.artifactType || "").trim()) return { error: "sn_fetch_script_by_name requires an artifactType (e.g. business_rule)." };
      if (strLen(args.name) > 200) return { error: "name is too long." };
      break;
    case "sn_fetch_script_by_sysid":
      if (!/^[0-9a-f]{32}$/i.test(String(args.sysId || "").trim())) return { error: "sn_fetch_script_by_sysid requires a 32-hex-char sysId." };
      if (!String(args.table || "").trim()) return { error: "sn_fetch_script_by_sysid requires a table." };
      break;
    case "sn_wf_activity_vars": {
      const hasIds = String(args.activity_sys_id || args.activity_sys_ids || "").trim();
      const hasVer = String(args.workflow_version || "").trim();
      if (!hasIds && !hasVer) return { error: "sn_wf_activity_vars requires activity_sys_id (wf_activity sys_id, comma list ok) or workflow_version (wf_workflow_version sys_id)." };
      if (strLen(hasIds) > 2100 || strLen(hasVer) > 40 || strLen(args.element) > 500) return { error: "activity_sys_id/workflow_version/element argument is too long." };
      if (args.element && !/^[A-Za-z0-9_.,\s]+$/.test(String(args.element))) return { error: "element must be a comma-separated list of plain input names (e.g. advanced_script,values)." };
      if (args.max_chars != null && Number.isFinite(Number(args.max_chars))) args.max_chars = clampInt(args.max_chars, 200, 60000);
      break;
    }
    case "sn_search_script_body":
      if (strLen(args.keyword) < 2) return { error: "sn_search_script_body requires a keyword of at least 2 characters." };
      if (strLen(args.keyword) > 200) return { error: "keyword is too long (max 200)." };
      if (Array.isArray(args.artifactTypes) && args.artifactTypes.length > 5) return { error: "Max 5 artifactTypes per call." };
      break;
    case "sn_update_record":
      if (!String(args.table || "").trim()) return { error: "sn_update_record requires a table." };
      if (!/^[0-9a-f]{32}$/i.test(String(args.sysId || "").trim())) return { error: "sn_update_record requires a valid 32-hex-char sysId (find it with sn_query_table/sn_query_record). Do NOT pass the record number." };
      if (!args.fields || typeof args.fields !== "object" || Array.isArray(args.fields) || !Object.keys(args.fields).length) {
        return { error: "sn_update_record requires a non-empty 'fields' object, e.g. { description: 'new text' }." };
      }
      break;
    case "sn_create_record":
      if (!String(args.table || "").trim()) return { error: "sn_create_record requires a table." };
      if (!args.fields || typeof args.fields !== "object" || Array.isArray(args.fields) || !Object.keys(args.fields).length) {
        return { error: "sn_create_record requires a non-empty 'fields' object, e.g. { name: 'My workflow', table: 'incident' }." };
      }
      break;
    case "sn_wf_activity_set": {
      if (!/^[0-9a-f]{32}$/i.test(String(args.activity_sys_id || "").trim())) return { error: "sn_wf_activity_set requires activity_sys_id — a 32-hex wf_activity sys_id from sn_wf_activity_vars (NOT the activity name, NOT a sys_variable_value row)." };
      if (!args.inputs || typeof args.inputs !== "object" || Array.isArray(args.inputs) || !Object.keys(args.inputs).length) {
        return { error: "sn_wf_activity_set requires a non-empty 'inputs' object of element→value, e.g. { advanced_script: '…', values: 'description=…^EQ' }." };
      }
      if (Object.keys(args.inputs).length > 12) return { error: "Max 12 inputs per call." };
      for (const [k, v] of Object.entries(args.inputs)) {
        if (!/^[a-z0-9_]{1,60}$/i.test(k)) return { error: `inputs key "${k}" is not an input element name (use the names sn_wf_activity_vars returns: advanced_script, values, short_description, description, …).` };
        if (v != null && typeof v === "object") return { error: `inputs.${k} must be a string (the complete new value), not an object/array.` };
        if (strLen(v) > 60000) return { error: `inputs.${k} is too long (max 60000 chars).` };
      }
      break;
    }
    case "sn_wf_delete_activity":
      if (!/^[0-9a-f]{32}$/i.test(String(args.activity_sys_id || "").trim())) return { error: "sn_wf_delete_activity requires activity_sys_id — a 32-hex wf_activity sys_id from sn_wf_activity_vars." };
      if (args.rewire_to != null && String(args.rewire_to).trim() && !/^[0-9a-f]{32}$/i.test(String(args.rewire_to).trim())) return { error: "rewire_to must be a 32-hex wf_activity sys_id." };
      break;
    case "sn_wf_fix_script": {
      if (!/^[0-9a-f]{32}$/i.test(String(args.workflow_version || "").trim())) return { error: "sn_wf_fix_script requires workflow_version — the draft's 32-hex wf_workflow_version sys_id." };
      const setN = Array.isArray(args.set) ? args.set.length : 0, remN = Array.isArray(args.remove) ? args.remove.length : 0;
      if (!setN && !remN && !args.publish) return { error: "sn_wf_fix_script needs set:[{activity, inputs}] and/or remove:[{activity, rewire_to}] — or publish:true." };
      if (args.publish && typeof args.publish === "object" && args.publish.condition != null && strLen(args.publish.condition) > 4000) return { error: "publish.condition is too long (max 4000)." };
      if (args.publish && typeof args.publish === "object" && args.publish.condition_type != null && !/^(run_match|run_if_no_other)$/.test(String(args.publish.condition_type))) return { error: "publish.condition_type must be run_match or run_if_no_other." };
      if (setN > 20 || remN > 20) return { error: "Max 20 set/remove entries per Fix Script." };
      let total = 0;
      for (const s of (args.set || [])) { if (s && s.inputs && typeof s.inputs === "object") for (const v of Object.values(s.inputs)) { if (v != null && typeof v === "object") return { error: "input values must be strings (the complete new value)." }; total += strLen(v); } }
      if (total > 200000) return { error: "Fix Script input values total more than 200000 chars." };
      if (strLen(args.name) > 100) return { error: "name is too long (max 100)." };
      break;
    }
    case "sn_wf_publish":
      if (!/^[0-9a-f]{32}$/i.test(String(args.workflow_version || "").trim())) return { error: "sn_wf_publish requires workflow_version — the 32-hex wf_workflow_version sys_id." };
      if (args.condition != null && strLen(args.condition) > 4000) return { error: "condition is too long (max 4000)." };
      if (args.condition_type != null && !/^(run_match|run_if_no_other)$/.test(String(args.condition_type))) return { error: "condition_type must be run_match or run_if_no_other (omit it to keep the stored value / default run_match)." };
      break;
    case "set_session_max_loss": {
      const ml = Number(args.maxLoss);
      if (!Number.isFinite(ml) || ml <= 0) return { error: "set_session_max_loss requires a positive dollar maxLoss (e.g. 300)." };
      if (strLen(args.rationale) < 10) return { error: "set_session_max_loss requires a concrete market-insight rationale (min 10 characters) — it is audited." };
      if (strLen(args.rationale) > 300) return { error: "rationale is too long (max 300 chars)." };
      break;
    }
    case "web_search":
    case "google_search":
      if (!String(args.query || "").trim()) return { error: `${name} requires a non-empty query.` };
      if (strLen(args.query) > 500) return { error: "query is too long (max 500 chars)." };
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 10);
      break;
    case "read_page":
      if (args.max_chars != null && Number.isFinite(Number(args.max_chars))) args.max_chars = clampInt(args.max_chars, 100, 200000);
      // `url` used to be accepted silently and IGNORED — read_page read the active tab
      // whatever the model asked for (competitive-intel export 2026-09-09 15:51: four
      // URLs requested, one page read four times, three pages then invented). Reject a
      // malformed one here; the executor navigates a good one. (2026-09-09)
      if (args.url != null) {
        const u = String(args.url).trim();
        if (!u) delete args.url;
        else if (!/^https?:\/\//i.test(u)) return { error: `read_page url must start with http:// or https:// (got "${u.slice(0, 120)}"). Omit url to read the active tab.` };
        else if (u.length > 4000) return { error: `read_page url is too long (${u.length} chars, max 4000).` };
        else args.url = u;
      }
      break;
    case "query_elements":
      if (strLen(args.selector) > 2000) return { error: "selector is too long (max 2000 chars)." };
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 200);
      break;
    case "fill_input":
      if (strLen(args.value) > MAX_TEXT) return { error: `fill_input value is too large (${strLen(args.value)} chars; max ${MAX_TEXT}). Split it or set a smaller value.` };
      break;
    case "send_chat_message":
      if (strLen(args.message) > MAX_TEXT) return { error: `message is too large (max ${MAX_TEXT} chars).` };
      break;
    case "draft_chat_message":
      if (!String(args.message || "").trim()) return { error: "draft_chat_message requires non-empty message text." };
      if (strLen(args.message) > MAX_TEXT) return { error: `message is too large (max ${MAX_TEXT} chars).` };
      break;
    case "read_chat_messages":
      if (args.limit != null && Number.isFinite(Number(args.limit))) args.limit = clampInt(args.limit, 1, 30);
      break;
    case "set_reference_field":
    case "get_reference_suggestions":
      if (strLen(args.value) > 2000 || strLen(args.query) > 2000) return { error: "Reference search text is too long (max 2000 chars)." };
      break;
    case "open_form_section":
      if (!String(args.section || "").trim()) return { error: "open_form_section requires the section tab's name, e.g. 'Advanced' or 'When to run'." };
      if (strLen(args.section) > 100) return { error: "section is too long (max 100 chars)." };
      break;
    case "drag_drop":
      if (!String(args.source || "").trim()) return { error: "drag_drop requires 'source' — the query_elements handle of the item to drag." };
      if (!String(args.target || "").trim()) return { error: "drag_drop requires 'target' — the query_elements handle of the drop zone." };
      break;
    case "control_media":
      if (args.rate == null && args.action == null && args.seek == null) return { error: "control_media needs at least one of: rate, action, or seek." };
      if (args.rate != null && !Number.isFinite(Number(args.rate))) return { error: "rate must be a number (e.g. 2 for 2x)." };
      if (args.action != null && !["play", "pause", "mute", "unmute"].includes(String(args.action))) return { error: "action must be play, pause, mute, or unmute." };
      break;
    case "save_record":
      if (args.selector != null && strLen(args.selector) > 200) return { error: "selector handle is malformed (too long)." };
      break;
    case "sn_api_reference":
      if (!String(args.query || "").trim()) return { error: "sn_api_reference requires a 'query' (an API method/class/table/event or artifact type; use 'index' to list available references)." };
      if (strLen(args.query) > 300 || strLen(args.artifact) > 60) return { error: "query/artifact argument is too long." };
      break;
    case "sn_check_duplicate":
      if (!String(args.table || "").trim()) return { error: "sn_check_duplicate requires 'table' (the record's own table, e.g. sys_script)." };
      if (strLen(args.table) > 100 || strLen(args.name) > 300 || strLen(args.sys_id) > 40) return { error: "table/name/sys_id argument is too long." };
      if (!String(args.name || "").trim() && !String(args.sys_id || "").trim()) return { error: "Provide 'name' and/or 'sys_id' to check for a duplicate." };
      break;
    case "sn_query_session":
      if (!String(args.table || "").trim()) return { error: "sn_query_session requires 'table' (e.g. sys_script)." };
      if (strLen(args.table) > 100 || strLen(args.query) > 1000 || strLen(args.fields) > 500) return { error: "table/query/fields argument is too long." };
      // Shape-validate (MM 16z-audit P2): a table/fields must be a plain SN
      // identifier list — nothing that could smuggle extra query-string params.
      if (!/^[A-Za-z0-9_]{1,100}$/.test(String(args.table))) return { error: "table must be a plain ServiceNow table name (letters, digits, underscore)." };
      if (args.fields && !/^[A-Za-z0-9_.,\s]+$/.test(String(args.fields))) return { error: "fields must be a comma-separated list of plain field names." };
      // Same reasoning as table/fields: this lands in the query string, so allow
      // only the three literal modes. Anything else falls back to the default.
      if (args.display_value != null) {
        const dv = String(args.display_value).toLowerCase();
        if (!/^(true|false|all)$/.test(dv)) return { error: "display_value must be 'true' (labels, default), 'false' (raw values / reference sys_ids, fastest) or 'all'." };
        args.display_value = dv;
      }
      break;
    case "get_editor_value":
      if (!Number.isInteger(Number(args.index)) || Number(args.index) < 0) return { error: "index must be a non-negative integer from list_editors." };
      break;
    case "set_editor_value":
      if (!Number.isInteger(Number(args.index)) || Number(args.index) < 0) return { error: "index must be a non-negative integer from list_editors." };
      if (strLen(args.value) > MAX_CODE) return { error: `Editor value is too large (${strLen(args.value)} chars; max ${MAX_CODE}).` };
      break;
    case "scroll_page":
      if (args.amount != null && Number.isFinite(Number(args.amount))) args.amount = clampInt(args.amount, 0, MAX_SCROLL);
      break;
    case "send_sms":
      // sendSms() does the authoritative number+carrier validation with detailed
      // messages; here we only reject absurd inputs before opening a Gmail tab.
      if (strLen(args.number) > 40) return { error: "number is malformed (too long)." };
      if (strLen(args.carrier) > 40) return { error: "carrier is malformed (too long)." };
      if (strLen(args.message) > 1600) return { error: "SMS message is too long (max 1600 chars / ~10 segments)." };
      break;
    case "send_email":
      if (strLen(args.to) > 254) return { error: "email address is too long (max 254 chars)." };
      if (strLen(args.subject) > 1000) return { error: "subject is too long (max 1000 chars)." };
      if (strLen(args.message) > 256 * 1024) return { error: "email body is too large (max 256 KB)." };
      break;
    case "desktop_move_mouse":
      if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) {
        return { error: "desktop_move_mouse requires numeric x and y (screen pixels from desktop_screenshot)." };
      }
      args.x = clampInt(args.x, 0, 100000);
      args.y = clampInt(args.y, 0, 100000);
      break;
    case "desktop_click":
      // x/y are optional (click-at-current-pointer); validate them only if given.
      if (args.x != null && !Number.isFinite(Number(args.x))) return { error: "desktop_click x must be numeric." };
      if (args.y != null && !Number.isFinite(Number(args.y))) return { error: "desktop_click y must be numeric." };
      if (args.x != null) args.x = clampInt(args.x, 0, 100000);
      if (args.y != null) args.y = clampInt(args.y, 0, 100000);
      if ((args.x == null) !== (args.y == null)) return { error: "desktop_click needs BOTH x and y, or neither (to click at the current pointer)." };
      if (args.clicks != null && Number.isFinite(Number(args.clicks))) args.clicks = clampInt(args.clicks, 1, 3);
      break;
    case "desktop_click_hold":
      if (args.x != null && !Number.isFinite(Number(args.x))) return { error: "desktop_click_hold x must be numeric." };
      if (args.y != null && !Number.isFinite(Number(args.y))) return { error: "desktop_click_hold y must be numeric." };
      if (args.x != null) args.x = clampInt(args.x, 0, 100000);
      if (args.y != null) args.y = clampInt(args.y, 0, 100000);
      if ((args.x == null) !== (args.y == null)) return { error: "desktop_click_hold needs BOTH x and y, or neither (to press at the current pointer)." };
      if (args.x2 != null && !Number.isFinite(Number(args.x2))) return { error: "desktop_click_hold x2 must be numeric." };
      if (args.y2 != null && !Number.isFinite(Number(args.y2))) return { error: "desktop_click_hold y2 must be numeric." };
      if (args.x2 != null) args.x2 = clampInt(args.x2, 0, 100000);
      if (args.y2 != null) args.y2 = clampInt(args.y2, 0, 100000);
      if ((args.x2 == null) !== (args.y2 == null)) return { error: "desktop_click_hold needs BOTH x2 and y2, or neither." };
      if (args.hold_ms != null && Number.isFinite(Number(args.hold_ms))) args.hold_ms = clampInt(args.hold_ms, 50, 3000);
      break;
    case "desktop_type":
      if (!String(args.text || "").length) return { error: "desktop_type requires non-empty text." };
      if (strLen(args.text) > MAX_TEXT) return { error: `desktop_type text is too large (max ${MAX_TEXT} chars).` };
      break;
    case "desktop_press_keys":
      // Local models often double-encode the chord — keys arrives as the STRING
      // '["ctrl","c"]' instead of an array. Unwrap it here so the bridge gets
      // real key names instead of garbage tokens like '["ctrl",'.
      if (typeof args.keys === "string" && args.keys.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(args.keys);
          if (Array.isArray(parsed)) args.keys = parsed.map(k => String(k).trim()).filter(Boolean);
        } catch { /* not JSON — treat it as a plain key-name string below */ }
      }
      if (typeof args.keys !== "string" && !Array.isArray(args.keys)) {
        return { error: "desktop_press_keys requires 'keys' as a string ('enter', 'ctrl+c') or an array (['ctrl','c'])." };
      }
      if (Array.isArray(args.keys)) {
        if (!args.keys.length) return { error: "desktop_press_keys 'keys' array is empty." };
        if (args.keys.length > 5) return { error: "desktop_press_keys: at most 5 keys in a chord." };
      } else if (!args.keys.trim()) {
        return { error: "desktop_press_keys 'keys' string is empty." };
      }
      break;
    case "desktop_scroll":
      if (!Number.isFinite(Number(args.amount))) return { error: "desktop_scroll requires a numeric amount (negative = down)." };
      args.amount = clampInt(args.amount, -3000, 3000);
      if (args.x != null) args.x = clampInt(args.x, 0, 100000);
      if (args.y != null) args.y = clampInt(args.y, 0, 100000);
      break;
  }
  return null;
}

// US carrier email-to-SMS gateways (free). Wrong carrier = silent non-delivery.
const SMS_GATEWAYS = {
  verizon: "vtext.com",
  att: "txt.att.net",
  tmobile: "tmomail.net",
  uscellular: "email.uscc.net",
  boost: "sms.myboostmobile.com",
  cricket: "sms.cricketwireless.net",
  metropcs: "mymetropcs.com",
  googlefi: "msg.fi.google.com",
  mint: "tmomail.net",      // Mint rides T-Mobile
  xfinity: "vtext.com",     // Xfinity Mobile rides Verizon
};
const CARRIER_ALIASES = {
  att: "att", "at&t": "att", attwireless: "att",
  tmobile: "tmobile", tmo: "tmobile", "t-mobile": "tmobile",
  verizon: "verizon", vzw: "verizon", verizonwireless: "verizon",
  googlefi: "googlefi", fi: "googlefi",
  uscellular: "uscellular", uscc: "uscellular",
  boost: "boost", cricket: "cricket",
  metropcs: "metropcs", metro: "metropcs", metrobytmobile: "metropcs",
  mint: "mint", mintmobile: "mint", xfinity: "xfinity",
};

// Send an SMS via a carrier email-to-SMS gateway by driving a Gmail compose tab.
async function sendSms({ number, carrier, message }) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!/^1?\d{10}$/.test(digits)) {
    return { error: `Invalid phone number '${number}'. Provide exactly a 10-digit US mobile number (optionally a leading 1) — no extensions or extra digits.` };
  }
  const ten = digits.slice(-10);
  const key = String(carrier || "").toLowerCase().replace(/[^a-z0-9&]/g, "");
  const norm = CARRIER_ALIASES[key] || key;
  const domain = SMS_GATEWAYS[norm];
  if (!domain) {
    return { error: `Unknown carrier '${carrier}'. Email-to-SMS needs the recipient's carrier. Supported: ${Object.keys(SMS_GATEWAYS).join(", ")}. Ask the user which carrier the number is on.` };
  }
  if (!message || !String(message).trim()) {
    return { error: "message is required (the SMS body)." };
  }
  const to = `${ten}@${domain}`;
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&body=${encodeURIComponent(String(message))}`;
  const tab = await chrome.tabs.create({ url });
  await waitForLoad(tab.id);
  const res = await sendToContent(tab.id, { type: "TOOL", name: "_gmail_send", args: { to, body: String(message) } });
  if (res && res.ok) {
    return {
      ok: true,
      sent_to: to,
      carrier: norm,
      confirmed: res.confirmed === true,
      note: `SMS emailed to ${to} via the ${norm} gateway${res.confirmed ? "" : " (could not confirm the 'Message sent' toast)"}. Email-to-SMS can be delayed or dropped by carriers — ask the user to confirm receipt.`,
    };
  }
  return res || { error: "send_sms failed (no response from the Gmail compose tab)." };
}

// Send a normal email via a Gmail compose tab (reuses the same Send/verify flow
// as send_sms). More reliable than carrier email-to-SMS gateways.
async function sendEmail({ to, subject, message }) {
  const addr = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return { error: `Invalid email address '${to}'. Provide a valid address like name@example.com.` };
  }
  if (!message || !String(message).trim()) {
    return { error: "message is required (the email body)." };
  }
  const su = String(subject || "").trim();
  let url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(addr)}&body=${encodeURIComponent(String(message))}`;
  if (su) url += `&su=${encodeURIComponent(su)}`;
  const tab = await chrome.tabs.create({ url });
  await waitForLoad(tab.id);
  const res = await sendToContent(tab.id, { type: "TOOL", name: "_gmail_send", args: { to: addr, body: String(message) } });
  if (res && res.ok) {
    return { ok: true, sent_to: addr, subject: su || undefined, confirmed: res.confirmed === true, note: `Email sent to ${addr}.` };
  }
  return res || { error: "send_email failed (no response from the Gmail compose tab)." };
}

// chrome.tabs.sendMessage resolves ONLY when the content script calls
// sendResponse. On a heavy single-page app (e.g. LinkedIn, Teams) an action can
// navigate / re-render the page and DESTROY the content-script context mid-handler,
// so the response is never sent and the promise NEVER settles — freezing the whole
// agent with no recovery. Race the call against a timeout so a non-responsive page
// becomes a clear, recoverable error instead of an infinite hang. (The ollama.js
// idle-timeout guards the inference stream; THIS guards the tool round-trip — a
// separate hang path the inference fix cannot see.)
const TOOL_RESPONSE_TIMEOUT_MS = 30000;
// Reads (read_page / query_elements) fan out to EVERY frame and Promise.all waits
// for the slowest one. The top frame carries the content that matters; embedded
// frames are a bonus. A shorter budget means a single hung ServiceNow iframe can't
// make an otherwise-instant read feel frozen — it drops out fast and the good
// frames' text is returned. Actions keep the full 30s (they may legitimately work).
const FRAME_READ_TIMEOUT_MS = 8000;
function tabsSendMessageWithTimeout(tabId, payload, ms = TOOL_RESPONSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error(
        `The page did not respond to "${(payload && payload.name) || "the action"}" within ${ms / 1000}s — it likely navigated, reloaded, or hung (common on heavy single-page sites after an action). The tool did NOT complete; do NOT assume it succeeded. Reload the tab (F5) and retry, or re-read the page state with read_page first.`
      );
      err.__lcTimeout = true;
      reject(err);
    }, ms);
    Promise.resolve(chrome.tabs.sendMessage(tabId, payload)).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

async function sendToContent(tabId, payload, opts = {}) {
  // Still-arriving page? Wait (bounded) before probing — and remember the status
  // so a probe timeout below is described as what it is (slow server vs hung page).
  const stillLoading = await settleIfLoading(tabId, opts.loadGraceMs);
  // First try: the content script is already present (tab loaded after install).
  try {
    return await tabsSendMessageWithTimeout(tabId, payload);
  } catch (e) {
    // A TIMEOUT means the script is present but unresponsive (page hung/navigated) —
    // re-injecting won't help, so surface it now instead of looping. Any other error
    // means "no receiver" → inject the content script on-demand and retry below.
    if (e && e.__lcTimeout) throw e;
  }

  // Inject content.js ONLY if it isn't already loaded. Re-injecting a file that has
  // already run in this frame re-executes its top-level `const`s and throws
  // "Identifier '...' has already been declared", which kills the content script.
  // (Manifest auto-injects at document_idle; a navigation race could otherwise make
  // us inject a second copy.) The flag lives in the same isolated world as content.js.
  // Both executeScript calls are time-boxed for the same reason frame discovery is
  // (see FRAME_DISCOVERY_TIMEOUT_MS): an unresponsive page leaves them pending
  // forever, and a pending promise in the MV3 worker ends as an EVICTION, not an
  // error. A restricted page REJECTS immediately (→ the "can't access this page"
  // message); a hung one never answers (→ the timeout message, which tells the user
  // to reload). __lcTimeout marks it so callers keep the precise wording.
  const hungPage = async () => {
    // Re-check the LIVE status at the moment of the timeout: a page that was
    // loading when we started, or is loading now, is a slow server — say so.
    const loadingNow = stillLoading || (await tabStatus(tabId)) === "loading";
    const err = new Error(
      loadingNow
        ? STILL_LOADING_MSG
        : `The page did not respond within ${FRAME_DISCOVERY_TIMEOUT_MS / 1000}s — it is hung or mid-navigation. The tool did NOT complete; do NOT assume it succeeded. Reload the tab (F5) and retry.`
    );
    err.__lcTimeout = true;
    return err;
  };
  const RESTRICTED = "Could not access this page. It may be a restricted page (chrome://, the Chrome Web Store, a PDF, or the New Tab page). Open a normal website and try again.";
  const TIMED_OUT = Symbol("timeout");

  let present = false;
  try {
    const res = await withDeadline(
      chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__localClaudeContentReady }),
      FRAME_DISCOVERY_TIMEOUT_MS, TIMED_OUT
    );
    if (res === TIMED_OUT) throw await hungPage();
    const [r] = res;
    present = !!(r && r.result);
  } catch (e) {
    if (e && e.__lcTimeout) throw e;
    throw new Error(RESTRICTED);
  }
  if (!present) {
    try {
      const res = await withDeadline(
        chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
        FRAME_DISCOVERY_TIMEOUT_MS, TIMED_OUT
      );
      if (res === TIMED_OUT) throw await hungPage();
    } catch (e) {
      if (e && e.__lcTimeout) throw e;
      throw new Error(RESTRICTED);
    }
  }

  try {
    return await tabsSendMessageWithTimeout(tabId, payload);
  } catch (e) {
    if (e && e.__lcTimeout) throw e; // present but hung — keep the precise timeout message
    throw new Error("The page didn't respond after injection. Try reloading the tab (F5), then retry.");
  }
}

// content.js now runs in EVERY frame (all_frames), so embedded/cross-origin
// content (SCORM e-learning SCOs, nested course players, sandboxed widgets) is
// reachable — but chrome.tabs.sendMessage returns only ONE frame's response. To
// find/act on elements ANYWHERE in the tab we must message each frame and merge.
// Frame ids come from a trivial all-frames executeScript (no extra permission);
// only frames where content.js is live (window.__localClaudeContentReady) reply.
// Frame DISCOVERY budget. The per-frame message timeout below protects the step
// AFTER this one; discovery itself was unguarded until 2026-07-27. chrome.scripting
// .executeScript with allFrames:true waits for EVERY frame to answer, so one busy
// or never-settling frame (a ServiceNow Polaris form nests many iframes, plus
// about:blank ones that match_about_blank pulls in) left the promise pending
// forever — and because the whole agent runs in the MV3 service worker, an
// indefinite wait with no extension-API activity gets the worker EVICTED at the
// 30s idle mark, killing the pending promise AND every setTimeout meant to rescue
// it. The run then ends with no result, no error, and no resume offer (live
// a-live-run: query_elements on a large ServiceNow incident form). Time-boxing
// here keeps discovery bounded so the timers actually get to fire.
const FRAME_DISCOVERY_TIMEOUT_MS = 5000;
// Resolve `p` within `ms`, else resolve `fallback`. ONLY a timeout produces the
// fallback — a rejection still rejects, because the two mean different things for
// executeScript: a restricted page (chrome://, Web Store, PDF) rejects instantly
// and deserves that specific message, while a HUNG page never answers at all.
// Callers that want a rejection to degrade say so explicitly with .catch(). The
// losing promise is abandoned (it cannot be cancelled) but is harmless.
export function withDeadline(p, ms, fallback) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    Promise.resolve(p).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

export async function frameIdsWithContent(tabId) {
  // Probe every frame: result=true → content.js already live; result=false →
  // the frame is injectable but content.js hasn't loaded (a late/dynamically
  // added SCORM slide frame); absent/errored → truly unreachable (sandboxed).
  // Here BOTH a throw and a timeout degrade the same way — to the top frame —
  // because a read that covers one frame still beats no read at all.
  const probe = await withDeadline(
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => !!window.__localClaudeContentReady
    }).catch(() => null),
    FRAME_DISCOVERY_TIMEOUT_MS,
    null
  );
  if (!probe) return [0];
  const ready = [], toInject = [];
  for (const r of probe) {
    if (!r) continue;
    if (r.result) ready.push(r.frameId);
    else if (!r.error && r.frameId != null) toInject.push(r.frameId);
  }
  // Force-inject into injectable-but-not-yet-ready frames so a deep course/slide
  // iframe that appeared after document_idle is still reached. content.js guards
  // against double-registration, so injecting where it's already present is safe.
  // Also time-boxed: injecting into a frame that is still loading can hang exactly
  // like the probe. On timeout we simply don't claim those frames as ready — the
  // frames that DID answer still serve the read.
  if (toInject.length) {
    const injected = await withDeadline(
      chrome.scripting.executeScript({ target: { tabId, frameIds: toInject }, files: ["content.js"] }).catch(() => null),
      FRAME_DISCOVERY_TIMEOUT_MS,
      null
    );
    if (injected) ready.push(...toInject);
  }
  return ready.length ? ready : [0];
}

// Send a payload to every frame's content script; return [{frameId, v}] for the
// frames that answered (cross-origin/unready frames are skipped, never throw).
// EACH frame message is time-boxed: a frame whose content script received the
// message but never calls sendResponse (its context was destroyed mid-handler by
// a navigation/re-render, or readPage hung on a heavy DOM — ServiceNow's Next
// Experience nests many iframes) would otherwise leave chrome.tabs.sendMessage
// pending FOREVER, hanging Promise.all and freezing the whole agent with no
// recovery (live read_page freeze, 2026-07-22). The single-frame sendToContent
// path already has this guard via tabsSendMessageWithTimeout; sendToAllFrames did
// not. A timed-out frame resolves to null so the frames that DID answer still win.
async function sendToAllFrames(tabId, payload, ms = TOOL_RESPONSE_TIMEOUT_MS) {
  await settleIfLoading(tabId); // still-arriving page: give it the grace period once, here
  const ids = await frameIdsWithContent(tabId);
  const settled = await Promise.all(ids.map((frameId) =>
    new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
      Promise.resolve(chrome.tabs.sendMessage(tabId, payload, { frameId })).then(
        (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v ? { frameId, v } : null); },
        () => { if (done) return; done = true; clearTimeout(timer); resolve(null); }
      );
    })
  ));
  return settled.filter(Boolean);
}

// query_elements across ALL frames: merge every frame's matches (each handle is
// frame-unique) so the model sees checkboxes/buttons/arrows inside course iframes,
// not just the top document. Falls back to the injecting single-frame path if no
// frame answered (e.g. content script not yet loaded).
async function queryElementsAllFrames(tabId, args) {
  const results = await sendToAllFrames(tabId, { type: "TOOL", name: "query_elements", args }, FRAME_READ_TIMEOUT_MS);
  if (!results.length) return await sendToContent(tabId, { type: "TOOL", name: "query_elements", args }, { loadGraceMs: 0 });
  const merged = [];
  let anyErr = null;
  for (const { frameId, v } of results) {
    if (v && Array.isArray(v.elements)) {
      // Tag each element with its source frame so the model can see that a control
      // lives in an embedded course frame (and for debugging frame coverage).
      for (const el of v.elements) { if (frameId) el.frame = frameId; merged.push(el); }
    } else if (v && v.error) anyErr = v.error;
  }
  const limit = Number.isFinite(args.limit) ? args.limit : 20;
  if (!merged.length && anyErr) return { error: anyErr };
  // Carry the tab URL so recordEvidence scopes this read to its RECORD (the sys_id
  // is in the form URL). Without it, query_elements reads of DIFFERENT records on
  // the same table — e.g. two catalog variables' item_option_new.type — collapse
  // to one scope and falsely "supersede" each other (live catalog a-live-run
  // stale-evidence loop). read_page already carries url; this brings parity.
  let url;
  try { url = (await chrome.tabs.get(tabId)).url; } catch (e) { /* tab gone */ }
  return { count: Math.min(merged.length, limit), elements: merged.slice(0, limit), frames_searched: results.length, url };
}

// Same page? Compare origin+path+query, ignoring the #fragment, a trailing slash and
// case in the host. Used by read_page to prove the tab is showing the page that was
// asked for before any of its text is handed to the model. (2026-09-09)
// strictHash (2026-09-09c): on a hash-routed SPA the #fragment IS the route, so a read
// that asked for one must also prove the fragment. Default stays fragment-blind.
export function sameHttpUrl(a, b, strictHash = false) {
  try {
    const A = new URL(String(a || "")), B = new URL(String(b || ""));
    if (A.protocol !== B.protocol) return false;
    if (A.host.toLowerCase() !== B.host.toLowerCase()) return false;
    const path = (u) => (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname);
    if (path(A) !== path(B) || A.search !== B.search) return false;
    return strictHash ? A.hash === B.hash : true;
  } catch { return false; }
}
export function urlHash(u) { try { return new URL(String(u || "")).hash || ""; } catch { return ""; } }
export function sameHttpHost(a, b) {
  try { return new URL(String(a || "")).host.toLowerCase() === new URL(String(b || "")).host.toLowerCase(); } catch { return false; }
}
// A landing url that is a sign-in / consent / SSO page (MM pass 2, B-1). ServiceNow's
// login.do is on the SAME host as the record that was asked for, so a same-host
// redirect test alone would read the login form as the record.
export function looksLikeLoginUrl(u) {
  try {
    const U = new URL(String(u || ""));
    const path = U.pathname.toLowerCase();
    const pq = (U.pathname + U.search).toLowerCase();
    // Segment tests run on the PATH only: "?next=/login" in a query is not a login page
    // (MM pass 3, N-8). The nav_to uri is terminated so uri=login_history_list.do is not.
    return /(?:^|\/)(?:login|logout|welcome|sso_login|side_door)\.do$/.test(path)
      || /\/(?:oauth2?|saml2?|auth|sso|signin|sign-in|login|logout|consent|captcha|challenge)(?:\/|$)/.test(path)
      || /\/accounts\/(?:signin|servicelogin)/.test(path)
      || /sysparm_login=|\/nav_to\.do\?uri=(?:%2f)?login(?:\.do|%2e|[?&#]|$)/.test(pq);
  } catch { return false; }
}
// The site root ("/" with no query) — where a catch-all 302 sends an unknown path.
export function isSiteRoot(u) {
  try { const U = new URL(String(u || "")); return (U.pathname === "/" || U.pathname === "") && !U.search; } catch { return false; }
}

// read_page across ALL frames (deduplicated): the top frame's read already pierces
// same-origin descendants, but cross-origin course/SCORM frames are missed — so
// append each frame's text that isn't already represented. Lets the model READ the
// deep slide DOM (controls, state, gating) instead of guessing from screenshots.
async function readPageAllFrames(tabId, args) {
  const results = await sendToAllFrames(tabId, { type: "TOOL", name: "read_page", args }, FRAME_READ_TIMEOUT_MS);
  if (!results.length) return await sendToContent(tabId, { type: "TOOL", name: "read_page", args }, { loadGraceMs: 0 });
  const top = (results.find((r) => r.frameId === 0) || results[0]).v || {};
  let acc = String(top.text || "");
  for (const { frameId, v } of results) {
    if (frameId === 0 || !v || !v.text) continue;
    const t = String(v.text).trim();
    if (!t) continue;
    const probe = t.slice(0, 120);
    if (probe && acc.includes(probe)) continue; // already covered (same-origin, pierced by the top read)
    acc += `\n\n--- [embedded frame ${frameId}] ---\n${t}`;
  }
  const maxChars = Number.isFinite(args.max_chars) ? args.max_chars : 6000;
  return {
    title: top.title, url: top.url,
    text: acc.slice(0, maxChars),
    truncated: acc.length > maxChars,
    frames_read: results.length
  };
}

// A handle/element action (click, fill, drag, media, section…) is meaningful in
// exactly ONE frame — the one owning the frame-unique handle (or, for search-based
// tools, the frame containing the match). Broadcast and return the frame that
// actually ACTED; others report "no element" and are ignored. Falls back to the
// injecting single-frame path if no frame answered.
function pickActing(results) {
  const acted = results.find((r) => r.v && (r.v.ok === true || r.v.needsSnLogin || r.v.blocked));
  if (acted) return acted.v;
  const noErr = results.find((r) => r.v && !r.v.error);
  if (noErr) return noErr.v;
  return (results[0] && results[0].v) || { error: "No frame could perform the action." };
}
async function sendToActingFrame(tabId, payload) {
  const results = await sendToAllFrames(tabId, payload);
  if (!results.length) return await sendToContent(tabId, payload, { loadGraceMs: 0 });
  return pickActing(results);
}

// MF-1: resolve the tab a tool should act on. A sub-agent is bound to a specific
// tab via ctx.subScope.tabId; everything else uses the OS-active tab. Without this
// a child "bound to tab 42" would silently drive whatever tab the user has focused.
async function resolveTab(ctx) {
  const boundId = ctx && ctx.subScope && ctx.subScope.tabId;
  if (boundId != null) {
    try { return await chrome.tabs.get(boundId); }
    catch { throw new Error(`The sub-agent's bound tab (${boundId}) is gone — it was closed, or never opened.`); }
  }
  return getActiveTab();
}

// Load-wait budgets (ms). Mutable on purpose so tests can shrink them.
//   default    — any site.
//   servicenow — a *.service-now.com instance. A PDI waking from hibernation, a
//                busy dev instance, or six logins fanned out at once routinely
//                take longer than 15 s to send the FIRST byte. In the 2026-09-07
//                six-instance login run navpage.do was still title-less (no
//                document at all) when navigate's 15 s ran out, and every step
//                after that reasoned about a page that did not exist yet.
//   readGrace  — how long a read/action waits for a tab that is still loading
//                before probing it (see settleIfLoading).
export const LOAD_BUDGETS = { default: 15000, servicenow: 45000, readGrace: 8000 };
export function loadBudgetMsFor(url) {
  try { return isServiceNowInstanceHost(new URL(String(url || "")).host) ? LOAD_BUDGETS.servicenow : LOAD_BUDGETS.default; }
  catch { return LOAD_BUDGETS.default; }
}

// Live tab status straight from the browser process ("loading" | "complete" |
// "unloaded"), or "" when the tab can't be read. chrome.tabs.get cannot be stalled
// by a busy renderer, so it is always safe to ask — unlike anything that touches
// the page.
export async function tabStatus(tabId) {
  try { const t = await chrome.tabs.get(tabId); return String((t && t.status) || ""); } catch { return ""; }
}

// Resolve TRUE when the tab reports "complete" within timeoutMs, FALSE when the
// budget runs out with the tab still loading (callers used to get no answer at
// all and assumed success — the 2026-09-07 lie). Two signals are combined: the
// onUpdated listener (instant) and a 500 ms chrome.tabs.get poll. The poll also
// covers a tab that was already complete before the listener attached (a fresh
// about:blank tab used to eat the whole budget), and every chrome.tabs.get is
// extension-API activity that resets the MV3 worker's idle clock — so a long
// ServiceNow load cannot get the worker evicted mid-wait. The poll only trusts
// "complete" after it has seen "loading" once or 1.5 s have passed, so the old
// page's "complete" can't be mistaken for the new navigation's.
export function waitForLoad(tabId, timeoutMs = LOAD_BUDGETS.default) {
  return new Promise((resolve) => {
    let settled = false, sawLoading = false;
    const t0 = Date.now();
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
      resolve(loaded);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish(true);
    }
    const poll = setInterval(async () => {
      if (settled) return;
      const s = await tabStatus(tabId);
      if (s === "loading") sawLoading = true;
      else if (s === "complete" && (sawLoading || Date.now() - t0 >= 1500)) finish(true);
    }, 500);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// A read/action against a tab whose document has not finished ARRIVING cannot
// succeed: content.js is injected at document_idle and executeScript waits for
// that too, so on a page the server is still sending every probe below times out.
// Give the load a short grace period first (bounded, worker-safe). Returns TRUE
// when the tab is still loading afterwards; graceMs 0 = just report the status.
async function settleIfLoading(tabId, graceMs = LOAD_BUDGETS.readGrace) {
  if ((await tabStatus(tabId)) !== "loading") return false;
  if (!(graceMs > 0)) return true;
  return !(await waitForLoad(tabId, graceMs));
}
// The message a probe timeout gets when the tab's live status is "loading". The
// old wording ("hung — reload the tab (F5)") was wrong on both counts for a slow
// server: nothing is hung, and a reload restarts the slow request from zero.
const STILL_LOADING_MSG = "The page is STILL LOADING — the server has not finished sending it (a slow server, not a hung page), so nothing on it is readable yet. The tool did NOT complete. Do NOT reload (that restarts the slow request from zero) and do not assume anything about the page. Wait, then retry the SAME tool; if it is still loading after that, report the page as not responding (never finished loading).";

// --- ServiceNow classic-navigation self-heal (2026-08-02, live INC0012345 run
// on customer-dev: a bare sys_assignment_rule_list.do rendered ServiceNow's "Page
// not found" page, and the agent burned 6 tool calls — re-read of an unchanged
// page, a wrapper guess, then sys_db_object label-browsing — before the list
// ever opened). navigate now detects the 404 itself, retries ONCE via the
// canonical polaris wrapper (wrapSnClassicTarget), and reports the outcome in
// its own result so the agent never needs a read_page to discover it. ---

// True when the tab (any frame — a wrapped target 404s inside the classic
// iframe) shows ServiceNow's standard not-found page. The phrase is SN's exact
// wording; restricted pages / script failures fail SAFE (false = no rewrite).
// 2026-09-01 (a-live-run hang on a excluded-host sys_email form): the probe read
// document.body.innerText, which forces a synchronous style+layout pass of the
// WHOLE document in EVERY frame — on a form rendering a large raw-HTML email
// body that pinned the renderer, and the un-deadlined allFrames injection then
// parked navigate (and the whole run) until the user hit Stop. Same disease
// sn_query_session had. Now: textContent (no layout) over a wider slice, and
// the injection is deadline-raced — a timeout means "couldn't tell", which
// fails SAFE as false (the self-heal simply doesn't run).
async function snPageNotFound(tabId) {
  try {
    const results = await withDeadline(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const t = ((document.body && document.body.textContent) || "").slice(0, 20000);
          return /The page you are looking for could not be found/i.test(t);
        }
      }),
      4000, null
    );
    return (results || []).some((r) => r && r.result === true);
  } catch { return false; }
}

// After navigating to /now/nav/ui/classic/params/target/<x>.do, the list/form
// loads INSIDE the gsft_main iframe AFTER the polaris shell reports complete —
// a read_page fired right after waitForLoad sees only nav chrome (observed in
// the same 2026-08-02 run). Wait (bounded) for a frame whose location IS the
// classic target and whose document has started rendering.
async function waitForSnClassicFrame(tabId, wrappedUrl, timeoutMs = 6000) {
  let base = "";
  try {
    const m = new URL(wrappedUrl).pathname.match(/\/params\/target\/([^/?]+)/);
    base = m ? decodeURIComponent(m[1]).split("?")[0] : "";
  } catch {}
  if (!base) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Deadline-race each injection (2026-09-01): the loop's own deadline check
      // sits AFTER the await, so one hung allFrames injection used to defeat the
      // whole timeout and park navigate forever. Cap each probe at the remaining
      // budget; a timeout yields null → treated as "not there yet".
      const results = await withDeadline(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (b) => location.pathname.endsWith("/" + b) && document.readyState !== "loading",
          args: [base]
        }),
        Math.max(500, Math.min(2000, deadline - Date.now())), null
      );
      if ((results || []).some((r) => r && r.result === true)) return true;
    } catch {}
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Execute a tool by name. ctx = { settings, signal }.
export async function executeTool(name, args = {}, ctx = {}) {
  // MF-4 (defense-in-depth): spawn_subagent is orchestrated by the agent loop, not
  // here. It should never reach executeTool — but if a child somehow routes one
  // (e.g. via the text-tool-call fallback), reject it so recursion stays capped.
  if (name === "spawn_subagent") {
    return { error: "spawn_subagent is not available here (a sub-agent cannot spawn further sub-agents)." };
  }

  // C.1: reject/clamp malformed or oversized args before doing any work.
  const invalid = validateArgs(name, args);
  if (invalid) return invalid;

  // Live work must not invoke generic submit/editor/instance-write helpers (MM pass 4 M1) — enforced here,
  // where these tools actually execute (the content-dispatcher denylist is depth, not enforcement).
  if (/^(send_chat_message|draft_chat_message|delete_chat_message|drag_drop|set_editor_value|save_record|sn_login|sn_set_field|set_reference_field|open_form_section|_gmail_send)$/.test(name)) {
    let _lt; try { _lt = await resolveTab(ctx); } catch { return { error: "Cannot verify the target tab; refusing this action." }; }
    if (ctx.liveTradingPackInjected === true || /live-trading/i.test((_lt && _lt.url) || "")) {
      return { error: "This helper is disabled for REAL-MONEY trading. Use fill_input / click_element on the guarded order form." };
    }
  }

  // M1 real-money target-tab guard (defense-in-depth, TOGGLE-INDEPENDENT): block any
  // page-mutating action whenever the RESOLVED target tab is the M1 brokerage origin.
  // This catches mid-run navigation onto M1 and a sub-agent bound to an M1 tab, even if
  // the run did not start in M1 mode. navigate has its own read-only-route check in its
  // case below; all other action tools are simply refused on dashboard.m1.com.
  const M1_SAFE_AT_EXECUTOR = new Set(["read_page", "query_elements", "scroll_page", "capture_screenshot", "get_tab_info", "list_tabs", "web_search", "google_search", "sn_api_reference", "navigate"]);
  // EXEMPT only the ServiceNow INSTANCE-API tools (they hit a SN REST API via stored
  // creds, never the M1 DOM), so a tab-free SN child does not false-block when the user's
  // OS-active tab happens to be M1 (master-mind 29d catch). NAME-SCOPED on purpose:
  // `!name.startsWith("sn_") && !ctx.snInstance` was too broad — it (a) exempted
  // sn_login, which IS DOM-mutating (fills + clicks login fields via executeScript), and
  // (b) `ctx.snInstance` is passed to EVERY tool call, so a scope_instance child carrying
  // page-mutating CHILD_TOOLS could mutate the real-money M1 page with this guard off and
  // the loop guard silent (a tab-free child re-derives m1ReadOnly=false). The allowlist
  // closes both holes. (master-mind 29e: NO-GO → this patch.)
  const SN_INSTANCE_API_TOOLS = new Set([
    "sn_query_table", "sn_query_record", "sn_query_schema",
    "sn_fetch_script_by_name", "sn_fetch_script_by_sysid", "sn_wf_activity_vars",
    "sn_search_script_body", "sn_update_record", "sn_create_record"
  ]);
  const actsOnActiveTab = !SN_INSTANCE_API_TOOLS.has(name);
  if (actsOnActiveTab && !M1_SAFE_AT_EXECUTOR.has(name)) {
    try {
      const t = await resolveTab(ctx);
      if (t && isM1DashboardUrl(t.url)) {
        return { error: `M1 read-only: "${name}" is disabled on the real-money M1 brokerage (dashboard.m1.com). Only read tools and allowlisted navigation are permitted.` };
      }
    } catch { /* tab unresolved — fall through; the background.js loop guard still applies */ }
  }

  if (name === "capture_screenshot") {
    // Resolve the bound tab so a sub-agent screenshots ITS tab, not the OS-visible
    // one (Phase 3 fix). resolveTab returns the active tab for the top-level agent,
    // which captures directly; a background-bound child tab is activated around the
    // capture inside captureAndDescribe, then the prior tab is restored.
    const shotTab = await resolveTab(ctx);
    return await captureAndDescribe({ focus: args.focus, settings: ctx.settings, signal: ctx.signal, tab: shotTab });
  }

  // Real web research — LIVE in a real browser tab (real session, human-paced) so
  // engines don't captcha us like a headless scrape. Sub-agents search in their own
  // bound tab (visible); the top-level agent uses a throwaway tab (active tab untouched).
  // Extension-owned "/" shortcuts + schedules (2026-09-08a): no tab, no page — the
  // "shortcuts panel" is chrome.storage, and chrome-extension:// pages are unreachable
  // to the page tools anyway (resume-tailoring export 2026-09-08 01:00).
  if (SHORTCUT_TOOL_NAMES.has(name)) {
    return await runShortcutTool(name, args, ctx);
  }

  if (name === "web_search") {
    return await webSearchLive(args.query, args.limit, ctx);
  }

  // Authoritative ServiceNow API Reference lookup (C:\redacted\path) — a read-only doc
  // fetch, no active tab required. Available in every tool-capable phase so all
  // models share one source of truth (gates get the same corpus by injection).
  if (name === "sn_api_reference") {
    return await lookupSnApiReference(ctx.settings, args.query, args.artifact);
  }

  // Google research via a background tab (renders JS → organic results + AI Overview),
  // then closes it — richer + less rate-limited than web_search, no active-tab disruption.
  if (name === "google_search") {
    return await googleSearch(args.query, args.limit);
  }

  // Desktop control (desktop_*) — OS mouse/keyboard/screen via the local bridge.
  // No browser tab required. Two hard gates BEFORE any bridge call:
  //   1. Opt-in: refuse unless Settings → desktopControlEnabled is ON (defense in
  //      depth — background.js also hides these tools when off, but a resumed run
  //      or text-tool-call fallback could still route one here).
  //   2. (M1 fail-closed happens above via M1_SAFE_AT_EXECUTOR, which excludes
  //      every desktop_* name, so they're already refused on the M1 origin.)
  if (DESKTOP_TOOL_NAMES.has(name)) {
    if (DESKTOP_ACTION_TOOL_NAMES.has(name)) { // REAL-MONEY page: an OS-level click bypasses every content.js submit guard (an internal review P2)
      try { const lt = await resolveTab(ctx); if (lt && /live-trading/i.test(lt.url || "")) return { error: "Desktop control is DISABLED on the Live Trading (real-money) page — an OS-level click bypasses the submit guards. Use click_element / fill_input / press_key." }; } catch {}
    }
    if (!ctx.settings || !ctx.settings.desktopControlEnabled) {
      return { error: `Desktop control is OFF. Enable it in ⚙ Settings → "Enable desktop control" (and start desktop-server\\start-desktop.bat) before using "${name}".` };
    }
    const s = ctx.settings;
    switch (name) {
      case "desktop_get_screen_size": {
        const r = await desktopBridge(s, "/health", null, undefined, "GET");
        if (r.error) return r;
        return r.screen ? { width: r.screen.width, height: r.screen.height, platform: r.platform } : r;
      }
      case "desktop_screenshot": {
        const shot = await desktopBridge(s, "/screenshot", {});
        if (shot.error) return shot;
        const base64 = String(shot.image || "").split(",")[1];
        if (!base64) return { error: "Desktop screenshot returned no image data." };
        const desc = await describeImage({ base64, focus: args.focus, settings: s, signal: ctx.signal });
        if (desc.error) return desc;
        // Return the true (pre-downscale) screen size so the model clicks in the
        // real pixel space, not the shrunk-image space.
        return { ...desc, width: shot.width, height: shot.height, note: "Coordinates for desktop_click/desktop_move_mouse are in this full-screen pixel space (0,0 = top-left)." };
      }
      case "desktop_move_mouse":
        return await desktopBridge(s, "/move", { x: args.x, y: args.y });
      case "desktop_click":
        return await desktopBridge(s, "/click", { x: args.x, y: args.y, button: args.button, clicks: args.clicks });
      case "desktop_click_hold":
        return await desktopBridge(s, "/click_hold", { x: args.x, y: args.y, hold_ms: args.hold_ms, x2: args.x2, y2: args.y2, button: args.button });
      case "desktop_type":
        return await desktopBridge(s, "/type", { text: args.text });
      case "desktop_press_keys":
        return await desktopBridge(s, "/key", { keys: args.keys });
      case "desktop_scroll":
        return await desktopBridge(s, "/scroll", { amount: args.amount, x: args.x, y: args.y });
    }
  }

  // Enumerate ALL open tabs (not just the active one) so the model can fan out
  // over "my open tabs" via spawn_subagent scope.tabId. Read-only; no tab needed.
  if (name === "list_tabs") {
    const tabs = await chrome.tabs.query({});
    const list = tabs
      .filter((t) => /^https?:\/\//i.test(t.url || ""))
      .map((t) => ({ tabId: t.id, title: (t.title || "").slice(0, 120), url: t.url, active: !!t.active }));
    return {
      count: list.length,
      tabs: list,
      note: list.length
        ? "To summarize/act on each, issue one spawn_subagent per tab with scope_tab_id set to its tabId."
        : "No normal (http/https) web tabs are open."
    };
  }

  // run_command — shell exec via the desktop-server /exec bridge. Gated on the
  // SEPARATE commandExecEnabled opt-in (shell is more powerful than mouse control).
  // cwd defaults to the configured project directory (the File System Access API
  // hides the connected folder's OS path, so run_command can't derive it).
  if (name === "run_command") {
    try { const lt = await resolveTab(ctx); if (lt && /live-trading/i.test(lt.url || "")) return { error: "run_command is DISABLED while the Live Trading (real-money) page is active." }; } catch {} // MM pass 3 L6
    const s = ctx.settings || {};
    if (!s.commandExecEnabled) {
      return { error: "run_command is disabled. Turn on 'Run commands' in the extension Options (and start the desktop-server) to let me run shell commands like npm/git/tests." };
    }
    const cwd = String(args.cwd || s.projectDir || "").trim();
    if (!cwd) {
      return { error: "No working directory. Set the project directory in Options (or pass cwd) — I can't derive the connected folder's OS path from the browser." };
    }
    try {
      const secs = Number.isFinite(args.timeout_s) ? args.timeout_s : 120;
      const r = await desktopBridge(s, "/exec", { command: args.command, cwd, timeout_s: secs }, (secs + 15) * 1000);
      return r;
    } catch (e) {
      return { error: `run_command failed: ${e.message}. Is the desktop-server running (desktop-server/start-desktop.bat) and the token set in Options?` };
    }
  }

  // http_request — generic HTTP client (any API, not just ServiceNow). Runs from
  // the service worker (host_permissions <all_urls>). Non-GET mutates remote
  // state and is approval-gated by ACTION_TOOLS/ALWAYS_CONFIRM in background.js.
  if (name === "http_request") {
    const method = String(args.method || "GET").trim().toUpperCase();
    const mutating = !["GET", "HEAD"].includes(method);
    // MM pass 2 S5: normalize the destination before the real-money check (percent-encoding, dot segments, duplicate slashes).
    let _u; try { _u = new URL(String(args.url)); if (!/^https?:$/.test(_u.protocol)) throw 0; } catch { return { error: "http_request requires an absolute http(s) URL." }; }
    let _path; try { _path = decodeURIComponent(_u.pathname).replace(/\/+/g, "/"); } catch { return { error: "http_request refuses malformed URL encoding." }; }
    _path = _path.split("/").reduce((acc, seg) => { // MM pass 3 L4: collapse "." and ".." (also from %2f-joined segments)
      if (seg === "" || seg === ".") return acc;
      if (seg === "..") { const i = acc.lastIndexOf("/"); return i < 0 ? "" : acc.slice(0, i); }
      return acc + "/" + seg;
    }, "") || "/";
    if (mutating && /^\/api\/live-trading(?:\/|$)/i.test(_path)) { // an internal review P2 + pass 2 S5
      return { error: "http_request cannot POST/PUT/DELETE to the live-trading API — real-money orders go through the guarded form (Validate → Submit Order) only." };
    }
    const headers = {};
    if (args.headers && typeof args.headers === "object") {
      for (const [k, v] of Object.entries(args.headers)) headers[String(k)] = String(v);
    }
    const init = { method, headers, redirect: mutating ? "error" : "follow", signal: ctx.signal }; // MM pass 2 S5: a mutating request never follows a redirect
    if (args.body != null && method !== "GET" && method !== "HEAD") init.body = String(args.body);
    let res;
    try {
      res = await fetch(_u.href, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return { error: `http_request could not reach ${args.url}: ${e.message}` };
    }
    const respHeaders = {};
    try { res.headers.forEach((v, k) => { respHeaders[k] = v; }); } catch {}
    let bodyText = "";
    try { bodyText = await res.text(); } catch {}
    const CAP = 100000;
    const truncated = bodyText.length > CAP;
    return {
      url: _u.href, method, status: res.status, ok: res.ok,
      headers: respHeaders,
      body: truncated ? bodyText.slice(0, CAP) + "\n…[truncated]" : bodyText,
      truncated
    };
  }

  // Shared: turn PDF bytes into a tool result (or a helpful error). Reused by
  // read_pdf (explicit) and fetch_page (auto-detect). Same extract.js engine
  // read_file uses for local PDFs — so a URL PDF now reads like a folder PDF.
  async function pdfResultFromBytes(bytes, url, cap) {
    let text = "";
    try { ({ text } = await extractDocumentText(bytes, ".pdf")); }
    catch (e) { return { error: `read_pdf: could not extract text from ${url} — ${e.message}` }; }
    if (!text || !text.trim()) {
      return { error: `read_pdf: ${url} has no extractable text layer (likely a scanned/image-only PDF). If you have (or can download) a LOCAL copy, call read_pdf with its full local path (C:\\redacted\\path) — the desktop-server OCRs scanned pages with Tesseract. Otherwise open it in a tab and capture_screenshot.` };
    }
    const c = Number.isFinite(cap) ? cap : 12000;
    return {
      url, format: "pdf", title: "",
      text: text.length > c
        ? text.slice(0, c) + `\n…[truncated at ${c} of ${text.length} chars — re-call ONCE with max_chars: ${text.length + 1000} to get the WHOLE document]`
        : text,
      truncated: text.length > c, chars: text.length
    };
  }

  // read_pdf — fetch a PDF URL (unwrapping a chrome-extension viewer URL) and
  // extract its text layer. Fills the gap where read_page can't open PDFs and
  // fetch_page used to return raw %PDF bytes (live conv 2026-07-20).
  if (name === "read_pdf") {
    const url = pdfUrlFromViewer(args.url) || String(args.url || args.path || "").trim();
    const kind = classifyPdfRef(url);
    // LOCAL PDF (absolute Windows/UNC path or file:// URL) → desktop-server
    // /pdftext: PyMuPDF reads the REAL text (correct where the in-panel
    // extractor garbles subset-font encodings) and Tesseract auto-OCRs any
    // scanned pages. This is the fix for the "45 scroll+screenshot" runs.
    if (kind === "local") return await desktopPdfText(ctx.settings, { path: url }, args.max_chars);
    // CONNECTED-FOLDER PDF (2026-09-07c, Records-folder run): a path relative
    // to a 📁 Local files (MCP) folder, exactly as list_files shows it. The
    // panel supplies the bytes; the desktop-server OCRs them. Before this the
    // model was told to pass an absolute path it could not know, retried the
    // relative one four times and was refused as a "cycle".
    if (kind === "folder") {
      let resp;
      try { resp = await chrome.runtime.sendMessage({ type: "fs_op", op: "read_file_bytes", args: { path: url } }); }
      catch { resp = null; }
      if (!resp) return { error: `read_pdf: "${url}" is not a web URL or an absolute local path, and no connected 📁 Local files (MCP) folder answered for it (the side panel must be open with the folder that holds it connected — or pass the file's FULL absolute path such as C:\\redacted\\path).` };
      if (resp.error) return { error: `read_pdf: could not load "${url}" from the connected folder — ${resp.error}` };
      if (!/\.pdf$/i.test(resp.name || "")) return { error: `read_pdf: "${url}" is not a .pdf — use read_file for ${resp.name}.` };
      const out = await desktopPdfText(ctx.settings, { base64: resp.base64, name: resp.name, display: url }, args.max_chars);
      if (out.error) return out;
      return { root: resp.root, ...out, source: "connected folder → desktop-server (PyMuPDF + Tesseract OCR)" };
    }
    if (kind !== "http") return { error: "read_pdf needs a full http(s) PDF URL, a chrome-extension viewer URL that wraps one, an absolute LOCAL path like C:\\redacted\\path) folder like Records/scan.pdf (local paths and connected folders need the desktop-server running)." };
    let res;
    try { res = await fetch(url, { method: "GET", redirect: "follow", signal: ctx.signal }); }
    catch (e) { if (e && e.name === "AbortError") throw e; return { error: `read_pdf could not reach ${url}: ${e.message}` }; }
    if (!res.ok) return { error: `read_pdf: ${url} returned HTTP ${res.status}.` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikePdf(bytes)) return { error: `read_pdf: ${url} is not a PDF (no %PDF header). Use fetch_page for HTML pages.` };
    return await pdfResultFromBytes(bytes, res.url || url, args.max_chars);
  }

  // fetch_page — background GET + html→text; AUTO-ROUTES PDFs to the extractor.
  if (name === "fetch_page") {
    let res;
    try {
      res = await fetch(args.url, { method: "GET", redirect: "follow", signal: ctx.signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return { error: `fetch_page could not reach ${args.url}: ${e.message}. For pages needing your login, use navigate + read_page instead.` };
    }
    if (!res.ok) return { error: `fetch_page: ${args.url} returned HTTP ${res.status}. For pages needing your login/session, use navigate + read_page instead.` };
    const ctype = res.headers.get("content-type") || "";
    const buf = new Uint8Array(await res.arrayBuffer());
    // A PDF (by content-type or %PDF magic) gets its TEXT LAYER extracted instead
    // of the html→text path that would return raw binary (conv 2026-07-20).
    if (/application\/pdf/i.test(ctype) || looksLikePdf(buf)) {
      const pdf = await pdfResultFromBytes(buf, res.url || args.url, Number.isFinite(args.max_chars) ? args.max_chars : 8000);
      if (!pdf.error) return pdf; // else fall through to html (rare: %PDF header but no usable text)
    }
    let html = "";
    try { html = new TextDecoder("utf-8").decode(buf); } catch {}
    const { title, text } = htmlToReadableText(html);
    const cap = Number.isFinite(args.max_chars) ? args.max_chars : 8000;
    const off = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
    const truncated = off + cap < text.length;
    return {
      url: res.url || args.url, title,
      text: text.slice(off, off + cap) + (truncated ? `\n…[truncated at ${off + cap} of ${text.length} chars — call fetch_page again with offset=${off + cap} for the next chunk]` : ""),
      truncated,
      total_chars: text.length,
      offset: off,
      next_offset: truncated ? off + cap : undefined
    };
  }

  // RCA evidence tools: console tap + failed-network log for the resolved tab.
  if (name === "read_console" || name === "read_network") {
    let tab;
    try { tab = await resolveTab(ctx); } catch { tab = null; }
    if (!tab || tab.id == null) return { error: `${name} needs an open web page tab (the active tab, or the sub-agent's bound tab).` };
    return name === "read_console" ? await readConsoleTap(tab.id, args) : await readNetLog(tab.id, args);
  }

  // Cross-instance record diff — needs TWO stored connections, no tab required.
  if (name === "sn_compare_record") {
    const a = await resolveSnTargetByInstance(args.instance_a);
    const b = await resolveSnTargetByInstance(args.instance_b);
    if (!a || !b) {
      const have = await listSnInstances();
      const missing = [!a ? args.instance_a : null, !b ? args.instance_b : null].filter(Boolean).join('", "');
      return { error: `Instance(s) "${missing}" are not connected. Both must be added in the side panel → 🔌 ServiceNow (MCP). Connected: ${have.length ? have.join(", ") : "(none)"}.` };
    }
    try { return await snCompareRecord(a, b, args, ctx.signal); } catch (e) { return { error: e.message }; }
  }

  // Persistent agent notes (chrome.storage.local) — cross-run memory for watch
  // tasks and long multi-session work. Bounded: 50 notes, 20K chars each.
  if (name === "save_note" || name === "get_note") {
    const NOTES_KEY = "agentNotes";
    let notes = {};
    try { notes = (await chrome.storage.local.get(NOTES_KEY))[NOTES_KEY] || {}; } catch {}
    if (name === "get_note") {
      if (!String(args.name || "").trim()) {
        const list = Object.entries(notes).map(([k, v]) => ({ name: k, chars: (v.content || "").length, updated: new Date(v.updated).toISOString() }));
        return { count: list.length, notes: list, note: list.length ? "Pass a name to read one." : "No notes saved yet. save_note creates one." };
      }
      const key = String(args.name).trim();
      const v = notes[key];
      return v ? { name: key, content: v.content, updated: new Date(v.updated).toISOString() }
        : { error: `No note named "${key}". Call get_note without a name to list existing notes.` };
    }
    const key = String(args.name).trim();
    if (!String(args.content || "").trim()) {
      if (!notes[key]) return { ok: true, note: `No note named "${key}" existed — nothing to delete.` };
      delete notes[key];
      await chrome.storage.local.set({ [NOTES_KEY]: notes });
      return { ok: true, deleted: key };
    }
    if (!notes[key] && Object.keys(notes).length >= 50) {
      return { error: "Note limit (50) reached. Delete one (save_note with empty content) or reuse an existing name." };
    }
    notes[key] = { content: String(args.content).slice(0, 20000), updated: Date.now() };
    await chrome.storage.local.set({ [NOTES_KEY]: notes });
    return { ok: true, saved: key, chars: notes[key].content.length, note: "Persists across runs and browser restarts; read it back with get_note." };
  }

  // Local filesystem (Filesystem MCP). The File System Access permission lives in
  // the SIDE PANEL (the context where the user granted it via a gesture), and a
  // service-worker handle reports "prompt" even after a panel grant — so the actual
  // read/write MUST run in the panel. The service worker delegates via a runtime
  // message. If the panel is closed, the tools are unavailable (documented).
  if (name === "list_files" || name === "read_file" || name === "write_file" || name === "create_document" ||
      name === "create_folder" || name === "move_file" || name === "copy_file" || name === "delete_file" ||
      name === "edit_file" || name === "search_files") {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "fs_op", op: name, args });
    } catch {
      return { error: "Local file tools need the Local LLM side panel open (that is where folder access lives). Open the side panel and try again." };
    }
    if (!resp) return { error: "No response from the side panel for the file operation. Make sure a folder is connected via '📁 Local files (MCP)'." };
    // read_file on an IMAGE: the panel returns the (downscaled) base64; describe it
    // with the vision model — same path capture_screenshot uses — and hand the model
    // the description, never the raw base64.
    if (name === "read_file" && resp.image && resp.base64) {
      const { base64, ...meta } = resp;
      const desc = await describeImage({ base64, settings: ctx.settings, signal: ctx.signal });
      if (desc.error) return { ...meta, error: desc.error };
      return { ...meta, description: desc.description, vision_model: desc.vision_model, note: "Image file — described by the vision model (visible text, numbers, layout)." };
    }
    // read_file on a PDF with NO usable text layer (scanned, or an undecodable
    // subset font): the panel hands back the BYTES and the desktop-server reads
    // them with PyMuPDF + Tesseract (2026-09-07c). One read_file call now does
    // what used to take a read_pdf with an absolute path the model never had.
    if (name === "read_file" && resp.no_text_layer && resp.pdf_base64) {
      const { pdf_base64, extractor_error, ...meta } = resp;
      // MM 2026-09-07c P2: read_file's contract is `content` with a 200K default cap;
      // desktopPdfText's 12K default is read_pdf's. Keep both fields so the phase-engine
      // evidence flattener (keys on `content`) and read_pdf-style consumers both work.
      const out = await desktopPdfText(ctx.settings, { base64: pdf_base64, name: resp.name, display: resp.path },
        Number.isFinite(args.max_chars) ? args.max_chars : 200000);
      if (out.error) {
        return { ...meta, error: `${extractor_error} The automatic desktop-server OCR fallback (PyMuPDF + Tesseract) also failed: ${out.error} If the desktop-server is not running, tell the user in one line to start it (desktop-server\\start-desktop.bat) and retry this read ONCE after that; otherwise open the file in a tab and capture_screenshot. Do not retry the same call blindly.` };
      }
      return { ...meta, ...out, content: out.text, extracted: "pdf", note: `Text extracted by the desktop-server (PyMuPDF${out.ocr_pages ? " + Tesseract OCR on page(s) " + out.ocr_pages.join(", ") : ""}). ${out.note || ""}`.trim() };
    }
    return resp;
  }

  // ServiceNow MCP — query/update a ServiceNow instance. Three ways to pick WHICH
  // instance, in priority order:
  //   1. args.instance (per-call) or ctx.snInstance (a sub-agent's scope_instance
  //      default) — resolves to a STORED connection by name, NO open tab required.
  //   2. the sub-agent's bound tab (ctx.subScope.tabId) — its own instance.
  //   3. the active ServiceNow tab.
  if (name === "sn_query_table" || name === "sn_query_record" || name === "sn_query_schema" ||
      name === "sn_fetch_script_by_name" || name === "sn_fetch_script_by_sysid" || name === "sn_search_script_body" ||
      name === "sn_wf_activity_vars" || name === "sn_wf_activity_set" || name === "sn_wf_delete_activity" || name === "sn_wf_fix_script" || name === "sn_wf_publish" ||
      name === "sn_update_record" || name === "sn_create_record" || name === "sn_recent_changes") {
    let target = null, snTabId = null;
    const instanceHint = (args && args.instance) || (ctx && ctx.snInstance) || "";
    if (instanceHint) {
      // Tab-free: resolve a stored Basic-auth connection by instance name.
      target = await resolveSnTargetByInstance(instanceHint);
      if (!target) {
        const have = await listSnInstances();
        return { error: `No connected ServiceNow instance matches "${instanceHint}". Connected: ${have.length ? have.join(", ") : "(none — add it in the side panel → 🔌 ServiceNow (MCP))"}. Use one of those, or connect the instance first.` };
      }
      // A signed-in tab on the SAME instance is still the write fallback (and the
      // read fallback for the workflow-inputs reader) when the stored connection is refused.
      try {
        const t = await resolveTab(ctx);
        if (t && isServiceNowUrl(t.url) && new URL(t.url).origin === target.origin) snTabId = t.id;
      } catch {}
    } else {
      let tabOrigin = "";
      try {
        const t = await resolveTab(ctx);
        if (t && isServiceNowUrl(t.url)) { tabOrigin = new URL(t.url).origin; snTabId = t.id; }
      } catch {}
      // A sub-agent bound to a specific tab MUST hit THAT tab's instance — not a
      // globally-stored connection — so a fan-out doesn't funnel to one instance.
      const preferBoundTab = !!(ctx && ctx.subScope && ctx.subScope.tabId != null);
      target = await resolveSnTarget(tabOrigin, { preferBoundTab });
      if (!target) return { error: preferBoundTab
        ? "This sub-agent isn't bound to a logged-in ServiceNow tab and no instance was given. Pass `instance` (or spawn it with scope_instance: '<instance>') to target a connected instance without a tab, or bind it to the instance tab."
        : "No ServiceNow instance connected. Open the side panel → '🔌 ServiceNow (MCP)' and connect an instance (URL + username + password), or pass `instance` / open a logged-in ServiceNow tab, then retry." };
    }
    // Session fallback for the workflow-inputs reader: when a logged-in SN tab is
    // at hand, a REST 401/403 (Basic-Auth Restriction) re-runs the same Table API
    // queries through that tab's g_ck session instead of failing the call.
    const sessionQuery = snTabId != null
      ? (table, query, fields, limit) => snQuerySession(snTabId, { table, query, fields, limit, display_value: "false" })
      : null;
    try {
      if (name === "sn_query_table") return await snQueryTable(target, args, ctx.signal);
      if (name === "sn_query_record") return await snQueryRecord(target, args, ctx.signal);
      if (name === "sn_query_schema") return await snQuerySchema(target, args, ctx.signal);
      if (name === "sn_fetch_script_by_name") return await snFetchScriptByName(target, args, ctx.signal);
      if (name === "sn_fetch_script_by_sysid") return await snFetchScriptBySysId(target, args, ctx.signal, sessionQuery);
      if (name === "sn_wf_activity_vars") return await snWorkflowActivityVars(target, args, ctx.signal, sessionQuery);
      if (name === "sn_search_script_body") return await snSearchScriptBody(target, args, ctx.signal);
      if (name === "sn_recent_changes") return await snRecentChanges(target, args, ctx.signal);
      // sn_update_record / sn_create_record (WRITE): the resolved target first,
      // then the signed-in tab's own session (cookie + X-UserToken g_ck) when the
      // instance refuses it — or the reverse once it has refused Basic auth. The
      // session route is the one the UI uses, so the extension keeps working on the
      // task from the tab the owner is signed in on (snWriteRecord in sn-tools.js).
      const session = snTabId != null ? { origin: target.origin, getToken: () => snUserToken(snTabId) } : null;
      // Workflow-activity edits add a third route — the activity's own form in
      // the signed-in tab — for instances that ACL sys_variable_value against API
      // writes (customer-dev, 2026-09-02). The driver below is the only chrome.* the
      // tool touches; sn-tools.js stays testable in node.
      if (name === "sn_wf_activity_set") {
        const form = snTabId != null ? snFormDriver(snTabId) : null;
        return await snWorkflowActivitySet(target, args, ctx.signal, { sessionQuery, session, form });
      }
      if (name === "sn_wf_delete_activity") return await snWorkflowDeleteActivity(target, args, ctx.signal, { sessionQuery, session });
      if (name === "sn_wf_fix_script") return await snWorkflowFixScript(target, args, ctx.signal, { sessionQuery, session });
      // sn_wf_publish flushes the server cache through the signed-in tab (cache.do) once
      // the version reads back published=true — the step a Table-API publish skips.
      if (name === "sn_wf_publish") {
        const cache = snTabId != null ? snCacheFlusher(snTabId, target.origin) : null;
        return await snWorkflowPublish(target, args, ctx.signal, { sessionQuery, session, cache });
      }
      return await snWriteRecord(name, target, args, ctx.signal, session);
    } catch (e) {
      return { error: e.message };
    }
  }

  // ServiceNow login on the current/bound tab using STORED credentials. Fills
  // user/pass from the matching connection and clicks Log in — the password is read
  // from storage and injected into the page, never exposed to the model.
  if (name === "sn_login") {
    const tab = await resolveTab(ctx);
    if (!tab || !/^https?:\/\//i.test(tab.url || "")) return { error: "sn_login needs an open ServiceNow login tab. Open the instance's login page first (or spawn the child with scope_url to it)." };
    let tabOrigin = ""; try { tabOrigin = new URL(tab.url).origin; } catch {}
    return await performSnLogin(tab.id, (args && args.instance) || (ctx && ctx.snInstance) || tabOrigin);
  }

  // Day-trading risk posture — TIGHTEN-ONLY session max-loss cap. Runs the same
  // authenticated PUT the dashboard would make, injected into the Day Trading
  // page's MAIN world so it reuses the page's live Firebase session (no keys or
  // tokens ever enter the extension or the model context). The SERVER is the
  // enforcing authority: tighten-only vs the operator ceiling (403), $100 floor,
  // 3 material changes/ET-day + 5-min interval, audited, expires at the ET
  // session boundary — this tool is a thin caller, not a policy layer.
  if (name === "set_session_max_loss") {
    const dtTab = await resolveTab(ctx);
    // 2026-09-11: the REAL-MONEY page (live-trading.html) has its own module + own cap; the tool
    // targets whichever module owns the ACTIVE page and never crosses over.
    const isLivePage = !!(dtTab && /live-trading/i.test(dtTab.url || ""));
    if (!isLivePage && ctx && ctx.settings && ctx.settings.riskPostureEnabled === false) { // paper toggle governs the paper page only (an internal review P9)
      return { error: "set_session_max_loss is disabled — the 'risk posture' toggle in the extension Options is OFF." };
    }
    if (isLivePage && ctx && ctx.settings && ctx.settings.liveRiskPostureEnabled === false) {
      return { error: "set_session_max_loss is disabled on the LIVE page — the 'live risk posture' toggle in the extension Options is OFF." };
    }
    if (!dtTab || !(isLivePage || /day-trading/i.test(dtTab.url || ""))) {
      return { error: "set_session_max_loss only works on the Day Trading or Live Trading page — open/focus that tab first." };
    }
    const capApiPath = isLivePage ? "/api/live-trading/session-goals/agent-cap" : "/api/day-trading/session-goals/agent-cap";
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: dtTab.id },
        world: "MAIN",
        func: async (maxLoss, rationale, apiPath) => {
          try {
            const u = (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth().currentUser : null;
            const token = u ? await u.getIdToken() : null;
            const res = await fetch(apiPath, {
              method: "PUT",
              headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
              body: JSON.stringify({ maxLoss, rationale })
            });
            const body = await res.json().catch(() => null);
            return { httpStatus: res.status, ...(body && typeof body === "object" ? body : {}) };
          } catch (e) {
            return { error: String((e && e.message) || e) };
          }
        },
        args: [Number(args.maxLoss), String(args.rationale || "").trim().slice(0, 300), capApiPath]
      });
      return (inj && inj.result) || { error: "No result from the trading page (is it fully loaded and are you signed in?)." };
    } catch (e) {
      return { error: e.message };
    }
  }

  // self_feedback records a reinforcement signal / distills a lesson — it touches NO browser tab,
  // so handle it before resolveTab (works even when no tab is available).
  if (name === "self_feedback") {
    const v = parseInt(args.value, 10);
    if (v !== 1 && v !== -1) return { error: "self_feedback 'value' must be 1 (👍) or -1 (👎)." };
    const reason = String(args.reason || "").trim();
    if (v < 0) {
      const text = String(args.lesson || reason).trim();
      if (text.length < 10) return { error: "For a 👎 (value:-1), provide a 'lesson' — a short, general imperative rule (≥10 chars) to avoid this mistake next time." };
      try {
        const l = await addLesson(text, "self-critique");
        return { ok: true, recorded: "👎", lesson_saved: l ? l.text : text, note: "Lesson saved — it will be injected into your future runs. Keep going with the next task." };
      } catch (e) { return { ok: false, error: "could not save the lesson: " + e.message }; }
    }
    return { ok: true, recorded: "👍", note: reason ? `Noted: ${reason.slice(0, 140)}` : "Positive self-assessment noted." };
  }

  // MF-1: a sub-agent acts on its bound tab; everyone else on the active tab.
  const tab = await resolveTab(ctx);

  switch (name) {
    case "get_tab_info":
      return { title: tab.title, url: tab.url };

    case "switch_tab": {
      const id = parseInt(args.tabId, 10);
      if (!Number.isInteger(id)) return { error: "switch_tab requires a numeric tabId from list_tabs." };
      let t;
      try { t = await chrome.tabs.get(id); } catch { return { error: `No open tab with id ${id} — call list_tabs for current ids.` }; }
      try {
        await chrome.tabs.update(id, { active: true });
        if (t.windowId != null) { try { await chrome.windows.update(t.windowId, { focused: true }); } catch (_e) {} }
      } catch (e) { return { error: `Could not switch to tab ${id}: ${e.message}` }; }
      await new Promise((r) => setTimeout(r, 200)); // let the tab become active before the next tool reads it
      try { t = await chrome.tabs.get(id); } catch (_e) {}
      return { ok: true, active_tab: { tabId: id, title: t && t.title, url: t && t.url }, note: "This tab is now active — read_page / query_elements / navigate / the sn_* tools now act on it." };
    }

    case "close_tab": {
      const closed = { title: tab.title, url: tab.url };
      await chrome.tabs.remove(tab.id);
      return { ok: true, closed };
    }

    case "list_editors":
      return await listEditors(tab.id);

    case "get_editor_value":
      return await getEditorValue(tab.id, Number(args.index), args.max_chars);

    case "set_editor_value":
      return await setEditorValue(tab.id, Number(args.index), args.value, args.append);

    case "save_record":
      return await saveServiceNowRecord(tab.id);

    case "sn_set_field":
      if (!String(args.field || "").trim()) return { error: "sn_set_field requires the field name, e.g. { field: 'client_callable', value: 'true' }." };
      return await setServiceNowField(tab.id, { field: args.field, value: args.value, display: args.display, append: args.append });

    case "sn_form_fields":
      return await getServiceNowFormFields(tab.id);

    case "sn_check_duplicate":
      return await snCheckDuplicate(tab.id, { table: args.table, name: args.name, sysId: args.sys_id });
    case "sn_query_session":
      return await snQuerySession(tab.id, { table: args.table, query: args.query, fields: args.fields, limit: args.limit, display_value: args.display_value });

    case "navigate": {
      let url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return { error: "URL must start with http:// or https://" };
      // M1 defense-in-depth (independent of the background.js loop guard): if the CURRENT
      // tab is on the M1 brokerage origin, only allow navigating to an allowlisted
      // read-only M1 route. Gated on the live tab origin so it holds even if m1ReadOnly
      // wasn't plumbed into this executor. Real-money account — fail closed.
      try {
        const curHost = new URL(tab.url || "").hostname.toLowerCase();
        if (curHost === "dashboard.m1.com" && !isM1ReadOnlyRoute(url)) {
          return { error: `M1 read-only: navigation restricted to read-only M1 pages (home, Invest portfolio, Concentration analysis). "${url.slice(0, 200)}" is blocked — no trading, transfers, settings, or login.` };
        }
      } catch {}
      // POLARIS UNWRAP (2026-07-19, live a-live-run): models copy the address-bar
      // URL from read_page output — which shows the polaris target segment
      // percent-encoded — and re-navigating to it NESTS the wrapper until the
      // page 404s. Normalize to the clean single-wrap form; a clean URL is
      // returned unchanged.
      let unwrapped = false;
      {
        const norm = normalizeSnPolarisUrl(url);
        if (norm !== url) { url = norm; unwrapped = true; }
      }
      // Safety net: local models sometimes invent a placeholder ServiceNow host
      // (e.g. dev99999.service-now.com) instead of staying on the user's
      // logged-in instance. Correct ONLY between genuine INSTANCES: the current
      // tab AND the requested host must both be real instances (hyphenated
      // service-now.com) but different — the requested one is then almost
      // certainly hallucinated, so rewrite it to the current instance's origin.
      // The old check used isServiceNowUrl on both sides, which also matched
      // www/docs/community.servicenow.com — so a stray www.servicenow.com tab
      // (open from earlier research/docs) HIJACKED a real dev000000.service-now.com
      // navigation to the marketing site → "Page not found" (live PE5 a-live-run).
      // Requiring genuine instances also stops correcting an intentional
      // instance→docs navigation. (Cross-site nav to non-SN URLs is untouched.)
      let corrected = false;
      try {
        const reqU = new URL(url);
        const curU = new URL(tab.url || "");
        if (curU.host && reqU.host !== curU.host
          && isServiceNowInstanceHost(curU.host) && isServiceNowInstanceHost(reqU.host)) {
          reqU.protocol = curU.protocol;
          reqU.host = curU.host;
          url = reqU.toString();
          corrected = true;
        }
      } catch {}
      // Neutralize a native "Leave site? Changes you made may not be saved" (beforeunload) dialog
      // before navigating. It is a BROWSER-CHROME modal the agent cannot click, so an unsaved form
      // (e.g. a dirty ServiceNow record) would otherwise HANG navigation ("failed to interact with
      // a javascript popup"). The agent explicitly chose to navigate, so we accept the unload:
      // clear window.onbeforeunload AND stop any addEventListener('beforeunload') handler (capture
      // phase + stopImmediatePropagation + clear returnValue). Best-effort MAIN-world inject,
      // DEADLINE-RACED (2026-09-02 port): an un-bounded executeScript on a renderer that is
      // pinned parks navigate forever — the same hang class Local LLM fixed on 2026-09-01.
      try {
        await withDeadline(chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN",
          func: () => {
            try { window.onbeforeunload = null; } catch (_e) {}
            try {
              window.addEventListener("beforeunload", (e) => {
                e.stopImmediatePropagation();
                try { delete e.returnValue; } catch (_x) { e.returnValue = undefined; }
              }, { capture: true });
            } catch (_e) {}
          }
        }), 1500, null);
      } catch (_e) { /* scripting blocked on this page → navigate anyway */ }
      // RESUME, DON'T RESTART (2026-09-07 six-instance login run): when this tab is
      // ALREADY navigating to exactly this URL — runChild pre-navigates a sub-agent's
      // tab, and the child's first move is usually navigate to that same URL — a
      // tabs.update cancels the in-flight request and starts the slow server over
      // from zero. Just wait for the load that is already under way.
      let resumed = false;
      try {
        const live = await chrome.tabs.get(tab.id);
        // MM 2026-09-07c P4: before the first byte arrives Chrome keeps the target in
        // pendingUrl and reports url as "" / about:blank — exactly the slow-server case.
        if (live && live.status === "loading" && (live.url === url || live.pendingUrl === url)) resumed = true;
      } catch {}
      if (!resumed) await chrome.tabs.update(tab.id, { url });
      const budgetMs = loadBudgetMsFor(url);
      const loaded = await waitForLoad(tab.id, budgetMs);
      // Tell the truth when the budget ran out with the document still arriving.
      // The old code returned ok:true here, and the model then read, clicked and
      // screenshotted a page that did not exist yet.
      if (!loaded && (await tabStatus(tab.id)) === "loading") {
        let host = ""; try { host = new URL(url).host; } catch {}
        return {
          ok: false, still_loading: true, navigated_to: url, tab_status: "loading",
          error: `The page is STILL LOADING after ${Math.round(budgetMs / 1000)}s — ${host || "the server"} has not finished sending it. This is a slow server, not a hung page: do NOT reload, click, read, or screenshot it yet (a read fails and a reload restarts the slow request from zero). Call navigate AGAIN with this SAME url — it resumes waiting on the in-flight load instead of restarting it. If it is still loading after that second try, report this instance as "not responding (page never finished loading)" and stop.`
        };
      }
      const notes = [];
      if (unwrapped) notes.push("URL unwrapped — it was a re-copied polaris address-bar URL (encoded params/target segment); nesting it again breaks the page.");
      if (corrected) notes.push("Host corrected to the current instance origin — the requested host was not the logged-in ServiceNow instance.");
      // SN CLASSIC 404 SELF-HEAL (2026-08-02 run — see helpers above waitForLoad):
      // detect the "Page not found" page here, retry ONCE via the polaris wrapper,
      // and surface the outcome in THIS result so no read_page is spent on it.
      let landedUrl = url;
      let snNotFound = false;
      try {
        const isClassicWrapped = /\/now\/nav\/ui\/classic\/params\/target\//.test(url);
        const isBareClassicDo = !isClassicWrapped && wrapSnClassicTarget(url) !== url;
        if (isServiceNowUrl(url) && (isClassicWrapped || isBareClassicDo)) {
          if (isClassicWrapped) await waitForSnClassicFrame(tab.id, url);
          if (await snPageNotFound(tab.id)) {
            const wrapped = wrapSnClassicTarget(url);
            if (wrapped !== url) {
              await chrome.tabs.update(tab.id, { url: wrapped });
              await waitForLoad(tab.id);
              await waitForSnClassicFrame(tab.id, wrapped);
              landedUrl = wrapped;
              if (await snPageNotFound(tab.id)) snNotFound = true;
              else notes.push('The bare classic .do rendered ServiceNow\'s "Page not found" — auto-retried via /now/nav/ui/classic/params/target/ and landed; use that wrapper form for classic lists/forms from the start.');
            } else {
              snNotFound = true;
            }
          }
        }
      } catch {}
      if (snNotFound) {
        const tableGuess = (landedUrl.match(/([a-z0-9_]+?)(?:_list)?\.do/i) || [])[1] || "";
        return {
          ok: false, page_not_found: true, navigated_to: landedUrl,
          error: `ServiceNow rendered "Page not found" for this target (tried the polaris wrapper form too). Do NOT re-read this page or browse sys_db_object lists by label. Settle whether the table exists in ONE call: sn_query_session {table:"sys_db_object", query:"name=${tableGuess || "<table>"}", fields:"name,label,super_class"}. If it exists, the target likely needs a different page or your role lacks access — say so; if it does not exist, report that and move on.`
        };
      }
      return notes.length ? { ok: true, navigated_to: landedUrl, note: notes.join(" ") } : { ok: true, navigated_to: landedUrl };
    }

    case "send_sms":
      return await sendSms(args);

    case "send_email":
      return await sendEmail(args);

    case "click_element": {
      // HARD GUARD: clicking the ServiceNow "Log in" button on a login form is
      // unreliable (empty/autofilled-but-unregistered fields → blank submit). The
      // content script flags it; auto-route to the stored-credential login instead.
      // Route to the frame that owns the handle (the button may live in a course/
      // SCORM iframe, not the top document).
      const r = await sendToActingFrame(tab.id, { type: "TOOL", name, args });
      if (r && r.needsSnLogin) {
        const inst = (ctx && ctx.snInstance) || r.origin || tab.url;
        return await performSnLogin(tab.id, inst);
      }
      return r;
    }
    // MERGE across frames: gather matches from every frame (top + embedded course
    // iframes) so checkboxes/buttons/arrows inside a SCORM SCO are actually found.
    case "query_elements":
      return await queryElementsAllFrames(tab.id, args);
    // ROUTE to the owning/acting frame: these act on a frame-unique handle (or a
    // per-frame search), so broadcast and take the frame that actually acted —
    // otherwise the top frame answers "no element" and the real target (in the
    // course iframe) is never touched.
    case "fill_input":
    case "send_chat_message":
    case "read_chat_messages":
    case "draft_chat_message":
    case "delete_chat_message":
    case "select_option":
    case "drag_drop":
    case "control_media":
    case "open_form_section":
    case "set_reference_field":
    case "get_reference_suggestions":
    case "get_computed_style":
      return await sendToActingFrame(tab.id, { type: "TOOL", name, args });
    // read_page MERGES across frames (deduped) so embedded course/SCORM slide text
    // is readable, not just the top document.
    // URL-TARGETED READ (2026-09-09). read_page used to ignore args.url entirely and
    // read whatever the active tab held. The competitive-intel run (export 15:51) asked
    // for four different URLs, got northwind-pricing four times, and then INVENTED the
    // other three pages — including a competitor price table where not one number was
    // real. A read that cannot prove which page it read is a fabrication engine, so:
    // a url navigates first (reusing navigate's guards, polaris unwrap and still-loading
    // truth), and the landed URL is checked against the request before any text is
    // returned. A mismatch is an ERROR, never quietly-someone-else's content.
    case "read_page": {
      let readTab = tab;
      const wantUrl = String(args.url || "").trim();
      // Where the navigation actually LANDED (navigate rewrites the url itself: polaris
      // unwrap, instance-host correction, classic-404 self-heal) — the read is proven
      // against the request OR the landing, never only the request (MM 09-09 F7).
      let landedUrl = wantUrl;
      let navigated = false;
      let redirectedTo = "";
      const wantHash = wantUrl ? urlHash(wantUrl) : "";
      const strict = !!wantHash; // a requested #route must be proven too (F8)
      const onTarget = (u) => sameHttpUrl(u, wantUrl, strict) || (landedUrl !== wantUrl && sameHttpUrl(u, landedUrl, strict));
      if (wantUrl) {
        // EXECUTOR-SIDE GATES (MM 09-09 F3 / H-2a). The loop in background.js gates
        // read_page{url} like navigate; these hold even for a caller that did not plumb
        // the flags — a text-recovered call, a future refactor, a sub-agent.
        const needNav = !sameHttpUrl(readTab.url, wantUrl) || (strict && wantHash !== urlHash(readTab.url));
        if (needNav && ctx.readOnly && !ctx.m1ReadOnly) {
          return {
            error: `READ-ONLY mode is ON: read_page with a url would NAVIGATE the tab (it is showing ${String(readTab.url || "").slice(0, 200) || "another page"}), and navigation is an action this mode disables. NOTHING was read.`,
            requested_url: wantUrl, read: false,
            note: "Call read_page WITHOUT url to read the page that is already open, or ask the user to open the page and then read it."
          };
        }
        if (ctx.m1ReadOnly && !isM1ReadOnlyRoute(wantUrl)) {
          return {
            error: `M1 read-only: read_page may open only read-only M1 pages (home, Invest portfolio, Concentration analysis). "${wantUrl.slice(0, 200)}" is blocked — no trading, transfers, settings, or login. NOTHING was read.`,
            requested_url: wantUrl, read: false
          };
        }
        const beforeUrl = String(readTab.url || "");
        if (needNav) {
          // A throwing navigation (chrome.tabs.update rejects on a dead host) must come
          // back as an honest "nothing was read", not escape past this guard. A user
          // Stop (AbortError) is NOT an error to swallow — it propagates (MM 09-09 P3).
          let nav;
          try { nav = await executeTool("navigate", { url: wantUrl }, ctx); }
          catch (e) {
            if ((e && e.name === "AbortError") || (ctx.signal && ctx.signal.aborted)) throw e;
            nav = { error: String((e && e.message) || e) };
          }
          if (nav && (nav.error || nav.ok === false)) {
            return {
              error: `read_page could not open ${wantUrl}: ${nav.error || "navigation did not complete"}`,
              requested_url: wantUrl, read: false,
              ...(nav.still_loading ? { still_loading: true } : {}),
              note: "NOTHING was read. Do not describe this page — you have no content for it. Fix what the error names, or say in your answer that this page could not be read."
            };
          }
          navigated = true;
          if (nav && nav.navigated_to) landedUrl = String(nav.navigated_to);
          // navigate rewrites a placeholder instance host to the signed-in instance. For a
          // READ that is a different instance than the one asked for (MM pass 2, B-2): the
          // text would come back stamped with the wrong request. Refuse and say which.
          if (landedUrl !== wantUrl && !sameHttpHost(landedUrl, wantUrl)) {
            return {
              error: `read_page was asked for ${wantUrl} but the navigation was rewritten to ${landedUrl} (the requested host is not the signed-in instance). NOTHING was read for the requested URL.`,
              requested_url: wantUrl, landed_url: landedUrl, read: false,
              note: `The tab is now on ${(() => { try { return new URL(landedUrl).host; } catch { return landedUrl; } })()}. If you meant that instance, call read_page again with landed_url as the url (no navigation will be needed). If you meant a different instance, ask the user to open and sign in to it first.`
            };
          }
          try { const t2 = await chrome.tabs.get(readTab.id); if (t2) readTab = t2; } catch {}
        }
        // One tab, one page at a time: reads issued together clobber each other.
        const { url: liveUrl } = readTab.url ? readTab : (await chrome.tabs.get(readTab.id).catch(() => ({}))) || {};
        if (liveUrl && !onTarget(liveUrl)) {
          // The site moved the tab after OUR navigation: a redirect. Same site → read it
          // and SAY so (the model is told plainly whose text this is). Another host —
          // an SSO login page, a marketing site — is never passed off as the request.
          // A tab still on the page it showed BEFORE the navigation did not redirect: it
          // never moved (the original 15:51 bug shape) — that stays a refusal.
          const stuck = beforeUrl && sameHttpUrl(liveUrl, beforeUrl, true);
          if (navigated && looksLikeLoginUrl(liveUrl) && !looksLikeLoginUrl(wantUrl)) {
            // A session that expired bounces to login.do on the SAME host (MM pass 2, B-1).
            // A login-like REQUEST that lands on a login-like url is the page that was asked
            // for and falls through to the normal proof (MM pass 3, N-8).
            return {
              error: `read_page opened ${wantUrl} but the navigation landed on an authentication-like URL (${liveUrl}). The requested content was NOT verified and NOTHING was read for it.`,
              requested_url: wantUrl, tab_url: liveUrl, read: false, login_required: true,
              note: "Most often the session is not signed in or has expired: ask the user to sign in on that tab, then read the page again. If the landing page itself is what you need, call read_page with the landing url. Do NOT describe the requested page from memory, and do NOT type credentials."
            };
          }
          if (navigated && !stuck && isSiteRoot(liveUrl) && !isSiteRoot(wantUrl)) {
            // A catch-all redirect to the home page is not the page that was asked for.
            return {
              error: `read_page opened ${wantUrl} but the navigation landed at the site root (${liveUrl}). The requested content was NOT verified — the page may not exist there, or the site redirects unknown paths home. NOTHING was read for the requested URL.`,
              requested_url: wantUrl, tab_url: liveUrl, read: false, redirected_home: true,
              note: "Do NOT describe the home page as the requested page. If the home page itself is useful, call read_page with the landing url."
            };
          }
          if (navigated && !stuck && (sameHttpHost(liveUrl, wantUrl) || sameHttpHost(liveUrl, landedUrl))) {
            redirectedTo = liveUrl;
          } else {
            const crossHost = navigated && !stuck;
            return {
              error: crossHost
                ? `read_page opened ${wantUrl} but the site sent the tab to ${liveUrl} — a redirect to another host (often a login or consent page). NOTHING was read for the requested URL.`
                : `read_page was asked for ${wantUrl} but the tab is showing ${liveUrl}. NOTHING was read for the requested URL.`,
              requested_url: wantUrl, tab_url: liveUrl, read: false,
              note: crossHost
                ? "If this is a login page, say so and ask the user to sign in; do NOT describe the requested page. Otherwise call read_page again for this URL ALONE."
                : "The tab did not end up on the requested page — several read_page calls issued at once share ONE tab, or something else moved it. Call read_page again for this URL ALONE and wait for the result before requesting another page. Do NOT describe the requested page until a read actually returns it."
            };
          }
        }
      }
      const out = await readPageAllFrames(readTab.id, args);
      if (wantUrl && out && !out.error) {
        // The post-read witness is the page's own location.href. Absent, the read
        // cannot be proven to be the requested page — fail closed (MM 09-09 B).
        if (!out.url) {
          return {
            error: `read_page opened ${wantUrl} but the page did not report its own URL, so the text cannot be proven to be that page. The text was DISCARDED.`,
            requested_url: wantUrl, read: false,
            note: "Read this URL again on its own. If it keeps happening the page blocks the content script; say the page could not be read."
          };
        }
        const proven = onTarget(out.url) || (redirectedTo && sameHttpUrl(out.url, redirectedTo, strict));
        if (!proven) {
          return {
            error: `read_page was asked for ${wantUrl} but the content that came back is from ${out.url}. The text was DISCARDED — it is not the page you requested.`,
            requested_url: wantUrl, tab_url: out.url, read: false,
            note: "Read this URL again on its own, one page per call, and wait for the result. Never present another page's text as this page's content."
          };
        }
        out.requested_url = wantUrl;
        if (redirectedTo) {
          out.redirected_to = redirectedTo;
          out.note = `REDIRECTED: the request for ${wantUrl} landed on ${redirectedTo} (same site). The text above is THAT page's — name it as the source if you cite it.`;
        } else if (landedUrl !== wantUrl && !sameHttpUrl(out.url, wantUrl, strict)) {
          out.landed_url = landedUrl;
          out.note = `URL REWRITTEN before loading: ${wantUrl} → ${landedUrl} (same site; a polaris unwrap, or the classic-form wrapper after a "Page not found"). The text above is THAT page's — name it as the source, and say so if it is itself an error or "not found" page.`;
        }
      }
      return out;
    }
    // TOP-FRAME semantics (viewport scroll; focused-element key): aggregating these
    // across frames would mis-target.
    case "scroll_page":
    case "press_key":
      return await sendToContent(tab.id, { type: "TOOL", name, args });

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

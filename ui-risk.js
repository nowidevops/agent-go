// ui-risk.js — display-only risk tier for approval cards (2026-09-14 UI redesign).
// This does NOT decide when approval is asked; background.js (ACTION_TOOLS,
// ALWAYS_CONFIRM_TOOLS, approval gate) is unchanged and remains the only authority.
// It only picks the band color and wording so reading, typing, sending and
// deleting look different at a glance. ui-risk.test.mjs keeps it in step with
// the real tool lists. Author: iDevOpsLLC

const DELETE = new Set([
  "delete_file", "delete_chat_message", "sn_wf_delete_activity", "run_command",
  "set_session_max_loss", "write_file", "edit_file"
]);
const SEND = new Set([
  "send_chat_message", "send_email", "send_sms", "save_record", "sn_update_record",
  "sn_create_record", "sn_set_field", "sn_wf_publish", "sn_wf_fix_script", "sn_wf_activity_set",
  "set_editor_value", "set_reference_field", "click_element", "drag_drop", "control_media",
  "open_form_section", "close_tab", "sn_login",
  "desktop_move_mouse", "desktop_click", "desktop_click_hold", "desktop_type", "desktop_press_keys", "desktop_scroll"
]);
const TYPE = new Set([
  "fill_input", "press_key", "select_option", "draft_chat_message", "create_folder",
  "move_file", "copy_file", "create_shortcut", "create_document", "navigate"
]);

export const RISK_META = {
  review: { label: "Needs your OK · check the details below" },
  read: { label: "Reads only" },
  type: { label: "Types, navigates or saves a file" },
  send: { label: "Sends, submits or acts as you" },
  delete: { label: "Deletes, overwrites or runs a command" }
};

export function riskTier(name, args) {
  const n = String(name || "");
  if ((n === "move_file" || n === "copy_file") && args && args.overwrite === true) return "delete";
  if (n === "http_request") {
    const method = String((args && args.method) || "GET").toUpperCase();
    return method === "GET" || method === "HEAD" ? "read" : "send";
  }
  if (DELETE.has(n)) return "delete";
  if (SEND.has(n)) return "send";
  if (TYPE.has(n)) return "type";
  if (n.startsWith("desktop_") && n !== "desktop_screenshot" && n !== "desktop_get_screen_size") return "send";
  return "read";
}

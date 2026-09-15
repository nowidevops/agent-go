// mic-permission.js — one-shot mic grant for the extension origin. The side
// panel sometimes can't render Chrome's permission prompt; this normal tab can.
// Once granted here, getUserMedia works in the side panel too. Author: iDevOpsLLC
const msg = document.getElementById("msg");
navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
  stream.getTracks().forEach((t) => t.stop());
  msg.innerHTML = '<span class="ok">✓ Microphone granted.</span> You can close this tab and click the mic in the side panel again.';
  setTimeout(() => window.close(), 2500);
}).catch((e) => {
  msg.innerHTML = '<span class="bad">✗ ' + (e.name === "NotAllowedError"
    ? "Permission denied. Click the 🔒/camera icon in the address bar, allow the microphone, then reload this page."
    : "Failed: " + (e.message || e)) + "</span>";
});

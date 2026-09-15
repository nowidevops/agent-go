# Security

Report a vulnerability to info@nowidevops.com. Please do not open a public issue for it.

Scope notes:
- The extension holds no provider API keys. A bring-your-own-key, if you set one, is stored in
  the browser's local extension storage on your machine only.
- ServiceNow writes go through your own signed-in session or a stored Basic-auth connection
  you add yourself; 401/403 responses are surfaced with the instance's own reason and never
  retried blindly.
- The optional local bridges listen on 127.0.0.1 only and require a token; keep "Enable Run
  commands" off unless you need it.

# Contributing

- Keep the extension free of provider keys, instance hosts and personal paths. Use
  `devXXXXXX` / `customer-dev.example.com` style placeholders in tests and comments.
- Every behaviour change gets a test (`*.test.mjs`, plain Node) or an entry in the UAT script.
- Guardrails belong in code, not only in prompt text: a refusal must name the working
  alternative, and a claimed write must be read back before it is reported.
- Language in user-facing text: outcomes, not internals.

Run the suites before opening a pull request:

    npm install            # optional: only collapsible.test.mjs needs jsdom
    npm test

A suite that exits 77 is SKIPPED because an optional dev dependency is missing; that is not a
failure. Any other non-zero exit is.

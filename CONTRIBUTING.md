# Contributing

- Keep the extension free of provider keys, instance hosts and personal paths. Use
  `devXXXXXX` / `customer-dev.example.com` style placeholders in tests and comments.
- Every behaviour change gets a test (`*.test.mjs`, plain Node) or an entry in the UAT script.
- Guardrails belong in code, not only in prompt text: a refusal must name the working
  alternative, and a claimed write must be read back before it is reported.
- Language in user-facing text: outcomes, not internals.

Run the suites before opening a pull request:

    for f in *.test.mjs test/*.mjs; do node "$f" || exit 1; done

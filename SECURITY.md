# Security Policy

## Reporting a vulnerability

Do not report vulnerabilities in public issues, discussions, pull requests, or social posts. Email [bbtsl@pve.bio](mailto:bbtsl@pve.bio) instead.

The machine-readable contact for the deployed site is published at [`/.well-known/security.txt`](https://bbtsl.lol/.well-known/security.txt).

Include the affected URL, endpoint, file, or commit; the required access level; safe reproduction steps; expected impact; and any relevant screenshots or request samples. Do not include credentials, session cookies, owner keys, OAuth tokens, real secret values, or destructive proof-of-concept traffic.

When referring to a credential, use its variable name only. Never paste `.env`, `.dev.vars`, Wrangler secret output, local D1 data, or the contents of a secret-bearing deployment file into a report.

## Scope

Security reports are especially relevant to:

- Discord OAuth, D1-backed sessions, logout, and role authorization
- owner-only operations and audit trails
- media upload, public authorization, private quarantine, restoration, and deletion
- Worker API routes, D1 access, rate limiting, request validation, and object-level authorization
- crawler-policy bypasses and malicious-probe misclassification
- optional analytics consent, CSP, and unintended data transmission
- security headers and content-security policy
- local-only helper files that could be committed by mistake, including `.dev.vars`, `.env`, temp SQL helpers, local databases, and scratch exports

## Safe testing boundaries

Do not perform denial-of-service, crawler-flood, resource-exhaustion, credential-stuffing, or destructive testing against the production site. A single safe request demonstrating that an ordinary public route is incorrectly classified as a malicious probe is sufficient.

Do not modify production catalogue data, upload harmful content, enumerate private integration credentials, or access another person's active session. Use the smallest non-destructive reproduction that demonstrates the issue.

## Handling

The project aims to acknowledge valid reports within seven days. Fix timing depends on severity, impact, and reproducibility. Please avoid public disclosure until a fix is available.

If a report depends on a local-only file, Cloudflare dashboard setting, or developer workflow, say so explicitly so the maintainer can verify whether the issue affects the public repository, the deployed site, or only a local checkout.

Repository policy and live-site policy should stay aligned. If you update this file, also update `public/.well-known/security.txt` when the contact or canonical policy link changes.

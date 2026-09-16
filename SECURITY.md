# Security Policy

## Reporting A Vulnerability

Do not report security issues in public GitHub issues, discussions, or pull requests.

Send reports to:

- [bbtsl@pve.bio](mailto:bbtsl@pve.bio)

Include:

- affected URL, endpoint, or file
- clear reproduction steps
- impact summary
- screenshots or request samples if useful

## Scope

Security reports are especially relevant for:

- admin authentication
- session handling
- upload handling
- image delivery
- worker API routes
- rate limiting
- header and CSP handling

## Response Expectations

- Initial acknowledgement target: 7 days
- Fix timing depends on severity, impact, and reproducibility

## Handling Notes

- Do not post proof-of-concept exploits publicly before a fix is available
- Keep secrets, tokens, and private configuration out of reports unless absolutely required
- Local preview credentials and development-only secrets should still be treated as sensitive and not shared publicly

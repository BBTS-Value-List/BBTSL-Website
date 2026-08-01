# BBTSL Blade Ball Top Spender List

BBTSL is a public Blade Ball item site served by a Cloudflare Worker. It provides a searchable Top Spender list, media-backed item details, Discord sign-in, role-gated staff tools, bounded audit restoration, and layered crawler defenses.

## Architecture

- `public/` contains the static site, including the item list, public team directory, legal pages, and the optional analytics-consent controller.
- `src/worker.js` is the single configured Worker entrypoint. It makes request ordering explicit: probe filtering, crawler policy, session and OAuth boundaries, authorization, route dispatch, short state mutations, response finalization, and scheduled maintenance.
- `src/runtime/request-context.js` assembles explicit D1, R2, Assets, and execution-context dependencies. Focused adapters enforce schema and R2-usage policy without environment-wide proxies.
- Public assets use stable entrypoints such as `public/app.min.js`, `public/team.min.js`, `public/consent.min.js`, and `public/styles.css`. Readable source modules remain in `public/app.js`, `public/team.js`, and `public/consent.js`. Self-hosted fonts live under `public/fonts/`.
- `public/.well-known/security.txt` publishes the machine-readable security contact for the live site.
- Cloudflare R2 stores active site state and media. A separate private R2 bucket stores detached media for the 14-day restoration window.
- Cloudflare D1 stores users, roles, idempotent audit records, editor media-staging manifests, sessions, rate-limit counters, public-media authorization rows, quarantine manifests, maintenance state, and the site-state mutation lock.
- `scripts/generate-secret-token.mjs` generates a high-entropy value for a Worker secret.

## Requirements

- Node.js 22 or newer
- npm
- Cloudflare access only when deploying or using remote resources

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in local values without committing that file.

```powershell
npm install
npm run build:public-assets
npm run cf:dev
```

The local Worker listens on the URL printed by Wrangler. It uses local Wrangler state for D1 and R2 unless Wrangler is explicitly instructed otherwise.

## Validation

```powershell
npm run build:public-assets
npm run check
npx wrangler d1 migrations apply bladeball-value-list --local
npx wrangler deploy --dry-run
npm audit
```

For pull requests, run the checks that match the changed surface before requesting review. Cloudflare deployment is not done through GitHub.

Cloudflare deployment is an operator-driven action from a verified checkout, matching the production repository:

```powershell
npm run cf:deploy
```

## Configuration and secrets

The repository includes keyless `.env.example` and `.dev.vars.example` files. Never commit `.dev.vars`, `.env`, real credentials, session material, owner keys, OAuth secrets, migration secrets, or local Cloudflare state.

### Required server-only Worker secrets

- `ADMIN_SESSION_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `V1_API_CLIENT_SECRETS` — JSON object mapping approved integration client IDs to long random base secrets
- `MEDIA_MIGRATION_SECRET` — required only while using the protected legacy media-reconciliation endpoint

`DISCORD_REDIRECT_URI` is non-secret deployment configuration and is currently defined in `wrangler.jsonc` for the production origin.

### Optional server-side configuration

- `GA_MEASUREMENT_ID` — optional GA4 `G-...` measurement ID; this identifier is publishable configuration, but the Worker still validates and exposes it through `/api/public-config`

When the GA4 ID is missing or invalid, no analytics UI, script, Google request, or consent storage is introduced.

Public runtime values such as `PUBLIC_SITE_URL` and `SITE_NAME` belong in `wrangler.jsonc`. Put sensitive Worker values in Cloudflare secrets for deployments.

Generate a random value with:

```powershell
npm run secrets:generate
```

Do not print, paste, or commit generated values.

## Security lifecycle

- Detached or replaced media is copied to the private quarantine bucket before the live copy is removed.
- Revertible media and complete audit snapshots expire exactly 14 days after the original audit action.
- Audit entries remain visible without revert data for up to 90 days, then are deleted.
- Editor media uploads are staged privately as bounded multipart streams before the short card mutation lock. A final revision-checked, idempotent commit performs one site-state read and one site-state write.
- Uncommitted staged media expires after two hours and scheduled maintenance removes its private R2 objects and D1 manifests.
- Daily scheduled maintenance migrates legacy rows, resumes interrupted transitions, purges expired staged uploads, quarantine objects and audit data, and deletes expired sessions.
- Public media delivery requires an exact D1 authorization row and does not expose quarantine objects.
- Sessions are recorded and revocable in D1; logout, replacement, and account disablement invalidate copied cookies.

## Crawler and bot defenses

The Worker publishes an explicit search-versus-training policy through `robots.txt`, `llms.txt`, `llms-full.txt`, and `sitemap.xml`, marks non-public responses as `noindex`, and handles only known malicious probe paths with cheap local responses.

Known malicious probe paths receive local, cheap, non-cacheable responses. The live security contact is also published at `/.well-known/security.txt`.

## Optional analytics

GA4 remains completely disabled unless `GA_MEASUREMENT_ID` is configured. When configured:

- public HTML receives only a nonce-authorized same-origin consent controller;
- the Google script is not loaded until the visitor explicitly accepts;
- rejection sends no analytics request;
- the saved choice can be changed through the persistent Cookie settings control;
- staff actions, Discord IDs, audit details, item search terms, and media names are not sent as analytics events.

The current behavior is described in the live Privacy Policy.

## Private v1 API

`/api/v1/*` is a private integration API for approved server-side clients. The public website does not call it from the browser.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Service health and API version. |
| `GET /api/v1/swords` | Paginated item records. |
| `GET /api/v1/swords/%23ABC123` | One item by immutable card ID. URL-encode the `#`. |
| `GET /api/v1/team` | Active public team directory. |

### Authentication

Each client ID in `V1_API_CLIENT_SECRETS` gets a rotating 128-bit daily access key derived from its base secret.

Send these headers with every `/api/v1/*` request:

- `x-bbtsl-api-client: <client-id>`
- `x-bbtsl-api-date: <UTC date in YYYY-MM-DD>`
- `authorization: Bearer <32 hex chars>`

The daily bearer key is derived as:

- `HMAC-SHA-256(baseSecret, "bbtsl-v1:<clientId>:<yyyy-mm-dd>")`
- take the first 32 hex characters of that digest

Generate the current key locally with:

```powershell
npm run api:v1-key -- owner
```

`/api/v1/swords` accepts optional `category`, `badge`, `demand`, `trend`, `cardId`, `search`, `sort`, `limit`, and `offset` parameters. Valid sort values are `value-desc`, `value-asc`, `name-asc`, `updated-desc`, `count-desc`, `count-asc`, `demand-desc`, `demand-asc`, and `trend-rank`.

The private API is rate-limited per client and network, does not emit permissive CORS headers, and should only be called from trusted server-side code.

The staff site routes and mutation endpoints remain separate from the private integration API. They require Discord sign-in, active D1 session state, action-specific role capabilities, same-origin requests, and the Worker request-header checks enforced by the application.

## Contributor guidance

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Use the issue forms for public bugs, feature requests, and data corrections. Do not report vulnerabilities publicly. Follow [SECURITY.md](./SECURITY.md).

## Public links

- Repository: [BBTS-Value-List/BBTSL-Website](https://github.com/BBTS-Value-List/BBTSL-Website)
- Live site: [bbtsl.lol](https://bbtsl.lol)
- Blade Ball experience: [Roblox](https://www.roblox.com/games/13772394625/Blade-Ball)

## Legal

BBTSL is an unofficial fan project and is not affiliated with Roblox, Blade Ball, or their owners. Read the live [Privacy Policy](https://bbtsl.lol/privacy), [Terms of Service](https://bbtsl.lol/terms), and [legal notice](./LEGAL.md) for data handling, automated-access terms, and rights concerns.

## Support and security

For public bugs, feature work, and data corrections, use the repository issue forms. For security, rights, or sensitive account concerns, use the contact paths in [SECURITY.md](./SECURITY.md) and [SUPPORT.md](./SUPPORT.md).

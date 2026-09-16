# BBTSL Blade Ball Value List

BBTSL is the public Blade Ball value list site and its matching Cloudflare Worker backend.

## What This Repo Contains

- Public site assets in `public/`
- Worker code in `src/worker.js`
- Small auth/admin helper scripts in `scripts/`
- Cloudflare project config in `wrangler.jsonc`

This repository tracks the live application itself. The old migration workspace is intentionally gone.

## Stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- Node.js
- Wrangler `^4.26.0`

## Dependencies

Project dependencies are defined in [package.json](./package.json) and locked in [package-lock.json](./package-lock.json).

Current package use:

- `wrangler` for local development, deployment, and Cloudflare integration

## Local Development

Requirements:

- Node.js 20 or newer
- npm
- A Cloudflare account with access to the configured Worker, D1 database, and R2 bucket

Install packages:

```powershell
npm install
```

Start the local worker:

```powershell
npm run cf:dev
```

Deploy:

```powershell
npm run cf:deploy
```

## Environment And Secrets

Example local config lives in [.env.example](./.env.example).

Do not commit real secrets. In particular, keep these out of Git:

- owner API keys
- admin session secrets
- `.env`
- `.dev.vars`
- any production credential, token, cookie seed, or private endpoint config

Use Cloudflare secrets for sensitive runtime values instead of placing them in tracked files.

## Helper Scripts

- `npm run auth:hash-password`
- `npm run auth:totp-secret`
- `npm run auth:session-secret`

These scripts are for operator setup and admin auth maintenance only.

## Public Links

- Repository: [BBTS-Value-List/bladeball-value-list](https://github.com/BBTS-Value-List/bladeball-value-list)
- Live site: [bbtsl.lol](https://bbtsl.lol)
- GitHub Pages mirror: [bbts-value-list.github.io/bladeball-value-list](https://bbts-value-list.github.io/bladeball-value-list/)
- Blade Ball experience: [Roblox](https://www.roblox.com/games/13772394625/Blade-Ball)

## Legal

BBTSL is an unofficial fan project. It is not affiliated with Roblox, Blade Ball, their owners, or their copyright holders.

See [LEGAL.md](./LEGAL.md) for project notices, contact details, and takedown handling.

## Security

If you find a vulnerability, do not open a public issue. Use the reporting guidance in [SECURITY.md](./SECURITY.md).

## Contributing

Contribution expectations are in [CONTRIBUTING.md](./CONTRIBUTING.md).

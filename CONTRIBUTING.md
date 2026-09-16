# Contributing

## Before You Start

This project is small and intentionally opinionated. Keep changes tight, readable, and directly related to the live site or worker.

## Setup

Requirements:

- Node.js 20 or newer
- npm
- Cloudflare access if you need to run or deploy the Worker against real resources

Install dependencies:

```powershell
npm install
```

Run locally:

```powershell
npm run cf:dev
```

## Change Rules

- Do not commit real secrets, `.env`, `.dev.vars`, or any private credential
- Do not reintroduce one-time migration files or obsolete setup payloads
- Keep public UI changes consistent with the existing visual language
- Keep worker changes defensive and explicit
- Do not add third-party packages without a clear need

## Data And Content Changes

If you are changing sword entries, descriptions, values, or images:

- state exactly what changed
- explain the source of the correction
- mention whether the change affects public display, admin editing, or both

## Pull Requests

Every pull request should include:

- what changed
- why it changed
- how it was checked locally
- screenshots for visible UI changes when relevant

## Security

If your change touches auth, upload handling, or request security, review [SECURITY.md](./SECURITY.md) before opening the pull request.

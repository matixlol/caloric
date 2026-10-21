# Cloudflare port

Rewrite of `backend/` (Bun + Hono + Postgres on Railway) as an Effect-native
Cloudflare Worker deployed with Alchemy v2. `backend/` keeps serving production
until cutover; nothing here changes it.

## Constraints

- The iOS app is the main client. Paths, status codes, JSON shapes, SSE frames
  and auth cookies must stay wire-compatible with `backend/`.
- Better Auth stays (session cookies must keep working after the data move).
- Cheap: Workers Paid ($5/mo) and its included usage.

## Architecture

| Concern | backend/ | worker/ |
| --- | --- | --- |
| HTTP | Hono | `effect/http-api` (`HttpApi` spec + handlers); raw `HttpRouter` routes for Better Auth, SSE and static files |
| Config | `Bun.env` | `effect/Config`, bound onto the Worker by Alchemy |
| Database | Postgres via postgres-js | D1 via `alchemy/Drizzle` (drizzle-orm 1.0 RC, sqlite-core) |
| Migrations | drizzle-kit pg, applied at boot | drizzle-kit sqlite, applied by Alchemy on deploy |
| Auth | Better Auth + drizzle adapter | `@alchemy.run/better-auth` on D1 (Better Auth 1.7); it owns and migrates the auth tables at deploy |
| AI turns | in-memory maps, single instance | one Durable Object per AI session (turn state, replay, deadline alarm) |
| MFP login browser | rebrowser-playwright in-process | Cloudflare Container (Chromium + proxy + 2captcha), sleeps when idle |
| Voice notes | ffmpeg subprocess | ffmpeg in the same container (later: record WAV on device) |
| Static web | `Bun.file` | Worker static assets |
| Errors/telemetry | `@sentry/bun`, `@hono/otel` | typed errors; Workers Observability; Sentry via `@sentry/cloudflare` |

## Stages

- `dev_<user>` (default for `alchemy deploy`): workers.dev only.
- `prod`: gets `backend.caloric.mati.lol` at cutover.

## Phases

1. Scaffold: stack, Worker, D1 schema + migrations, health, auth, sync. Deploy to dev.
2. Social, search (MFP/OFF/ANMAT, barcode), MFP session storage.
3. AI: session/turn/stream on a Durable Object, OpenRouter, photos.
4. Container: MFP login + ffmpeg.
5. Web assets, Sentry, logging.
6. Data migration Postgres -> D1 (users, sessions, diary, social, caches as needed),
   ANMAT data sizing (R2 if large), contract tests against both backends.
7. Cutover: custom domain, iOS smoke test, retire Railway.

## Status

- Phase 1 done: `dev` stage deployed (`bun alchemy deploy --profile caloric --stage dev`).
  Health, Better Auth (`/api/auth/*`), `/sync/bootstrap` and `/sync/push` verified with curl.

## Notes

- HttpApi handlers and middleware can't declare Alchemy's per-request
  `RuntimeContext`; D1 code provides `RuntimeContext.phantom` (type-only) and the
  Worker supplies the real context per request (`withRuntime` in `src/db/Db.ts`).
- Auth cookies must stay `__Secure-better-auth.session_token` (`useSecureCookies`)
  and prod must reuse Railway's `BETTER_AUTH_SECRET`, or every iOS user is signed out.
- Auth tables use Better Auth's default camelCase columns; the Postgres import has
  to map backend/'s snake_case columns onto them.
- Validation failures return 400 with an empty body (backend/ sent `{"error": "..."}`).

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

Everything in backend/ is ported and deployed to the `dev` stage
(`bun run deploy:dev`, https://caloric-api-dev-gc2bvpxw6mrtqmaq.mati-8c1.workers.dev):
health, auth, sync, social, search/barcode/ANMAT, MFP session + container login,
AI assistant (Durable Object turns, voice via the container), and the web app.

Rehearsed against a local copy of backend/ (Postgres in OrbStack, preview seed):
`scripts/import-postgres.ts` copied it into dev D1, and a session cookie issued
by backend/ authenticated against the Worker. `scripts/contract-check.ts`
matched every read-only endpoint. Not exercised for real yet (no credentials on
dev): an OpenRouter model call and a MyFitnessPal browser login.

## Running it

- `bun run test`, `bun run typecheck` in worker/.
- `bun run deploy:dev` builds the web app and deploys the `dev` stage.
- Container images build with the local Docker CLI (OrbStack); put
  `~/.local/bin` on PATH (docker and buildx are linked there).
- Logs: `ALCHEMY_STAGE=dev bun alchemy logs --profile caloric --since 10m`.

## Cutover runbook (prod)

Needs: Railway's Postgres reachable again; the Railway env values
(BETTER_AUTH_SECRET, OPENROUTER_API_KEY, RESEND_API_KEY, MFP_USERNAME,
MFP_PASSWORD, MFP_GUEST_ACCESS_TOKEN, MFP_PROXY_URL, TWO_CAPTCHA_API_KEY, plus any
AI_MODEL/AI_REASONING_EFFORT/OPEN_FOOD_FACTS_*/AUTH_TRUSTED_ORIGINS overrides) and
its public DATABASE_URL; and the Cloudflare token extended with
Zone → Workers Routes: Edit and DNS: Edit on mati.lol.

1. Write the env values to `worker/.env.prod` (gitignored).
2. `bun run deploy:prod:staged` — prod on workers.dev only; the domain can't
   attach while the Railway CNAME exists.
3. `DATABASE_URL=<railway> bun run import:postgres --stage prod --with-caches`.
4. `bun scripts/contract-check.ts --old https://backend.caloric.mati.lol --new <prod workers.dev url> --cookie '<a real session cookie>'`
   must report all responses matching.
5. Delete the `backend` CNAME (-> xgdpng89.up.railway.app) in the mati.lol zone,
   then `bun run deploy:prod` (attaches backend.caloric.mati.lol).
6. Re-run step 3 to pick up writes that reached Railway during the switch
   (diary rows are last-writer-wins, so this is safe).
7. Smoke test the iOS app: still signed in, diary syncs, search, assistant, voice.
8. Keep Railway running a few days. Rollback: remove the Worker's custom domain
   and recreate the CNAME.

## Notes

- HttpApi handlers and middleware can't declare Alchemy's per-request
  `RuntimeContext`; D1 code provides `RuntimeContext.phantom` (type-only) and the
  Worker supplies the real context per request (`withRuntime` in `src/db/Db.ts`).
- Auth cookies must stay `__Secure-better-auth.session_token` (`useSecureCookies`)
  and prod must reuse Railway's `BETTER_AUTH_SECRET`, or every iOS user is signed out.
- Better Auth owns and migrates its tables (camelCase columns); the import maps
  backend/'s snake_case columns onto them.
- AI turn ids embed the session id (`ai_turn_<turn>_<session>`) so the stream
  route can reach the session's Durable Object.
- The container (standard-1, 4 GiB) serves both MFP logins and voice-note
  transcoding and sleeps after 10 idle minutes. Recording WAV on device would
  take voice notes off the container.
- Observability is Workers Logs (on by default); Sentry was not carried over.
- `/mfp/session/refresh` now requires a signed-in user.

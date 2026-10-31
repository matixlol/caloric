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

Production moved to the Worker on 2026-10-22 at 04:01 UTC: `backend.caloric.mati.lol`
is the `prod` stage's custom domain (the Railway CNAME is gone; it was
`backend CNAME xgdpng89.up.railway.app`, DNS only). Railway's Postgres was
unreachable from Oct 21 18:14 UTC until 03:55 UTC; it was dumped (backup in
`~/.config/caloric/backups/`), imported with caches, contract-checked against
backend/ running on the copy (all match, using a cookie signed with Railway's
secret), and smoke-tested live (search, an AI turn through OpenRouter). No writes
reached Railway between the dump and the switch.

Railway after cutover: the backend's deployment is removed (no auto-deploys:
its watch patterns match nothing) and Postgres is stopped; `postgres-volume`
(545 MB) is kept. The project token can't delete services, so deleting the
`backend` service is left for the dashboard. To read the old data again,
redeploy the Postgres service (`postgres-ssl:17`, config in
`~/.config/caloric/railway-postgres-config-before.json`).

Everything in backend/ is ported and deployed to the `dev` stage
(`bun run deploy:dev`, https://caloric-api-dev-gc2bvpxw6mrtqmaq.mati-8c1.workers.dev):
health, auth, sync, social, search/barcode/ANMAT, MFP session + container login,
AI assistant (Durable Object turns, voice via the container), and the web app.

Rehearsed against a local copy of backend/ (Postgres in OrbStack, preview seed):
`scripts/import-postgres.ts` copied it into dev D1, and a session cookie issued
by backend/ authenticated against the Worker. `scripts/contract-check.ts`
matched every read-only endpoint. AI turns were checked live on dev with a
temporary scripted model: streaming, disconnect + resume with a cursor, and
replay. Not exercised for real yet (no credentials on dev): an OpenRouter model
call and a MyFitnessPal browser login (the container itself runs on Cloudflare
and transcodes voice notes).

## Running it

- `bun run test`, `bun run typecheck` in worker/.
- `bun run deploy:dev` builds the web app and deploys the `dev` stage.
- Container images build with the local Docker CLI (OrbStack); put
  `~/.local/bin` on PATH (docker and buildx are linked there).
- Logs: `ALCHEMY_STAGE=dev bun alchemy logs --profile caloric --since 10m`.

## Cutover runbook (prod)

Needs: a copy of Railway's Postgres, `worker/.env.prod`, and the Cloudflare
token (DNS: Edit on mati.lol is enough; custom domains don't need Workers Routes).

1. `worker/.env.prod` (gitignored) holds the Railway backend's values. Don't keep
   a plain `worker/.env`: Alchemy reads it for every stage. Dev config is
   `.env.dev`. After Railway's Oct 21 environment-variable leak,
   `BETTER_AUTH_SECRET` is new and Railway's is `BETTER_AUTH_PREVIOUS_SECRET`;
   set `BETTER_AUTH_PREVIOUS_SECRET_UNTIL` to cutover + 8 days (see Notes;
   removed again on 2026-10-31).
2. Deploy prod without `CUSTOM_DOMAIN` (workers.dev only; the domain can't
   attach while the Railway CNAME exists). The `deploy:prod:staged` script was
   removed after cutover: deploying prod without the domain now detaches it.
3. `DATABASE_URL=<railway> bun run import:postgres --stage prod --with-caches`.
4. `bun scripts/contract-check.ts --old https://backend.caloric.mati.lol --new <prod workers.dev url> --cookie '<a real session cookie>'`
   must report all responses matching.
5. Delete the `backend` CNAME (-> xgdpng89.up.railway.app) in the mati.lol zone,
   then `bun run deploy:prod` (attaches backend.caloric.mati.lol). The hostname
   is two levels deep, so Universal SSL doesn't cover it; the custom domain's
   own certificate took about two minutes, during which TLS handshakes fail.
6. Re-run step 3 to pick up writes that reached Railway during the switch
   (diary rows are last-writer-wins, so this is safe).
7. Smoke test the iOS app: still signed in, diary syncs, search, assistant, voice.
8. Keep Railway running a few days. Rollback: remove the Worker's custom domain
   and recreate the CNAME. (Done: Railway is now stopped, see Status.)

## Notes

- HttpApi handlers and middleware can't declare Alchemy's per-request
  `RuntimeContext`; D1 code provides `RuntimeContext.phantom` (type-only) and the
  Worker supplies the real context per request (`withRuntime` in `src/db/Db.ts`).
- Auth cookies must stay `__Secure-better-auth.session_token` (`useSecureCookies`).
  Cookies signed with Railway's secret are re-signed with the new one until
  `BETTER_AUTH_PREVIOUS_SECRET_UNTIL` (`src/auth/LegacySessionCookie.ts`); the
  iOS app picks the new cookie up from get-session on launch/resume. Sessions
  last 7 days from last use, so after the window anyone left is signed out
  anyway. Both `PREVIOUS` values were removed on 2026-10-31, so the code is now
  a no-op. Alchemy planned their removal as "no changes" (env-only edits aren't
  always diffed), so they were deleted with Cloudflare's Worker secrets API.
- Better Auth owns and migrates its tables (camelCase columns); the import maps
  backend/'s snake_case columns onto them.
- AI turn ids embed the session id (`ai_turn_<turn>_<session>`) so the stream
  route can reach the session's Durable Object.
- The container (standard-1, 4 GiB) serves both MFP logins and voice-note
  transcoding and sleeps after 10 idle minutes. Recording WAV on device would
  take voice notes off the container.
- Every D1 query is a round trip to the database's primary in Miami: ~145ms
  from Buenos Aires (EZE), where our users' requests arrive. Placement can't
  remove that. Smart Placement only picks locations the Worker already runs
  in (all EZE); cloud regions land in Atlanta at best (~22ms per query); and
  even a Durable Object in Miami pays ~10ms per D1 query (measured Oct 23).
  So the Worker runs at the edge and every request makes at most one D1 round
  trip:
  - Independent reads run concurrently (`Effect.all`).
  - Writes and the reads that show their result go as one D1 batch
    (`DbBatch` in `src/db/Db.ts`; also atomic). `sync/push` is one batch;
    social reads friend lists through subqueries instead of a first query.
  - Better Auth joins session and user (`advanced.database.joins`), and the
    user a session cookie resolves to is cached per data center for 5 minutes
    (`src/auth/SessionCache.ts`); POSTs to `/api/auth/*` (sign-out) drop it.
  - Provider cache writes (search, barcode) run after the response
    (`Background`, `ctx.waitUntil`), and a cached MFP search reads its details
    in the same round trip.
  Measured on prod from EZE on Oct 23 (medians, before -> after; before was
  pinned to Atlanta): /health 189 -> 22ms, get-session 239 -> 176ms,
  sync/bootstrap 278 -> 183ms, sync/push 300 -> 206ms, social/me 270 ->
  170ms, social/daily-summaries 260 -> 172ms, cached search 499 -> 222ms.
  New handlers should keep to one round trip: a `yield*` on a query that
  depends on another query's result costs ~145ms.
- Better Auth's runtime schema check is off (`validateSchema: false`). It is
  memoized per database client, but Alchemy builds one per request, so it
  introspected every table (a D1 round trip per PRAGMA) on every auth call:
  ~500ms on /api/auth/* and every authenticated route.
- Observability is Workers Logs (on by default); Sentry was not carried over.
- `/mfp/session/refresh` now requires a signed-in user.

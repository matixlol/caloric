# backend

Bun microservice that proxies food search APIs, merges local ANMAT data with MyFitnessPal and OpenFoodFacts results, and persists upstream responses to Postgres via Drizzle.

## Endpoints

- `GET /health`
- `GET /search`
  - query params:
    - `query` (required)
    - `offset` (default `0`)
    - `maxItems` (default `100`, max `1000`)
    - `countryCode` (default `US`)
    - `resourceType` (default `foods`)
    - `includeDetails` (default `true`)
- `POST /ai/session`
  - requires a Better Auth session (cookie or bearer)
  - body:
    - `recentLogs` (optional)
  - returns:
    - `sessionId`
    - `status` (`ready`)
- `POST /ai/turn`
  - requires a Better Auth session (cookie or bearer)
  - body (`application/json`):
    - `sessionId` (required)
    - `action` (required)
      - user message:
        - `type: "user-message"`
        - `message`
      - approval decision:
        - `type: "approval"`
        - `toolCallId`
        - `suggestionId`
        - `approved`
  - body (`multipart/form-data`, for voice):
    - `sessionId` (required)
    - `actionType` (required, set to `user-message`)
    - `audio` (required for voice-only requests)
    - `message` (optional companion text)
  - returns `text/event-stream` SSE chunks:
    - `type: "status"` with `status` (`ready` or `awaiting-approval`)
    - `type: "event"` with `event` (`assistant-delta`, `assistant`, `search`, `approval`)
    - `type: "resolved-user-message"` when a typed companion message was sent
- `GET /sync/bootstrap`
  - requires a Better Auth session (cookie or bearer)
  - returns synced food entries plus user settings
- `POST /sync/push`
  - requires a Better Auth session (cookie or bearer)
  - accepts dirty food entry upserts and settings upserts
- `POST /mfp/session/refresh`
  - forces a Playwright login refresh and updates the stored MyFitnessPal session in Postgres
  - returns whether auth headers were refreshed successfully
- `GET|POST /api/auth/*`
  - Better Auth: email-code (OTP) and email+password sign-in/sign-up, session, sign-out

## Auth (Better Auth)

Auth is handled by [Better Auth](https://www.better-auth.com/) with the Drizzle/Postgres adapter.
Both email-code (OTP) login and email+password login are enabled. The mobile app uses the
`@better-auth/expo` client and sends the session cookie on backend requests.

Login codes are delivered via Resend when `RESEND_API_KEY` is set; otherwise they are written to
the server logs (password login does not depend on email delivery, which is what App Store review
uses). See `migrate-clerk-users.local.ts` for the one-time script that recreates the pre-existing
users as Better Auth accounts while preserving their user ids (so all their synced data keeps
resolving with no rewrite).

`/ai/turn` runs the AI loop server-side and pauses only when user approval is needed. User approvals are submitted by the client and then the backend resumes the loop.
OpenRouter tracking fields are sent as `user` (client user id) and `session_id` (backend session id).

`/search` does this:
1. Looks up fresh cached upstream responses for the exact request tuple and reuses them for up to 30 days by default
2. Reuses the latest MyFitnessPal auth session from `mfp_auth_sessions`, or refreshes it with Rebrowser Playwright when missing/expired
3. If not cached, calls MyFitnessPal `/api/nutrition` and saves the response in `mfp_search_responses`
4. Retries once after an automatic auth refresh when MyFitnessPal responds with `401` or `403`
5. If `includeDetails=true`, resolves each food detail by:
   - reusing a fresh cached detail for (`foodId`, `version`) when available
   - fetching upstream only for detail keys not already cached
6. Saves resolved detail payloads in `mfp_food_detail_responses` for the current `searchResponseId`
7. Calls OpenFoodFacts full-text search from the backend only, caches those responses in `open_food_facts_search_responses`, and merges OFF rows into the returned foods list

The refresh path launches the verified Rebrowser Playwright + 2Captcha login harness, captures the resulting cookie-backed session, stores it in `mfp_auth_sessions`, and closes the browser immediately after persistence.

## Environment

Copy `.env.example` to `.env` and set:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET` (sign/verify sessions; generate with `openssl rand -base64 32`)
- `MFP_USERNAME`
- `MFP_PASSWORD`
- `TWO_CAPTCHA_API_KEY` (used to solve Cloudflare Turnstile during MyFitnessPal login)
- `OPENROUTER_API_KEY`

Optional:

- `PORT`
- `SEARCH_CACHE_TTL_DAYS`
- `MFP_PROXY_URL`
- `MFP_BROWSER_HEADLESS`
- `MFP_DETAIL_CONCURRENCY`
- `MFP_REQUEST_TIMEOUT_MS`
- `OPEN_FOOD_FACTS_BASE_URL`
- `OPEN_FOOD_FACTS_USER_AGENT`
- `OPEN_FOOD_FACTS_USER_EMAIL`
- `OPENROUTER_MODEL`
- `OPENROUTER_PROVIDER_ONLY` (optional; for Gemini 3 Flash use `google-ai-studio` or `google-vertex`; leave unset to let OpenRouter choose sorted by throughput)
- `BETTER_AUTH_URL` (public backend URL; defaults to the production host)
- `AUTH_TRUSTED_ORIGINS` (comma-separated extra deep-link/web origins; app schemes are always trusted)
- `WEB_ORIGINS` (comma-separated browser origins allowed to call the API with credentials)
- `RESEND_API_KEY` and `AUTH_EMAIL_FROM` (email delivery for login codes; logs the code if unset)

## Run

```bash
cd backend
pnpm install
PLAYWRIGHT_BROWSERS_PATH=0 pnpm run mfp:install-browser
pnpm run db:push
pnpm run dev
```

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
  - body:
    - `userId` (required)
  - returns:
    - `sessionId`
    - `status` (`ready`)
- `POST /ai/turn`
  - body (`application/json`):
    - `sessionId` (required)
    - `userId` (required, must match session owner)
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
    - `userId` (required)
    - `actionType` (required, set to `user-message`)
    - `audio` (required for voice-only requests)
    - `message` (optional fallback text)
  - returns:
    - `status` (`ready` or `awaiting-approval`)
    - `events` (`assistant`, `search`, `approval`)
    - `resolvedUserMessage` (present for user-message actions)
- `POST /mfp/session/refresh`
  - forces a Playwright login refresh and updates the stored MyFitnessPal session in Postgres
  - returns whether auth headers were refreshed successfully

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
- `MFP_USERNAME`
- `MFP_PASSWORD`
- `TWO_CAPTCHA_API_KEY` (used to solve Cloudflare Turnstile during MyFitnessPal login)
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`

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
- `OPENROUTER_PROVIDER_ONLY`

## Run

```bash
cd backend
bun install
bunx playwright install chrome
bun run db:push
bun run dev
```

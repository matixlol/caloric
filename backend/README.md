# backend

Bun microservice that proxies MyFitnessPal search/detail APIs and persists every upstream response to Postgres via Drizzle.

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

`/ai/turn` runs the AI loop server-side and pauses only when user approval is needed. User approvals are submitted by the client and then the backend resumes the loop.
OpenRouter tracking fields are sent as `user` (client user id) and `session_id` (backend session id).

`/search` does this:
1. Looks up the latest cached search response for the exact request tuple (`query`, `offset`, `maxItems`, `countryCode`, `resourceType`)
2. If not cached, calls MyFitnessPal `/api/nutrition` and saves the response in `mfp_search_responses`
3. If `includeDetails=true`, resolves each food detail by:
   - reusing the latest cached detail for (`foodId`, `version`) when available
   - fetching upstream only for detail keys not already cached
4. Saves resolved detail payloads in `mfp_food_detail_responses` for the current `searchResponseId`

## Environment

Copy `.env.example` to `.env` and set:

- `DATABASE_URL`
- `MFP_AUTHORIZATION`
- `OPENROUTER_API_KEY`
- `FAL_KEY`

Optional:

- `MFP_COOKIE`
- `PORT`
- `MFP_BASE_URL`
- `MFP_DETAIL_CONCURRENCY`
- `MFP_REQUEST_TIMEOUT_MS`
- `OPENROUTER_MODEL`
- `OPENROUTER_PROVIDER_ONLY`

## Run

```bash
cd backend
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

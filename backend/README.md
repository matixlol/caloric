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

Optional:

- `MFP_COOKIE`
- `PORT`
- `MFP_BASE_URL`
- `MFP_DETAIL_CONCURRENCY`
- `MFP_REQUEST_TIMEOUT_MS`

## Run

```bash
cd backend
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

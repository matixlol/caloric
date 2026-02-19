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
1. Calls MyFitnessPal `/api/nutrition`
2. Saves the full search response in `mfp_search_responses`
3. If `includeDetails=true`, fetches each item detail from `/api/services/foods/{id}?version={version}` (parallelized)
4. Saves each detail response in `mfp_food_detail_responses`

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

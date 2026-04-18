# Caloric

A basic app for calorie/macros tracking that aims to get out of your way as soon as possible.

## Stack
This project uses Clerk for auth, `@op-engineering/op-sqlite` for local-first mobile persistence, and the Bun backend + Postgres for sync/storage.

## Repo Layout

- `mobile/`: Expo app
- `backend/`: Bun runtime service with `pnpm` for package management

### Local env

Create `mobile/.env.local` with:

```bash
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your-clerk-publishable-key
EXPO_PUBLIC_BACKEND_URL=https://backend.caloric.mati.lol
```

You can create a publishable key in the [Clerk Dashboard](https://dashboard.clerk.com/).
`EXPO_PUBLIC_BACKEND_URL` is optional and defaults to `https://backend.caloric.mati.lol` in the app.

## Backend Service

This repo also includes a Bun backend in `backend/` that proxies MyFitnessPal and OpenFoodFacts search, merges those with local ANMAT results, and stores upstream responses in Postgres using Drizzle migrations.

To run the mobile app:

```bash
cd mobile
pnpm install
pnpm start
```

Quick start:

```bash
cd backend
pnpm install
cp .env.example .env
pnpm run db:generate
pnpm run db:migrate
pnpm run dev
```

## Deployed Backend API

Base URL: `https://backend.caloric.mati.lol`

- Health check: `GET https://backend.caloric.mati.lol/health`
- Search only: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=3&includeDetails=false`
- Search + detail payloads: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=1&includeDetails=true`
- Start AI session: `POST https://backend.caloric.mati.lol/ai/session` with `{ "recentLogs": [...] }` and a Clerk bearer token
- Run AI turn: `POST https://backend.caloric.mati.lol/ai/turn` with `{ "sessionId": "...", "action": { ... } }` and a Clerk bearer token

Note: there is no separate public detail endpoint right now; detail records are returned in the `details` array on `/search` when `includeDetails=true`.

## MyFitnessPal Full Export (uv/uvx)

Use `scripts/export_myfitnesspal.py` to export account metadata, diary days, measurements,
recipes, and saved meals.

Run with `uv` (recommended):

```bash
uv run scripts/export_myfitnesspal.py --start-date 2015-01-01 --end-date 2026-12-31
```

Run with `uvx`:

```bash
uvx --with myfitnesspal --with browser-cookie3 python scripts/export_myfitnesspal.py --start-date 2015-01-01
```

Output defaults to `exports/myfitnesspal/` and includes:

- `account.json`
- `days.jsonl`
- `measurements.json`
- `recipes.json`
- `saved_meals.json`
- `summary.json`
- `failures.json` (only if some dates fail)

Cookie/auth notes:

- This library uses existing browser cookies, not username/password login.
- Default is `--browser auto`, which works if you're already logged into MyFitnessPal in a supported browser.
- For custom Chromium-based browsers (for example Helium), pass the cookie DB file explicitly:

```bash
uv run scripts/export_myfitnesspal.py \
  --cookie-file "/path/to/Helium/Cookies" \
  --cookie-domain myfitnesspal.com
```

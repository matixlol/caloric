# Caloric

A basic app for calorie/macros tracking that aims to get out of your way as soon as possible.

## Stack
This project now uses Clerk for user login and `JazzExpoProviderWithClerk` for Jazz account auth.

### Local env

Create `.env.local` with:

```bash
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your-clerk-publishable-key
EXPO_PUBLIC_JAZZ_API_KEY=your-jazz-api-key
EXPO_PUBLIC_BACKEND_URL=https://backend.caloric.mati.lol
```

You can create a publishable key in the [Clerk Dashboard](https://dashboard.clerk.com/).
`EXPO_PUBLIC_BACKEND_URL` is optional and defaults to `https://backend.caloric.mati.lol` in the app.

## Backend Service

This repo also includes a Bun backend in `backend/` that proxies MyFitnessPal search/detail APIs and stores all upstream responses in Postgres using Drizzle migrations.

Quick start:

```bash
cd backend
bun install
cp .env.example .env
bun run db:generate
bun run db:migrate
bun run dev
```

## Deployed Backend API

Base URL: `https://backend.caloric.mati.lol`

- Health check: `GET https://backend.caloric.mati.lol/health`
- Search only: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=3&includeDetails=false`
- Search + detail payloads: `GET https://backend.caloric.mati.lol/search?query=banana&maxItems=1&includeDetails=true`
- Start AI session: `POST https://backend.caloric.mati.lol/ai/session` with `{ "userId": "..." }`
- Run AI turn: `POST https://backend.caloric.mati.lol/ai/turn` with `{ "sessionId": "...", "userId": "...", "action": { ... } }`

Note: there is no separate public detail endpoint right now; detail records are returned in the `details` array on `/search` when `includeDetails=true`.

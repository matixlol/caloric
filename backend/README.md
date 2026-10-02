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

## Web journal

The React web client lives in `web/` and is built with Bun. The backend serves
the signed-in app at `/` and compiled assets at `/web/*`.
It shares the native food, recipe, settings and social schemas.
Normal backend `dev` and `start` commands build the web client first; after editing
the client, run `pnpm --dir backend web:build` to refresh the bundle.

### Production web domain

The backend supports serving the web app at `https://caloric.mati.lol` while
keeping `https://backend.caloric.mati.lol` for native/API clients. To activate it:

1. Add `caloric.mati.lol` as a custom domain on the **existing backend Railway
   service**, using the same target port. Keep the backend domain attached.
2. Remove the old Cloudflare passkey worker's custom-domain binding for
   `caloric.mati.lol`, and configure the CNAME and verification TXT records
   supplied by Railway. The backend preserves the existing Apple association
   response at `/.well-known/apple-app-site-association`.
3. Once Railway verifies the domain and provisions HTTPS, check `/`, `/health`,
   the association endpoint, and login on the new hostname.

Keep `BETTER_AUTH_URL=https://backend.caloric.mati.lol`. The new HTTPS web origin
is explicitly trusted by auth; no extra `WEB_ORIGINS` setting is needed because
the bundled client uses same-origin API requests. Cookies remain host-only, so
users sign in again on the new hostname. The backend hostname still serves the
web app too; it is not redirected, keeping existing API requests unchanged.

Base UI provides swipe-dismissable, focus-managed bottom sheets and segmented
controls, styled to match Expo. dnd-kit provides whole-row touch sorting with the
native 170 ms hold, cross-meal drops (including empty meals), auto-scroll and
keyboard sorting (Space to lift/drop, arrows to move, Escape to cancel). A quick
swipe still scrolls; tapping edits. Drops save through `/sync/push`; failed writes
restore the saved order. There are no move buttons or reorder success toasts.

The food and recipe Add button also matches the native gesture: hold 260 ms,
slide upward to select ¼–3 servings, and release to add. Whole servings have
larger targets; releasing below the dead zone cancels. A normal tap still adds
the entered serving quantity. Motion animates measured drawer heights as content
changes, without scaling text; reduced-motion preferences disable resizing motion.
Sheets slide in with a fading backdrop. Adding food, including through the
assistant or Duplicate, reveals the saved row when the sheet closes instead of
showing an added/duplicated success toast. Errors and delete/undo notices remain.

From the repository root, launch a real backend preview with an isolated loopback
PostgreSQL database and an Amp portal in one command:

```bash
env -u DATABASE_URL backend/web-preview.sh
```

Sign in with `preview@caloric.local` / `CaloricPreview123!`. This uses the same
Better Auth, sync, social, food-search and AI paths as the deployed backend; there
is no demo or scripted fallback. Local state is preserved between launches. Set
`WEB_PREVIEW_RESET=1` for an explicit reset. The script automatically uses the
Amp portal URL for auth and trusted origins; an origin argument or
`WEB_PREVIEW_ORIGIN` overrides it. Optional live provider credentials already in
the environment enable their corresponding AI and search behavior:
`GOOGLE_AI_STUDIO_API_KEY` for AI, and the existing MFP credentials for MyFitnessPal.
Open Food Facts uses its real upstream service. Email codes are logged locally;
the preview disables outgoing email and production telemetry.

The web preview is not an offline-sync replacement for the native app. Camera
barcode scanning, push notifications, native haptics and native voice behavior
are unavailable. Home-screen standalone display is declared in the manifest;
browser/device support varies, and there is no offline service worker.

Checks (no production services required):

```bash
pnpm --dir backend web:test
pnpm --dir backend web:check
# Start web:preview first, then set CALORIC_WEB_URL to its printed portal URL.
pnpm --dir backend exec playwright install chromium webkit
pnpm --dir backend web:e2e
CALORIC_BROWSER=webkit pnpm --dir backend web:e2e
```

`CHROMIUM_PATH` can select an installed Chromium executable. `CALORIC_WEB_URL`
selects the isolated preview; do not target production. Tests verify the seeded
account is present, then create a disposable test account for writes so your
preview edits stay intact. They exercise real authentication and database
persistence, touch scrolling/long-press sorting in Chromium, mouse sorting in
WebKit, keyboard sorting, auto-scroll, empty-meal drops, cancellation and failed
reorder rollback, swipe sheet dismissal, failed form writes, hold-and-slide
portions, and frame-sampled drawer resizing.
Set `CALORIC_SCREENSHOTS` to a directory to capture phone-sized sheets, drag,
editor and dark-mode states plus a short drawer-resize recording.
Browser emulation is not real-device verification.

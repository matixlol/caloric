# AGENTS.md

## Database Workflow
- Do not generate SQL migration files for backend schema changes.
- Prefer pushing schema changes directly to the target database with `bun run db:push`.
- For local backend work, create/use a local Postgres database, set `DATABASE_URL`, and push the schema before running data imports.

## Expo Native Sync Rule
- Treat `ios/` and `android/` as generated output from Expo config/plugins.
- Before manually patching generated native files, first resync with prebuild:
  - iOS: `npx expo prebuild --platform ios --clean`
  - Android: `npx expo prebuild --platform android --clean`
- If `npx expo run:ios` fails after SDK/dependency changes, run iOS prebuild clean first, then retry.
- If Metro fails with `Cannot find module 'babel-preset-expo'`, run:
  - `npx expo install babel-preset-expo`

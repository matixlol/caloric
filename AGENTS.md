# AGENTS.md

## Database Workflow
- Generate SQL migration files for backend schema changes with `bun run db:generate`.
- Apply pending migrations with `bun run db:migrate`.
- For local backend work, create/use a local Postgres database, set `DATABASE_URL`, and run migrations before running data imports.

## Expo Native Sync Rule
- Treat `ios/` and `android/` as generated output from Expo config/plugins.
- Before manually patching generated native files, first resync with prebuild:
  - iOS: `npx expo prebuild --platform ios --clean`
  - Android: `npx expo prebuild --platform android --clean`
- If `npx expo run:ios` fails after SDK/dependency changes, run iOS prebuild clean first, then retry.
- If Metro fails with `Cannot find module 'babel-preset-expo'`, run:
  - `npx expo install babel-preset-expo`

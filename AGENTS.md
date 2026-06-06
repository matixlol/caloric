# AGENTS.md

## Database Workflow
- Generate SQL migration files for backend schema changes with `bun run db:generate`.
- Apply pending migrations with `bun run db:migrate`.
- For local backend work, create/use a local Postgres database, set `DATABASE_URL`, and run migrations before running data imports.

## Expo Native Sync Rule
- Treat `ios/` and `android/` as generated output from Expo config/plugins.
- resync with prebuild:
  - iOS: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo prebuild --platform ios --clean`
  - Android: `npx expo prebuild --platform android --clean`
- If CocoaPods/prebuild fails with `Unicode Normalization not appropriate for ASCII-8BIT`, rerun with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` set.
- If `npx expo run:ios` fails after SDK/dependency changes, run iOS prebuild clean first, then retry.

## Expo Dev Server
- Run the Expo dev server in tmux so it stays up after the agent turn ends:
  - `cd mobile && tmux new-session -d -s caloric-expo-dev 'APP_VARIANT=development EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host lan --port 8081'`
- Check logs with `tmux capture-pane -pt caloric-expo-dev` and stop it with `tmux kill-session -t caloric-expo-dev`.

## iOS Release / OTA Notes
- If a change touches native iOS code, Expo config plugins, entitlements, Info.plist, or anything generated into `ios/`, do a full iOS build for TestFlight/App Store. OTA is not enough for those changes.
- Only use OTA for JS-only changes, and do not assume OTA is configured just because `mobile/eas.json` has a production channel. This app currently does **not** have `expo-updates` installed, so channel-based OTA will warn until that package/config is added.
- For agent-driven shipping, prefer `npx eas-cli ...` instead of assuming a global `eas` binary exists.
- `mobile/eas.json` should keep the iOS submit config (`submit.production.ios.ascAppId`) so `eas submit` can run non-interactively.
- `eas build --auto-submit --what-to-test ...` can fail because changelog / What to Test submission is Enterprise-only on some plans. If that happens, run the build first, then submit separately without `--what-to-test`:
  - `cd mobile && npx eas-cli build --platform ios --profile production --wait --non-interactive`
  - `cd mobile && npx eas-cli submit --platform ios --latest --wait --non-interactive`

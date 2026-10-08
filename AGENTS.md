# AGENTS.md

## Canonical Repository and Swift Port
- The actual source repository is `https://github.com/matixlol/caloric.git`; `poasterbot/caloric` is a development fork.
- Run `python3 native-swift/scripts/setup-repository.py` after cloning, and fetch/pull canonical `origin/main` before comparing or porting features. Preserve local work; do not reset or clean the Swift app.
- Keep the standalone app in `native-swift/`. Compare all current `mobile/app` screens and data contracts, and update `native-swift/FEATURE_PARITY.md` when features change.
- Production authentication uses Better Auth. Do not restore Clerk SDKs or require Clerk credentials for the Swift app.
- Regenerate the Swift Xcode project with `ruby native-swift/scripts/generate-project.rb` after adding files; run appropriate native tests and ship native changes through a full TestFlight build.

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

## Driving the iOS Simulator (verify UI changes)
- To tap/swipe/screenshot the booted simulator yourself, `idb` + `idb_companion` are installed.
- Find the device + coordinate space: `idb describe --udid <udid>` → `screen_dimensions` gives `width_points`/`height_points` (e.g. iPhone 17 Pro = 402×874, density 3). **`idb ui tap` uses POINTS = device_pixels / 3** (screenshots are in pixels).

## iOS Release / OTA Notes
- If a change touches native iOS code, Expo config plugins, entitlements, Info.plist, or anything generated into `ios/`, do a full iOS build for TestFlight/App Store. OTA is not enough for those changes.
- `eas build --auto-submit --what-to-test ...` can fail because changelog / What to Test submission is Enterprise-only on some plans. If that happens, run the build first, then submit separately without `--what-to-test`:
  - `cd mobile && npx eas-cli build --platform ios --profile production --wait --non-interactive`
  - `cd mobile && npx eas-cli submit --platform ios --latest --wait --non-interactive`

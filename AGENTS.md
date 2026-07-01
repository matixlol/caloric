# AGENTS.md

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

# AGENTS.md

## Expo Native Sync Rule
- Treat `ios/` and `android/` as generated output from Expo config/plugins.
- Before manually patching generated native files, first resync with prebuild:
  - iOS: `npx expo prebuild --platform ios --clean`
  - Android: `npx expo prebuild --platform android --clean`
- If `npx expo run:ios` fails after SDK/dependency changes, run iOS prebuild clean first, then retry.
- If Metro fails with `Cannot find module 'babel-preset-expo'`, run:
  - `npx expo install babel-preset-expo`

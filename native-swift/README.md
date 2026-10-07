# Caloric Swift

Standalone SwiftUI port of the current `mobile/` app in `matixlol/caloric` (`ded9c48`). The Expo app stays separate. Bundle ID: `lol.mati.caloric.swift`; display name: **Caloric Swift**; Apple team: `BQ7842UUHJ`; App Store Connect app: `6820093147`. Requires iOS 17+ and Xcode 26.6 for development.

## Features and verification

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the source comparison and current verification status. The port includes the diary, animated food dragging and quarter portions; MFP/OFF search with pagination and recents; quick add and hold/slide pickers; barcode scanning; reusable recipes and logged ingredient snapshots; friends and read only friend diaries; the floating food assistant, streaming responses, approvals and animated voice recording; settings, offline sync, daily iCloud backups and nutrition widgets.

On iOS 26, the floating chat composer, microphone, conversation panel and recording controls use Apple's native Liquid Glass. Primary actions and sheet controls use native glass button styles; Settings uses a system navigation toolbar, and food sources use a segmented picker. iOS 17–25 use system material and native bordered button styles. Recording and composer control transitions respect Reduce Motion.

Authentication uses the backend's **Better Auth** email-code/password endpoints. Signed session cookies stay in this app's Keychain and are sent only to the configured backend. Sessions renew on foreground or a rejected authenticated request. Clerk access and keys are unnecessary. Local SQLite databases are isolated by account; offline edits remain durable, and newer local edits are protected from stale downloads and acknowledgements. Recipes use the same backend sync contract as Expo.

## Actual repository

The canonical repository is `https://github.com/matixlol/caloric.git`. `origin` and `main` track that repository. `fork` points to `poasterbot/caloric` for pushes. Run the idempotent setup script after creating a checkout:

```sh
python3 native-swift/scripts/setup-repository.py
git pull
```

Pulls rebase local commits onto the actual `origin/main` and preserve tracked edits with Git autostash. If Git reports a conflict, resolve it; do not reset or clean the Swift app. Before a port/release, fetch the canonical main and compare all screens against `mobile/`.

## Build and test

```sh
cd native-swift
python3 scripts/configure.py
ruby scripts/generate-project.rb
xcodebuild -project CaloricSwift.xcodeproj -scheme CaloricSwift \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -parallel-testing-enabled NO test
```

`configure.py` writes ignored `Config/Local.xcconfig` using the public backend URL from `mobile/.env.local`. `CALORIC_BACKEND_URL` and `APPLE_TEAM_ID` override it. No mobile auth API key is needed. The checked-in project generator includes the app, widget extension, unit tests and UI tests. There are no external Swift packages.

Production integration tests are opt-in with `CALORIC_LIVE_AUTH_FILE` pointing to a private verification-account file, and `CALORIC_LIVE_SOCIAL_FILE` for a second isolated account. Mutating integration tests accept only temporary `caloric-swift-check-…@verification.invalid` accounts. Ordinary tests use isolated temporary databases and mock HTTP sessions. The feature verification passed all 54 tests (39 unit / mock HTTP, 4 production integration and 11 UI). The Liquid Glass update passed 51 regression tests (39 unit / mock HTTP and 12 UI), with the four opt-in production tests skipped for this UI-only change.

## TestFlight

[Manage Caloric Swift in TestFlight](https://appstoreconnect.apple.com/apps/6820093147/testflight/ios).

```sh
cd native-swift
BUILD_NUMBER=7 bash scripts/testflight.sh
```

Saved credentials stay outside the repository in `~/.config/caloric/` (directory `700`, files `600`): `apple.json` references the App Manager API key; `signing.json` references the local distribution Keychain and provisioning profiles; `railway.json` references the production project token. Never paste or commit these files. `CALORIC_APPLE_CREDENTIALS` and `CALORIC_SIGNING_CREDENTIALS` support alternate locations. `scripts/appstore-connect.mjs` signs short-lived API requests without printing the key or JWT.

The release script renews/reuses the app and widget distribution profiles through the API, installs them in Xcode, archives with the saved distribution identity, verifies both signed products, and uploads with the API key. It then waits for Apple processing, sets release notes and assigns **Caloric Swift Internal**. `CALORIC_RELEASE_NOTES` can point to a text file. To finish a previously uploaded build without uploading again, run `node scripts/finish-testflight.mjs 7`.

Build 5 fixed the 401 error caused by the outdated fork's login. Build 6 contains the complete feature port and the separately signed widget. Build 7 adds native Liquid Glass and iOS controls. Production Better Auth login, diary download, recipe create/update/delete, friends and interrupted AI streams have passed native integration tests.

The widget uses App Group `group.lol.mati.caloric.swift` and bundle ID `lol.mati.caloric.swift.CaloricWidget`. Daily backups use the separate `iCloud.lol.mati.caloric.swift` CloudDocuments container. Camera, microphone and iCloud behavior require verification on a device; simulator tests cover manual barcode entry and synthetic voice gestures. Native app updates ship through TestFlight.

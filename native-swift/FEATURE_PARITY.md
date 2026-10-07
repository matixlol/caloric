# Caloric Swift feature parity

Reference: `matixlol/caloric` main, `ded9c48` (2026-10-04). The standalone app is in `native-swift/`; Expo's generated native projects remain separate.

| Feature | Swift implementation and verification |
| --- | --- |
| Better Auth email code / password / sign up / secure session renewal | Implemented; auth regression tests and real production login / session renewal |
| Account isolated SQLite diary, settings, offline edits and conflict resolution | Implemented; download, retry, deletion, rejected writes and concurrent edits tested |
| Quarter portions, animated meal dragging, swipe deletion | Implemented; meal labels stay vertically centered beside each card in a wider gutter; UI tests cover portion scrubbing, meal moves, reordering, edge scrolling and deletion |
| Current Today screen, Settings sheet, floating AI conversation | Native friend diary card with pinned Done and swipe dismissal; no pull to refresh; Settings excludes the Updates section |
| Recents, MFP / OFF search, pagination, ANMAT background enrichment | Implemented; interleaving / duplicate handling tested; recipe selection uses the same search |
| Quick add calories and optional macros, hold and slide calorie / portion pickers | Implemented; taps open only the number form, deliberate holds open slide pickers; create / edit and picker gestures tested; each meal + supports hold/up for calories and hold/down for barcode scanning |
| Camera barcode scanning, manual entry and MFP lookup | Implemented; normalization and manual-entry UI tested; camera requires a device |
| Reusable recipes, ingredients, duplication, deletion and recipe sync | Implemented; UI flow, local persistence and production create / update / delete tested |
| Logged recipe snapshots and ingredient editing | Implemented; recipe copies remain independent of later edits / deletion |
| Calorie / macro mismatch badges and meal macro totals | Implemented; unknown nutrients and aggregate totals tested |
| Friends: profile, code, requests, removal, daily totals and read only diary | Implemented; two isolated production accounts tested request, ignore, accept, diary access and removal |
| Streaming AI, search results, approvals and interrupted turn resume | Implemented; real production stream / background interruption / resume tested; replay deduplicates events |
| Native Liquid Glass and iOS controls | Real iOS 26 glass composer, microphone, conversation and recording surfaces; native action buttons, sheet controls, Settings toolbar and segmented food-source picker; iOS 17–25 fallback |
| Animated voice recording, lock and cancel | Native touch-down control with audio activation off the UI thread; lock/cancel work while preparing; UI tests use synthetic audio; microphone / transcription requires a device |
| Home / lock screen nutrition widgets and midnight rollover | Implemented; snapshot totals / goal ratios tested; separate widget extension and App Group |
| Daily iCloud backups including recipes | Implemented; separate iCloud container; device iCloud verification remains |
| Dark mode, accessibility labels and reduced motion | Implemented; light / dark visual inspection; controls have accessible actions |
| TestFlight updates | Full signed native releases; API key / local signing identity stored outside Git |

## Verification

`FinalFeatureParity.xcresult`: **54 passed, 0 failed, 0 skipped** on iPhone 17 Pro / iOS 26.5 (2026-10-07): 39 unit / mock HTTP tests, 4 native production integration tests and 11 UI tests. UI screenshots are attached to the result bundle. The two temporary verification accounts and their diary, recipe, social and AI records were removed after testing. Real user data was not changed.

`LiquidGlassRegression.xcresult`: **51 passed, 0 failed, 4 skipped** on the same simulator (2026-10-07): 39 unit / mock HTTP tests and 12 UI tests. This run covers the new chat control transitions, conversation preservation, tap-through behavior and native Settings dismissal, plus voice lock/cancel, portion scrubbing, meal dragging, recipe and quick-add flows. The four opt-in production tests were not repeated for this UI-only update; their prior successful result is recorded above. Chat/recording screenshots are attached; light and dark appearance were reviewed.

Build 8 gesture refinements: **39 unit / mock HTTP tests and all 15 UI tests passed**, with 4 opt-in production tests skipped. `GestureRefinementsVerified.xcresult` covers the diary layout, friend-card scrolling / swipe dismissal, Quick add tap-only form, both hold pickers, Settings removal and the existing feature flows. After fixing duplicate microphone accessibility, `VoiceTouchVerification.xcresult` passes all 3 targeted voice / composer checks, including 50 ms press-and-slide gestures during simulated slow audio startup and recording above a diary row. Final test status across these runs: **54 passed, 0 remaining failures, 4 skipped**.

`MealActionsRegression.xcresult`: **57 passed, 0 failed, 4 skipped** on the same simulator (2026-10-07): 39 unit / mock HTTP tests and 18 UI tests. The new checks verify hold/up quick calories on all four meal buttons, hold/down opening the barcode scanner directly with the correct meal, neutral / sideways cancellation, normal taps, and adding to yesterday without changing today. Existing quick-add / portion pickers, diary dragging / scrolling, friend-card dismissal, chat, voice, recipes and Settings also pass. Rotated meal labels retain the wider gutter and are vertically centered beside their cards. The 4 opt-in production checks were skipped for this native UI change.

Simulator tests cannot verify physical camera input, actual microphone / transcription, installed widget behavior or a signed-in device's iCloud storage. Test those on TestFlight before public release. No backend schema changes or deployment were required for this port.

## Repository tracking

`origin` and `main` track the actual repository, `https://github.com/matixlol/caloric.git`. Pulls rebase local commits onto `origin/main`; tracked edits use Git autostash. `fork` points to `poasterbot/caloric` and is the default push remote. `upstream` also points to the actual repository for compatibility.

Run `python3 native-swift/scripts/setup-repository.py` after cloning, then `git pull` from the root before comparing or porting features. Resolve any conflicts while preserving Swift changes; do not reset or clean `native-swift/`. No credentials are stored in Git.

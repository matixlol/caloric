# Caloric Swift feature parity

Reference: `matixlol/caloric` main, `ded9c48` (2026-10-04). The standalone app is in `native-swift/`; Expo's generated native projects remain separate.

| Feature | Swift implementation and verification |
| --- | --- |
| Better Auth email code / password / sign up / secure session renewal | Implemented; auth regression tests and real production login / session renewal |
| Account isolated SQLite diary, settings, offline edits and conflict resolution | Implemented; download, retry, deletion, rejected writes and concurrent edits tested |
| Quarter portions, animated meal dragging, swipe deletion | Implemented; UI tests cover portion scrubbing, meal moves, reordering, edge scrolling and deletion |
| Current Today screen, Settings sheet, floating AI conversation | Matches current navigation; UI and light / dark visual checks |
| Recents, MFP / OFF search, pagination, ANMAT background enrichment | Implemented; interleaving / duplicate handling tested; recipe selection uses the same search |
| Quick add calories and optional macros, hold and slide calorie / portion pickers | Implemented; create / edit and both picker gestures tested |
| Camera barcode scanning, manual entry and MFP lookup | Implemented; normalization and manual-entry UI tested; camera requires a device |
| Reusable recipes, ingredients, duplication, deletion and recipe sync | Implemented; UI flow, local persistence and production create / update / delete tested |
| Logged recipe snapshots and ingredient editing | Implemented; recipe copies remain independent of later edits / deletion |
| Calorie / macro mismatch badges and meal macro totals | Implemented; unknown nutrients and aggregate totals tested |
| Friends: profile, code, requests, removal, daily totals and read only diary | Implemented; two isolated production accounts tested request, ignore, accept, diary access and removal |
| Streaming AI, search results, approvals and interrupted turn resume | Implemented; real production stream / background interruption / resume tested; replay deduplicates events |
| Animated voice recording, lock and cancel | Implemented; UI gesture tests use synthetic audio; microphone / transcription requires a device |
| Home / lock screen nutrition widgets and midnight rollover | Implemented; snapshot totals / goal ratios tested; separate widget extension and App Group |
| Daily iCloud backups including recipes | Implemented; separate iCloud container; device iCloud verification remains |
| Dark mode, accessibility labels and reduced motion | Implemented; light / dark visual inspection; controls have accessible actions |
| TestFlight updates | Full signed native releases; API key / local signing identity stored outside Git |

## Verification

`FinalFeatureParity.xcresult`: **54 passed, 0 failed, 0 skipped** on iPhone 17 Pro / iOS 26.5 (2026-10-07): 39 unit / mock HTTP tests, 4 native production integration tests and 11 UI tests. UI screenshots are attached to the result bundle. The two temporary verification accounts and their diary, recipe, social and AI records were removed after testing. Real user data was not changed.

Simulator tests cannot verify physical camera input, actual microphone / transcription, installed widget behavior or a signed-in device's iCloud storage. Test those on TestFlight before public release. No backend schema changes or deployment were required for this port.

## Repository tracking

`origin` and `main` track the actual repository, `https://github.com/matixlol/caloric.git`. Pulls rebase local commits onto `origin/main`; tracked edits use Git autostash. `fork` points to `poasterbot/caloric` and is the default push remote. `upstream` also points to the actual repository for compatibility.

Run `python3 native-swift/scripts/setup-repository.py` after cloning, then `git pull` from the root before comparing or porting features. Resolve any conflicts while preserving Swift changes; do not reset or clean `native-swift/`. No credentials are stored in Git.

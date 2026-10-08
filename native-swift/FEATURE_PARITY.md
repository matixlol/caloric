# Caloric Swift feature parity

Reference: `matixlol/caloric` main, `ded9c48` (2026-10-04). The standalone app is in `native-swift/`; Expo's generated native projects remain separate.

| Feature | Swift implementation and verification |
| --- | --- |
| Better Auth email code / password / sign up / secure session renewal | Implemented; auth regression tests and real production login / session renewal |
| Account isolated SQLite diary, settings, offline edits and conflict resolution | Implemented; download, retry, deletion, rejected writes and concurrent edits tested |
| Quarter portions, animated meal dragging, swipe deletion | Native UITableView food rows with standard trailing destructive actions, full-swipe deletion, cell selection and accessible Delete / Move actions; meal labels stay vertically centered in the wider gutter. Window-scoped meal dragging retains animated previews and uses time-based edge scrolling through the outer diary scroll view |
| Current Today screen, Settings sheet, floating AI conversation | Native friend diary card with pinned Done and swipe dismissal; no pull to refresh; Settings excludes the Updates section |
| Recents, MFP / OFF search, pagination, ANMAT background enrichment | Implemented; interleaving / duplicate handling tested; recipe selection uses the same search |
| Quick add calories and optional macros, hold and slide calorie / portion pickers | Implemented; taps open only the number form, deliberate holds open slide pickers; create / edit and picker gestures tested; each meal + supports hold/up for calories and hold/down for barcode scanning |
| Camera barcode scanning, manual entry and MFP lookup | Implemented; rear main camera starts at 2× zoom with continuous autofocus/exposure and automatic low-light torch; torch/capture stop on scan, dismissal or background; normalization and manual-entry UI tested; optical/lighting behavior requires a device |
| Reusable recipes, ingredients, duplication, deletion and recipe sync | Implemented; UI flow, local persistence and production create / update / delete tested |
| Logged recipe snapshots and ingredient editing | Implemented; recipe copies remain independent of later edits / deletion |
| Calorie / macro mismatch badges and meal macro totals | Implemented; unknown nutrients and aggregate totals tested |
| Friends: profile, code, requests, removal, daily totals and read only diary | Implemented; two isolated production accounts tested request, ignore, accept, diary access and removal |
| Streaming AI, search results, approvals and interrupted turn resume | Implemented; real production stream / background interruption / resume tested; replay deduplicates events |
| Native Liquid Glass and iOS controls | Real iOS 26 glass composer, microphone, conversation, recording surfaces and meal + controls; meal buttons use 44 pt glass circles with 48 pt touch areas, grouped for rendering; native action buttons, sheet controls, Settings toolbar and segmented food-source picker; iOS 17–25 fallback |
| Animated voice recording, lock and cancel | Native touch-down control with audio activation off the UI thread; lock/cancel work while preparing; UI tests use synthetic audio; microphone / transcription requires a device |
| Home / lock screen nutrition widgets and midnight rollover | Implemented; snapshot totals / goal ratios tested; separate widget extension and App Group |
| Daily iCloud backups including recipes | Implemented; separate iCloud container; device iCloud verification remains |
| Dark mode, accessibility labels and reduced motion | UIKit system backgrounds, labels and separators; approved Bento orange accents; light / dark visual inspection and accessible row actions; meal resizing respects reduced motion |
| Shared Bento icon and accents | All six editable SVG / PNG proposals and supplied wordmarks stored in `design/brand/`; generator creates Swift / Expo icons and app / widget palettes. Web shares the icon and palette. Only Swift is published for this change |
| TestFlight updates | Full signed native releases; API key / local signing identity stored outside Git |

## Verification

`FinalFeatureParity.xcresult`: **54 passed, 0 failed, 0 skipped** on iPhone 17 Pro / iOS 26.5 (2026-10-07): 39 unit / mock HTTP tests, 4 native production integration tests and 11 UI tests. UI screenshots are attached to the result bundle. The two temporary verification accounts and their diary, recipe, social and AI records were removed after testing. Real user data was not changed.

`LiquidGlassRegression.xcresult`: **51 passed, 0 failed, 4 skipped** on the same simulator (2026-10-07): 39 unit / mock HTTP tests and 12 UI tests. This run covers the new chat control transitions, conversation preservation, tap-through behavior and native Settings dismissal, plus voice lock/cancel, portion scrubbing, meal dragging, recipe and quick-add flows. The four opt-in production tests were not repeated for this UI-only update; their prior successful result is recorded above. Chat/recording screenshots are attached; light and dark appearance were reviewed.

Build 8 gesture refinements: **39 unit / mock HTTP tests and all 15 UI tests passed**, with 4 opt-in production tests skipped. `GestureRefinementsVerified.xcresult` covers the diary layout, friend-card scrolling / swipe dismissal, Quick add tap-only form, both hold pickers, Settings removal and the existing feature flows. After fixing duplicate microphone accessibility, `VoiceTouchVerification.xcresult` passes all 3 targeted voice / composer checks, including 50 ms press-and-slide gestures during simulated slow audio startup and recording above a diary row. Final test status across these runs: **54 passed, 0 remaining failures, 4 skipped**.

`MealActionsRegression.xcresult`: **57 passed, 0 failed, 4 skipped** on the same simulator (2026-10-07): 39 unit / mock HTTP tests and 18 UI tests. The new checks verify hold/up quick calories on all four meal buttons, hold/down opening the barcode scanner directly with the correct meal, neutral / sideways cancellation, normal taps, and adding to yesterday without changing today. Existing quick-add / portion pickers, diary dragging / scrolling, friend-card dismissal, chat, voice, recipes and Settings also pass. Rotated meal labels retain the wider gutter and are vertically centered beside their cards. The 4 opt-in production checks were skipped for this native UI change.

`BarcodeCameraRegression.xcresult`: **41 passed, 0 failed, 4 skipped** on the same simulator (2026-10-07): all 39 unit / mock HTTP checks and both barcode UI flows (toolbar/manual lookup and meal + hold/down with meal preservation). Build 10 uses the rear wide-angle camera, clamps the initial 2× zoom to hardware limits, applies continuous center autofocus/exposure, and uses native automatic torch mode when supported. Capture state and metadata callbacks share a serial queue; successful scans, dismissal and leaving the active scene stop the torch and session. Returning to the foreground restores zoom and automatic lighting. These checks do not exercise real camera optics or low-light torch activation, which require an iPhone.

`MealGlassRegression.xcresult`: **7 passed, 0 failed, 0 skipped** on the same simulator (2026-10-07). Targeted UI checks cover normal meal + taps, hold/up quick calories on all four meals, hold/down barcode opening, neutral / sideways cancellation, selected-date preservation, both meal-dragging flows (including edge scrolling) and the existing Quick add tap-only form. Meal + controls now have 44 pt native interactive Liquid Glass circles, 48 pt touch targets and a 24 pt SF Symbol; their shared glass container preserves the diary layout. Light/dark simulator appearance was inspected. No new gesture or data behavior was introduced.

`BentoBrandingRegression.xcresult`: **8 passed, 0 failed**. The original branding verification covers authentication, diary editing / search, chat controls, macro dragging, barcode routing, Quick add / Settings and recipes. The latest appearance uses system neutral backgrounds with the orange accents retained. Expo and web TypeScript checks and the web build pass; **18 web tests pass**. Expo lint has existing React compiler / hook failures (51 total); comparison of the 14 changed files finds no new errors (36 before and after).

`BentoNativeSwipeRegression.xcresult` and `NativeSwipeFinalVerification.xcresult`: **58 native tests passed across the final regression runs, 0 remaining failures, 4 opt-in production checks skipped** on iPhone 17 Pro / iOS 26.5. The full run passes all 39 unit / mock HTTP checks and 16 UI checks; three UI selectors still targeted the removed custom buttons. After changing those selectors to native cells, all 6 targeted checks pass, including the three affected Quick add / recipe flows, native swipe reveal / close / tap-delete / full-swipe, meal reordering and cancellation / date scoping. Long-drag edge scrolling, portions, friends, voice, chat and barcode flows pass. Deleting the last food animates the meal card resize with reduced-motion support. Light / dark system appearances and the native delete action were visually inspected.

Simulator tests cannot verify physical camera input, actual microphone / transcription, installed widget behavior or a signed-in device's iCloud storage. Test those on TestFlight before public release. No backend schema changes or deployment were required for this port.

## Repository tracking

`origin` and `main` track the actual repository, `https://github.com/matixlol/caloric.git`. Pulls rebase local commits onto `origin/main`; tracked edits use Git autostash. `fork` points to `poasterbot/caloric` and is the default push remote. `upstream` also points to the actual repository for compatibility.

Run `python3 native-swift/scripts/setup-repository.py` after cloning, then `git pull` from the root before comparing or porting features. Resolve any conflicts while preserving Swift changes; do not reset or clean `native-swift/`. No credentials are stored in Git.

# Launch and voice start — build 26

## Method

Release simulator build (iPhone 17 Pro, iOS 26.5) against a local copy of production data: the Oct 22 Railway backup restored into Postgres, `backend/` served locally, and the largest account (866 diary rows, 3 friends; one real day copied onto today). A local proxy adds a configurable delay per request; 800 ms approximates a cold connection on cellular. The app logs `PerformanceLog` marks (ms since the process started) and, with `-perf-hitches`, main-thread frame gaps longer than 1.5 frames. `LocalPerformanceUITests` drives the voice paths; it is opt-in (`TEST_RUNNER_CALORIC_PERF_LOGIN`). Read the marks with `xcrun simctl spawn booted log show --predicate 'subsystem == "lol.mati.caloric.swift" AND category == "performance"'`.

## Findings and changes

| Problem | Change |
| --- | --- |
| The diary was hidden behind a spinner until `get-session` returned, so launch time followed network latency (up to the 30 s request timeout on a bad connection) | A cached account opens straight to its local diary; the session is revalidated in the background (an invalid session still signs out) |
| Each launch ran 2 full `/sync/bootstrap` downloads and 3 `/social/daily-summaries` requests (initial load + reachability callback + foreground event + queued re-sync) | Foreground and reachability refreshes skip work that is in flight or < 10 s old; a sync queued during another only re-runs for edits made meanwhile |
| Every sync rewrote every diary row to SQLite (JSON-encoding each) and republished all rows, re-rendering the diary: a 140–170 ms main-thread stall | Merge / acknowledge write and publish only changed rows; bootstrap JSON decodes off the main thread |
| Each render re-filtered and re-sorted all rows once per meal | Active entries are indexed by day once per change |
| Food-row heights were measured with a new `UIHostingController` per row, ~130 ms for one day at launch | One reused sizing host |
| Launch cleared and rewrote the widget (2 App Group writes + 2 timeline reloads); session refreshes rewrote the Keychain item even when unchanged | Clear only when switching accounts; write the Keychain only on change |
| Friends card started empty and appeared later, pushing the diary down | Last totals for the day are cached and shown immediately |
| Voice: `AVAudioRecorder.record()` and `stop()` ran on the main thread; audio category and AAC encoder loaded on the first press | Start and stop on the audio queue (the voice note is sent once the file is finalized); category and encoder are loaded 1 s after launch without activating the session, so other audio keeps playing |
| Voice: 15 Hz meter updates re-evaluated the whole composer and the screen-wide hold-focus overlay; haptic generators were created on touch down; the attach menu queried the pasteboard and camera availability (IPC) on every composer render | Waveform and duration are separate observing views; the overlay preference is `Equatable`; haptics are prepared ahead; pasteboard / camera are checked on change / foreground / once |

## Results (simulator)

| Cold launch, mean of 3 | Before | After |
| --- | ---: | ---: |
| Diary on screen, no added latency | 416 ms | ~390 ms |
| Diary on screen, 800 ms per request | 1,210 ms | ~390 ms |
| Worst main-thread stall in the first 3 s | 140–170 ms | 40–60 ms |
| Requests per launch (bootstrap / friends) | 2 / 3 | 1 / 1 |

On a fast connection, the diary was already shown at about the same time; the other changes remove the stalls after the first frame. Before the change, the 800 ms delay pushed the diary past 1.2 s and a slow request kept the spinner until the 30 s timeout. The diary now appears independent of network latency.

Voice start cannot be measured fully in this simulator: microphone capture fails (`record()` returns false), so the expensive part on a device — activating the route and starting the audio queue — does not run. With real audio, the stalls after touch down varied from run to run (first press 131 + 348 ms in one run of the original code, 69 ms in another, ≤ 52 ms after the change). With synthetic audio, both versions measure within noise (≤ 58 ms), so the composer's UI work was not the stall. The audio-queue changes target device behavior and need a check on an iPhone, preferably with Instruments' Animation Hitches on the first press after launch.

# Home scrolling

## Findings and changes — build 15

The native food list observed the outer scroll view's `contentOffset`, converted every food row to window coordinates and dispatched those rectangles back into each meal's SwiftUI state. A global geometry preference then updated `TodayView` state. Ordinary scrolling repeatedly invalidated the diary's view tree, even though these coordinates were only needed for food dragging.

`DiaryGeometry` now holds weak native view references and reads their current window coordinates at drag hit testing, drag start and drag movement. There are no scroll-offset observers, row-frame state bindings or global geometry preferences. These snapshots include scroll position, updated row order and meal resizing. Drag auto-scrolling still uses elapsed time and reads fresh geometry after changing the content offset.

The app also lacked `CADisableMinimumFrameDurationOnPhone`. It is now enabled in the app plist. The drag-only display link requests the active screen's supported maximum instead of capping at 60 Hz, and is invalidated when dragging ends. Ordinary scrolling remains system-paced; no permanent display link forces a high refresh rate. Apple documents that the opt-in permits Core Animation rates above 60 Hz, while the system determines actual pacing for UIKit and SwiftUI. Its absence alone does not establish the previously observed scroll frame rate. See [Apple's ProMotion guidance](https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays).

## Measurement

`testHomeScrollPerformance` runs the same rapid up/down Home scroll five times with a 13-entry fixture. Captures use the same Debug simulator build configuration, iPhone 17 Pro / iOS 26.5, with no screen recording. XCTest measures app CPU and the system scrolling/deceleration signpost. One before and one after capture, five samples each:

| Mean per measured flow | Before | After |
| --- | ---: | ---: |
| App CPU time | 5.470 s | 1.310 s |
| App instructions retired | 66.810 billion | 6.205 billion |
| Scroll/deceleration signpost duration | 2.713 s | 2.497 s |

App CPU time decreased **76%** in this simulator benchmark; instructions decreased **91%**. CPU time includes work on all app threads over the measurement block, not the cost of one frame. Signpost duration is elapsed scrolling time, not a frame-rate or dropped-frame measurement. Bundles: `build/HomeScrollBaseline.xcresult` and `build/HomeScrollOptimized.xcresult`; machine-readable metric exports are stored in the ignored build directory.

The report came from an iPhone 16 Pro with both Low Power Mode and Accessibility → Motion → Limit Frame Rate disabled. The simulator cannot prove physical iPhone refresh rate or device energy use, and Debug timings do not predict Release timings. There was no connected iPhone for a hardware capture. Compare build 15 on that device; iOS can still vary refresh rate with motion, temperature and system conditions. A device Animation Hitches / Core Animation capture is required to establish actual frame delivery.

Functional validation passes the native geometry unit check and eight gesture UI flows: current coordinates after scrolling / reordered rows, cross-meal / within-meal moves, offscreen auto-scrolling, native deletion, portions, meal + hold menus / cancellation / selected date and voice locking. No backend contracts or production data were changed.

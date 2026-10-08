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

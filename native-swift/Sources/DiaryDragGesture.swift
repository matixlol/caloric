import SwiftUI
import UIKit

/// A window-scoped long press keeps its touch when a row moves between meal views.
/// It never starts an iOS text/link drag session or creates a system drag preview.
struct DiaryDragGesture: UIViewRepresentable {
    var enabled: Bool
    var layout: () -> DiaryLayout
    var bottomExclusion: CGFloat = 76
    var began: (String, CGPoint) -> Void
    var moved: (CGPoint) -> Void
    var ended: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIView(context: Context) -> AttachmentView {
        let view = AttachmentView()
        view.isUserInteractionEnabled = false
        view.windowChanged = { [weak coordinator = context.coordinator] window in coordinator?.attach(to: window) }
        return view
    }
    func updateUIView(_ view: AttachmentView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.attach(to: view.window)
        if !enabled { context.coordinator.cancel() }
    }
    static func dismantleUIView(_ view: AttachmentView, coordinator: Coordinator) { coordinator.attach(to: nil) }

    final class AttachmentView: UIView {
        var windowChanged: ((UIWindow?) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); windowChanged?(window) }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: DiaryDragGesture
        private weak var window: UIWindow?
        private weak var scroll: UIScrollView?
        private var wasScrollEnabled = true
        private var sourceID: String?
        private var active = false
        private var point = CGPoint.zero
        private var displayLink: CADisplayLink?
        private var lastScrollTimestamp: CFTimeInterval = 0
        private lazy var gesture: UILongPressGestureRecognizer = {
            let gesture = UILongPressGestureRecognizer(target: self, action: #selector(handle(_:)))
            gesture.minimumPressDuration = 0.32
            gesture.allowableMovement = 10
            gesture.cancelsTouchesInView = true
            gesture.delegate = self
            return gesture
        }()

        init(parent: DiaryDragGesture) { self.parent = parent }
        func attach(to newWindow: UIWindow?) {
            guard window !== newWindow else { return }
            cancel()
            window?.removeGestureRecognizer(gesture)
            window = newWindow
            newWindow?.addGestureRecognizer(gesture)
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard parent.enabled, let window else { return false }
            var touchedView = touch.view
            while let current = touchedView {
                if current is VoiceTouchControl.TouchControl { return false }
                touchedView = current.superview
            }
            let point = touch.location(in: window)
            guard let row = parent.layout().rows.first(where: { $0.value.contains(point) }) else { return false }
            sourceID = row.key
            var view = touch.view
            scroll = nil
            while let current = view {
                if let candidate = current as? UITableView, candidate.isEditing { return false }
                if let candidate = current as? UIScrollView, candidate.isScrollEnabled { scroll = candidate; break }
                view = current.superview
            }
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // SwiftUI's hosting recognizers see the initial press too. They must not
            // prevent the hold recognizer before it has reached its minimum duration.
            true
        }
        @objc private func handle(_ recognizer: UILongPressGestureRecognizer) {
            guard let window else { return }
            point = recognizer.location(in: window)
            switch recognizer.state {
            case .began:
                guard parent.enabled, let sourceID else { return }
                active = true
                wasScrollEnabled = scroll?.isScrollEnabled ?? true
                scroll?.isScrollEnabled = false
                parent.began(sourceID, point)
                lastScrollTimestamp = 0
                displayLink = CADisplayLink(target: self, selector: #selector(autoScroll))
                let maximumFPS = Float(window.screen.maximumFramesPerSecond)
                displayLink?.preferredFrameRateRange = CAFrameRateRange(minimum: min(60, maximumFPS), maximum: maximumFPS, preferred: maximumFPS)
                displayLink?.add(to: .main, forMode: .common)
            case .changed: if active { parent.moved(point) }
            case .ended:
                if active { parent.moved(point) }
                finish(cancelled: false)
            case .cancelled, .failed: finish(cancelled: true)
            default: break
            }
        }
        @objc private func autoScroll() {
            guard active, let scroll, let window, let displayLink else { return }
            let elapsed = lastScrollTimestamp == 0 ? displayLink.duration : displayLink.timestamp - lastScrollTimestamp
            lastScrollTimestamp = displayLink.timestamp
            var viewport = scroll.convert(scroll.bounds, to: window).inset(by: scroll.adjustedContentInset)
            viewport.size.height = max(0, viewport.height - parent.bottomExclusion)
            let edge: CGFloat = 70
            var delta: CGFloat = 0
            if point.y < viewport.minY + edge { delta = -min(9, (viewport.minY + edge - point.y) / edge * 9) }
            else if point.y > viewport.maxY - edge { delta = min(9, (point.y - viewport.maxY + edge) / edge * 9) }
            guard delta != 0 else { return }
            let minimum = -scroll.adjustedContentInset.top
            let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            let offset = max(minimum, min(maximum, scroll.contentOffset.y + delta * min(3, elapsed * 60)))
            guard abs(offset - scroll.contentOffset.y) > 0.1 else { return }
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: offset), animated: false)
            parent.moved(point)
        }
        func cancel() { finish(cancelled: true) }
        private func finish(cancelled: Bool) {
            displayLink?.invalidate(); displayLink = nil
            guard active else { sourceID = nil; return }
            active = false
            scroll?.isScrollEnabled = wasScrollEnabled
            parent.ended(cancelled)
            sourceID = nil
        }
    }
}

struct DiaryLayout: Equatable {
    var rows: [String: CGRect] = [:]
    var meals: [Meal: CGRect] = [:]
}

/// Read native geometry only when a drag needs it. Scrolling never publishes
/// coordinates into SwiftUI state or triggers a diary layout / body update.
final class DiaryGeometry {
    private struct MealView { weak var view: UIView? }
    private struct RowsView { weak var table: UITableView?; let ids: [String] }
    private var meals: [Meal: MealView] = [:]
    private var rows: [Meal: RowsView] = [:]

    func registerMeal(_ meal: Meal, view: UIView) { meals[meal] = MealView(view: view) }
    func removeMeal(_ meal: Meal, view: UIView) { if meals[meal]?.view === view { meals[meal] = nil } }
    func registerRows(meal: Meal, table: UITableView, ids: [String]) { rows[meal] = RowsView(table: table, ids: ids) }
    func removeRows(meal: Meal, table: UITableView) { if rows[meal]?.table === table { rows[meal] = nil } }

    func snapshot() -> DiaryLayout {
        var result = DiaryLayout()
        for (meal, reference) in meals {
            guard let view = reference.view, let window = view.window else { continue }
            result.meals[meal] = view.convert(view.bounds, to: window)
        }
        for reference in rows.values {
            guard let table = reference.table, let window = table.window else { continue }
            for (index, id) in reference.ids.enumerated() where index < table.numberOfRows(inSection: 0) {
                result.rows[id] = table.convert(table.rectForRow(at: IndexPath(row: index, section: 0)), to: window)
            }
        }
        return result
    }
}

struct DiaryMealGeometry: UIViewRepresentable {
    let meal: Meal
    let geometry: DiaryGeometry
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        geometry.registerMeal(meal, view: view)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) { geometry.registerMeal(meal, view: view) }
    func makeCoordinator() -> Coordinator { Coordinator(meal: meal, geometry: geometry) }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.geometry.removeMeal(coordinator.meal, view: view) }
    struct Coordinator { let meal: Meal; let geometry: DiaryGeometry }
}

import SwiftUI
import UIKit

struct MealAddButton: View {
    let meal: Meal
    let enabled: Bool
    let holding: Bool
    let tapped: () -> Void
    let scan: () -> Void
    let began: (CGRect) -> Void
    let moved: (CGSize) -> Void
    let ended: (Bool) -> Void
    var body: some View {
        Image(systemName: "plus").font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.tint)
            .frame(width: 44, height: 44)
            .caloricGlass(in: Circle(), tint: holding ? Theme.tint.opacity(0.12) : nil, interactive: enabled)
            .frame(width: 48, height: 48)
            .overlay(MealAddControl(enabled: enabled, tapped: tapped, began: began, moved: moved, ended: ended).accessibilityHidden(true))
            .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton)
            .accessibilityLabel("Add food to \(meal.label)")
            .accessibilityValue(holding ? "Choosing meal action" : "")
            .accessibilityAction { tapped() }
            .accessibilityAction(named: "Scan barcode") { scan() }
    }
}

/// A native hold recognizer retains the + touch outside its bounds, and only
/// pauses scrolling after the hold succeeds. Short taps remain normal taps.
struct MealAddControl: UIViewRepresentable {
    var enabled: Bool
    var tapped: () -> Void
    var began: (CGRect) -> Void
    var moved: (CGSize) -> Void
    var ended: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIView(context: Context) -> UIView {
        let control = UIView()
        control.isAccessibilityElement = false
        control.accessibilityElementsHidden = true
        control.addGestureRecognizer(context.coordinator.hold)
        control.addGestureRecognizer(context.coordinator.tap)
        return control
    }
    func updateUIView(_ control: UIView, context: Context) {
        context.coordinator.parent = self
        control.isUserInteractionEnabled = enabled
        if !enabled { context.coordinator.cancel() }
    }
    static func dismantleUIView(_ control: UIView, coordinator: Coordinator) { coordinator.cancel() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: MealAddControl
        private var origin: CGPoint?
        private weak var scroll: UIScrollView?
        private var wasScrollEnabled = true
        lazy var tap: UITapGestureRecognizer = {
            let recognizer = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
            recognizer.require(toFail: hold)
            recognizer.delegate = self
            return recognizer
        }()
        lazy var hold: UILongPressGestureRecognizer = {
            let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(handle(_:)))
            recognizer.minimumPressDuration = 0.26
            recognizer.allowableMovement = 12
            recognizer.cancelsTouchesInView = true
            recognizer.delegate = self
            return recognizer
        }()
        init(parent: MealAddControl) { self.parent = parent }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
        @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard recognizer.state == .ended, parent.enabled, origin == nil else { return }
            parent.tapped()
        }
        @objc private func handle(_ recognizer: UILongPressGestureRecognizer) {
            switch recognizer.state {
            case .began:
                guard parent.enabled, let control = recognizer.view else { return }
                origin = recognizer.location(in: nil)
                var ancestor = control.superview
                while let current = ancestor {
                    if let candidate = current as? UIScrollView { scroll = candidate; break }
                    ancestor = current.superview
                }
                wasScrollEnabled = scroll?.isScrollEnabled ?? true
                scroll?.isScrollEnabled = false
                parent.began(control.convert(control.bounds, to: nil))
            case .changed: update(recognizer)
            case .ended: update(recognizer); finish(cancelled: false)
            case .cancelled, .failed: finish(cancelled: true)
            default: break
            }
        }
        private func update(_ recognizer: UILongPressGestureRecognizer) {
            guard let origin else { return }
            let point = recognizer.location(in: nil)
            parent.moved(CGSize(width: point.x - origin.x, height: point.y - origin.y))
        }
        func cancel() { finish(cancelled: true) }
        private func finish(cancelled: Bool) {
            guard origin != nil else { return }
            origin = nil
            scroll?.isScrollEnabled = wasScrollEnabled
            scroll = nil
            parent.ended(cancelled)
        }
    }
}

enum MealAddSelection: Equatable {
    case calories(Double), barcode
    static func picked(_ translation: CGSize) -> Self? {
        guard abs(translation.width) <= 100 else { return nil }
        if translation.height >= 54 { return .barcode }
        return QuickCalories.picked(translation.height).map(Self.calories)
    }
}

struct MealAddSession {
    let meal: Meal
    let day: String
    let frame: CGRect
    var selection: MealAddSelection?
    var calories: Double? { if case let .calories(value) = selection { value } else { nil } }
}

struct MealAddMenu: View {
    let session: MealAddSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        GeometryReader { geometry in
            let frame = session.frame.offsetBy(dx: -geometry.frame(in: .global).minX, dy: -geometry.frame(in: .global).minY)
            SlideValuePicker(values: QuickCalories.values, selection: session.calories, calories: true)
                .fixedSize()
                .position(x: min(geometry.size.width - 60, frame.midX - 24), y: max(174, frame.midY - 54 - 162))
            Label("Scan barcode", systemImage: "barcode.viewfinder")
                .font(.subheadline.weight(.semibold)).foregroundStyle(session.selection == .barcode ? Color.white : Theme.tint)
                .padding(.horizontal, 16).frame(height: 44)
                .background(session.selection == .barcode ? Theme.tint : Theme.card, in: Capsule())
                .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
                .scaleEffect(!reduceMotion && session.selection == .barcode ? 1.04 : 1)
                .position(x: min(geometry.size.width - 91, frame.midX - 50), y: min(geometry.size.height - 30, frame.midY + 70))
                .animation(reduceMotion ? nil : .snappy(duration: 0.16), value: session.selection == .barcode)
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}

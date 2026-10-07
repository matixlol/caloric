import SwiftUI
import UIKit

/// Starts on touch down and keeps tracking outside the microphone's bounds.
struct VoiceTouchControl: UIViewRepresentable {
    var enabled: Bool
    var began: () -> Void
    var moved: (CGSize) -> Void
    var ended: (Bool) -> Void

    func makeUIView(context: Context) -> TouchControl {
        let control = TouchControl()
        control.isAccessibilityElement = false
        control.accessibilityElementsHidden = true
        control.isExclusiveTouch = true
        return control
    }
    func updateUIView(_ control: TouchControl, context: Context) {
        control.began = began; control.moved = moved; control.ended = ended
        control.isEnabled = enabled
    }
    static func dismantleUIView(_ control: TouchControl, coordinator: ()) {
        control.cancelTracking(with: nil)
    }

    final class TouchControl: UIControl {
        var began: (() -> Void)?
        var moved: ((CGSize) -> Void)?
        var ended: ((Bool) -> Void)?
        private var origin: CGPoint?

        override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
            guard isEnabled else { return false }
            origin = touch.location(in: nil)
            began?()
            return true
        }
        override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
            update(touch)
            return true
        }
        override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
            if let touch { update(touch) }
            finish(cancelled: false)
        }
        override func cancelTracking(with event: UIEvent?) { finish(cancelled: true) }
        private func update(_ touch: UITouch) {
            guard let origin else { return }
            let point = touch.location(in: nil)
            moved?(CGSize(width: point.x - origin.x, height: point.y - origin.y))
        }
        private func finish(cancelled: Bool) {
            guard origin != nil else { return }
            origin = nil
            ended?(cancelled)
        }
    }
}

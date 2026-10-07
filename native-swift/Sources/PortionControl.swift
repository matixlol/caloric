import SwiftUI

struct PortionControl: View {
    @Binding var value: Double
    @State private var dragStart: Double?
    @State private var horizontal: Bool?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Portion").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Image(systemName: "chevron.left").foregroundStyle(.tertiary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(Portion.label(value)).font(.system(size: 30, weight: .bold)).monospacedDigit()
                        .contentTransition(.numericText())
                    Text("\(value.formatted(.number.precision(.fractionLength(0...2))))x base serving")
                        .font(.system(size: 14)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }.padding(.vertical, 8).contentShape(Rectangle())
                .background(dragStart == nil ? Color.clear : Theme.tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                .simultaneousGesture(DragGesture(minimumDistance: 8, coordinateSpace: .global)
                    .onChanged { gesture in
                        if horizontal == nil { horizontal = abs(gesture.translation.width) > abs(gesture.translation.height) }
                        guard horizontal == true else { return }
                        if dragStart == nil { dragStart = value }
                        setValue((dragStart ?? value) + Double((gesture.translation.width / 20).rounded()) * 0.25)
                    }
                    .onEnded { _ in dragStart = nil; horizontal = nil })
                .accessibilityElement(children: .ignore).accessibilityIdentifier("portion-scrubber")
                .accessibilityLabel("Portion").accessibilityValue(Portion.label(value))
                .accessibilityHint("Drag left or right to adjust in quarter portions")
                .accessibilityAdjustableAction { direction in setValue(value + (direction == .increment ? 0.25 : -0.25)) }
            HStack(spacing: 8) {
                button("-1", delta: -1); button("-1/4", delta: -0.25)
                button("+1/4", delta: 0.25); button("+1", delta: 1)
            }
        }
    }

    private func setValue(_ proposed: Double) {
        let next = Portion.sanitize(proposed)
        guard next != value else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { value = next }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func button(_ label: String, delta: Double) -> some View {
        let disabled = Portion.sanitize(value + delta) == value
        return Button { setValue(value + delta) } label: {
            Text(label).font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 40)
                .foregroundStyle(disabled ? Color.secondary : Theme.tint)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(uiColor: .separator), lineWidth: 0.5))
        }.disabled(disabled).buttonStyle(.plain).accessibilityLabel("Adjust portion \(label)")
    }
}

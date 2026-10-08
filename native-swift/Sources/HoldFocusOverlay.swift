import SwiftUI

private struct HoldFocusRegion {
    let bounds: Anchor<CGRect>
    let cornerRadius: CGFloat
}

private struct HoldFocusKey: PreferenceKey {
    static var defaultValue: [HoldFocusRegion] = []
    static func reduce(value: inout [HoldFocusRegion], nextValue: () -> [HoldFocusRegion]) {
        value.append(contentsOf: nextValue())
    }
}

extension View {
    /// Keep the actual control and menu bright without replacing the pressed view.
    func holdFocus(_ active: Bool = true, cornerRadius: CGFloat = 14) -> some View {
        // Keep descendant options when their containing button also contributes a region.
        transformAnchorPreference(key: HoldFocusKey.self, value: .bounds) { regions, bounds in
            if active { regions.append(HoldFocusRegion(bounds: bounds, cornerRadius: cornerRadius)) }
        }
    }

    func holdFocusOverlay() -> some View { modifier(HoldFocusOverlay()) }
}

private struct HoldFocusOverlay: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.overlayPreferenceValue(HoldFocusKey.self) { regions in
            GeometryReader { geometry in
                Color.black.opacity(regions.isEmpty ? 0 : 0.46)
                    .mask {
                        Rectangle().fill(.white)
                            .overlay {
                                ForEach(regions.indices, id: \.self) { index in
                                    let region = regions[index]
                                    let frame = geometry[region.bounds].insetBy(dx: -3, dy: -3)
                                    RoundedRectangle(cornerRadius: region.cornerRadius + 3)
                                        .fill(.black).frame(width: frame.width, height: frame.height)
                                        .position(x: frame.midX, y: frame.midY)
                                        .blendMode(.destinationOut)
                                }
                            }.compositingGroup()
                    }
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: regions.isEmpty)
            }.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

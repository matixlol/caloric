import SwiftUI

enum Theme {
    static let background = BrandPalette.background
    static let card = BrandPalette.card
    static let input = BrandPalette.inputBackground
    static let label = BrandPalette.label
    static let separator = BrandPalette.separator
    static let tint = BrandPalette.tint
    static let onTint = BrandPalette.buttonText
    static let accent = BrandPalette.accent
    static let protein = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let carbs = Color(red: 245 / 255, green: 158 / 255, blue: 11 / 255)
    static let fat = Color(red: 20 / 255, green: 184 / 255, blue: 166 / 255)
}

extension View {
    func caloricCard(padding: CGFloat = 14) -> some View {
        self.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
    }
    func screenTitle() -> some View { font(.system(size: 34, weight: .bold)).frame(maxWidth: .infinity, alignment: .leading) }
}

struct PrimaryButton: View {
    let title: String
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) { Text(title).font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6) }
            .nativeActionStyle(prominent: true).controlSize(.large).tint(Theme.tint).foregroundStyle(Theme.onTint).disabled(!enabled)
    }
}

struct NativeIconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 18, weight: .semibold)).frame(width: 20, height: 20) }
            .nativeActionStyle(shape: .circle).controlSize(.large)
            .frame(minWidth: 44, minHeight: 44).accessibilityLabel(label)
    }
}

struct LiquidGlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder let content: () -> Content
    var body: some View {
        if #available(iOS 26, *) { GlassEffectContainer(spacing: spacing, content: content) }
        else { content() }
    }
}

struct MacroBadges: View {
    var nutrition: Nutrition?
    var multiplier: Double = 1
    var wholeGrams = false
    var body: some View {
        let n = nutrition?.multiplied(by: multiplier)
        HStack(spacing: 6) {
            if let v = n?.calories { badge("\(Int(v.rounded()).formatted()) kcal", background: Theme.input, foreground: Theme.label) }
            if let v = n?.protein { badge("P \(grams(v, whole: wholeGrams))", background: Theme.protein, foreground: .white) }
            if let v = n?.carbs { badge("C \(grams(v, whole: wholeGrams))", background: Theme.carbs, foreground: BrandPalette.ink) }
            if let v = n?.fat { badge("F \(grams(v, whole: wholeGrams))", background: Theme.fat, foreground: .white) }
            if nutrition?.hasCalorieMismatch == true { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.carbs).accessibilityLabel("Calories and macros differ by more than 15 percent") }
        }.padding(.top, 4).minimumScaleFactor(0.8)
    }
    private func badge(_ text: String, background: Color, foreground: Color) -> some View {
        Text(text).font(.system(size: 11, weight: .bold)).monospacedDigit().lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 4).foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: 7))
    }
}

struct CalorieMismatchBadge: View {
    var body: some View {
        Label("Macro mismatch", systemImage: "exclamationmark.circle.fill").font(.system(size: 11, weight: .bold)).padding(.horizontal, 7).padding(.vertical, 4).foregroundStyle(Color(red: 0.57, green: 0.25, blue: 0.05)).background(Color(red: 1, green: 0.95, blue: 0.78), in: RoundedRectangle(cornerRadius: 7)).accessibilityLabel("Calories and macros differ by more than 15 percent")
    }
}

extension View {
    @ViewBuilder func caloricGlass<S: Shape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26, *) { glassEffect(.regular.tint(tint).interactive(interactive), in: shape) }
        else { background(.regularMaterial, in: shape) }
    }
    @ViewBuilder func glassIdentity(_ id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 26, *) { glassEffectID(id, in: namespace) }
        else { self }
    }
    @ViewBuilder func nativeActionStyle(prominent: Bool = false, shape: ButtonBorderShape = .capsule) -> some View {
        if #available(iOS 26, *) {
            if prominent { buttonStyle(.glassProminent).buttonBorderShape(shape) }
            else { buttonStyle(.glass).buttonBorderShape(shape) }
        } else {
            if prominent { buttonStyle(.borderedProminent).buttonBorderShape(shape) }
            else { buttonStyle(.bordered).buttonBorderShape(shape) }
        }
    }
}

func grams(_ value: Double, whole: Bool = false) -> String { "\((whole ? value.rounded() : value).formatted(.number.precision(.fractionLength(0...1))))g" }

struct ProgressTrack: View {
    var value: Double
    var goal: Double
    var color = Theme.accent
    var height: CGFloat = 5
    var body: some View {
        GeometryReader { geometry in
            Capsule().fill(Theme.separator).overlay(alignment: .leading) {
                Rectangle().fill(color).frame(width: geometry.size.width * max(0, min(1, goal > 0 ? value / goal : 0)))
            }.clipShape(Capsule())
        }.frame(height: height)
    }
}

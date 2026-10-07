import SwiftUI

enum Theme {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let input = Color(uiColor: .tertiarySystemGroupedBackground)
    static let tint = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let protein = tint
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
        Button(action: action) { Text(title).font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).frame(minHeight: 50) }
            .foregroundStyle(.white).background(enabled ? Theme.tint : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14))
            .disabled(!enabled).buttonStyle(.plain)
    }
}

struct MacroBadges: View {
    var nutrition: Nutrition?
    var multiplier: Double = 1
    var body: some View {
        let n = nutrition?.multiplied(by: multiplier)
        HStack(spacing: 6) {
            if let v = n?.calories { badge("\(Int(v.rounded()).formatted()) kcal", background: Color(red: 229 / 255, green: 231 / 255, blue: 235 / 255), foreground: Color(red: 55 / 255, green: 65 / 255, blue: 81 / 255)) }
            if let v = n?.protein { badge("P \(grams(v))", background: Theme.protein, foreground: .white) }
            if let v = n?.carbs { badge("C \(grams(v))", background: Theme.carbs, foreground: Color(red: 31 / 255, green: 41 / 255, blue: 55 / 255)) }
            if let v = n?.fat { badge("F \(grams(v))", background: Theme.fat, foreground: .white) }
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
    @ViewBuilder func assistantGlass() -> some View {
        if #available(iOS 26, *) { glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22)) }
        else { background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22)) }
    }
}

func grams(_ value: Double) -> String { "\(value.formatted(.number.precision(.fractionLength(0...1))))g" }

struct ProgressTrack: View {
    var value: Double
    var goal: Double
    var color = Theme.tint
    var height: CGFloat = 5
    var body: some View {
        GeometryReader { geometry in
            Capsule().fill(Color(uiColor: .tertiaryLabel)).overlay(alignment: .leading) {
                Rectangle().fill(color).frame(width: geometry.size.width * max(0, min(1, goal > 0 ? value / goal : 0)))
            }.clipShape(Capsule())
        }.frame(height: height)
    }
}

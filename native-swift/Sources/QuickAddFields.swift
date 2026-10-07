import SwiftUI

enum QuickCalories {
    static let values = stride(from: 50.0, through: 600.0, by: 50).map { $0 }
    static func picked(_ translation: CGFloat, values: [Double] = values) -> Double? {
        let delta = -translation - 54
        guard delta >= 0, !values.isEmpty else { return nil }
        return values[min(values.count - 1, Int((delta / 25).rounded()))]
    }
    static func food(_ calories: Double) -> SearchFood {
        SearchFood(id: "quick", canonicalKey: "quick", source: "manual", sourceLabel: "", name: "Quick add", serving: "Manual entry", nutrition: Nutrition(calories: calories))
    }
}

struct SlideValuePicker: View {
    let values: [Double]
    let selection: Double?
    let calories: Bool
    var body: some View {
        VStack(spacing: 3) {
            Text(selection.map { calories ? "\(Int($0)) kcal" : "\(Portion.mixed($0))×" } ?? "—").font(.headline).foregroundStyle(Theme.tint).padding(.bottom, 5)
            ForEach(values.reversed(), id: \.self) { value in
                HStack { Text(calories ? "\(Int(value))" : Portion.mixed(value)).font(.caption).monospacedDigit().frame(width: 45, alignment: .trailing); RoundedRectangle(cornerRadius: 4).fill(selection == value ? Theme.tint : Color(uiColor: .tertiarySystemFill)).frame(width: 20, height: !calories && value.rounded() == value ? 35 : 20) }
            }
        }.padding(12).background(Theme.card, in: RoundedRectangle(cornerRadius: 14)).shadow(radius: 12, y: 5)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct QuickAddFields: View {
    @Binding var calories: String
    @Binding var protein: String
    @Binding var carbs: String
    @Binding var fat: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Quick add").font(.headline)
            field("Calories", value: $calories, placeholder: "250", large: true)
            HStack(spacing: 8) { field("Protein", value: $protein); field("Carbs", value: $carbs); field("Fat", value: $fat) }
        }
    }
    private func field(_ title: String, value: Binding<String>, placeholder: String = "g", large: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            TextField(placeholder, text: value).keyboardType(.decimalPad).font(large ? .title2.bold() : .body).padding(10).background(Theme.input, in: RoundedRectangle(cornerRadius: 10)).accessibilityLabel("Quick add \(title.lowercased())")
        }.frame(maxWidth: .infinity)
    }
}

struct HoldSlideButton: View {
    let title: String
    let enabled: Bool
    var secondary = false
    let values: [Double]
    @Binding var selection: Double?
    let tapped: () -> Void
    let committed: (Double) -> Void
    @State private var picking = false
    @State private var endedAt = -Double.infinity
    private var calories: Bool { (values.first ?? 0) >= 50 }
    var body: some View {
        Button {
            guard enabled, ProcessInfo.processInfo.systemUptime - endedAt > 0.4 else { return }; tapped()
        } label: {
            Text(title).font(.headline).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).padding(.vertical, 6)
        }.nativeActionStyle(prominent: !secondary).controlSize(.large).tint(Theme.tint).disabled(!enabled)
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.26, maximumDistance: 30).sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
                .onChanged { value in
                    guard enabled else { return }
                    switch value {
                    case let .second(true, drag):
                        start(); guard let drag else { return }
                        let next = picked(drag.translation.height)
                        if next != selection { selection = next; if next != nil { UISelectionFeedbackGenerator().selectionChanged() } }
                    default: break
                    }
                }.onEnded { value in
                    guard picking else { return }
                    if case let .second(true, drag?) = value { selection = picked(drag.translation.height) }
                    let selected = selection; picking = false; selection = nil; endedAt = ProcessInfo.processInfo.systemUptime
                    if let selected { committed(selected) }
                })
            .overlay(alignment: secondary ? .bottomTrailing : .bottomLeading) {
                if picking {
                    SlideValuePicker(values: values, selection: selection, calories: calories).offset(y: -60)
                }
            }.accessibilityValue(picking ? "Choosing \(calories ? "calories" : "portion")" : "")
            .onDisappear { picking = false; selection = nil }
    }
    private func start() {
        guard !picking else { return }; picking = true; selection = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    private func picked(_ translation: CGFloat) -> Double? {
        let delta = -translation - 54
        guard delta >= 0, !values.isEmpty else { return nil }
        if calories { return QuickCalories.picked(translation, values: values) }
        var offsets = [0.0]
        for i in 1..<values.count { offsets.append(offsets[i - 1] + 25 * ((values[i - 1].rounded() == values[i - 1] ? 2.0 : 1.0) + (values[i].rounded() == values[i] ? 2.0 : 1.0)) / 2) }
        let index = offsets.indices.min { abs(offsets[$0] - delta) < abs(offsets[$1] - delta) } ?? 0
        return values[index]
    }
}

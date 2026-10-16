import SwiftUI

/// Suggested foods as one compact list: untick what's wrong, adjust portions or the meal, then Add.
struct AssistantApprovalCard: View {
    let message: ChatMessage
    let chat: AILogService
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var portions: [String: Double] = [:]
    @State private var meals: [String: Meal] = [:]
    @State private var excluded: Set<String> = []

    private var pending: [FoodSuggestion] { message.suggestions.filter { $0.output == nil } }
    private var included: [FoodSuggestion] { pending.filter { !excluded.contains($0.id) } }
    private func portion(_ s: FoodSuggestion) -> Double { s.output == nil ? portions[s.id] ?? s.portion : s.portion }
    private func meal(_ s: FoodSuggestion) -> Meal { s.output == nil ? meals[s.id] ?? s.meal : s.meal }
    private func calories(_ s: FoodSuggestion) -> Int { Int(((s.food.nutrition?.calories ?? 0) * Portion.sanitize(portion(s))).rounded()) }
    /// One meal menu for the whole card when every pending food goes to the same meal.
    private var sharedMeal: Meal? {
        let values = Set(pending.map(meal))
        return values.count == 1 ? values.first : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
            ForEach(Array(message.suggestions.enumerated()), id: \.element.id) { index, suggestion in
                if index > 0 { Divider().padding(.leading, 50) }
                row(suggestion)
            }
            if !pending.isEmpty { actions.padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 12) }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.separator.opacity(0.6), lineWidth: 0.5))
        .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: message.suggestions.map { $0.output?.approved })
        .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: excluded)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if pending.isEmpty {
                let added = message.suggestions.filter { $0.output?.approved == true }.count
                Label(added == 0 ? "Skipped" : added == 1 ? "Added 1 food" : "Added \(added) foods",
                      systemImage: added == 0 ? "minus.circle.fill" : "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(added == 0 ? Color.secondary : Color.green)
                    .accessibilityIdentifier("ai-approval-status")
            } else if let sharedMeal {
                mealMenu(sharedMeal, label: "Meal for all foods") { meal in pending.forEach { meals[$0.id] = meal } }
            } else {
                Text("Review foods").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            let shown = pending.isEmpty ? message.suggestions.filter { $0.output?.approved == true } : included
            Text("\(shown.map(calories).reduce(0, +).formatted()) kcal")
                .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
                .contentTransition(.numericText())
                .accessibilityIdentifier("ai-approval-total")
        }.frame(minHeight: 36)
    }

    private func row(_ suggestion: FoodSuggestion) -> some View {
        let food = suggestion.food
        let decided = suggestion.output != nil
        let off = excluded.contains(suggestion.id) || suggestion.output?.approved == false
        return HStack(alignment: .top, spacing: 10) {
            checkbox(suggestion).padding(.top, -6)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(food.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.label).lineLimit(2)
                            .strikethrough(suggestion.output?.approved == false, color: .secondary)
                        let meta = [food.sourceLabel, food.brand, food.serving].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                        if !meta.isEmpty { Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        MacroLine(nutrition: food.nutrition, multiplier: Portion.sanitize(portion(suggestion))).padding(.top, 1)
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 6) {
                        (Text(calories(suggestion).formatted()).font(.subheadline.weight(.bold)) + Text(" kcal").font(.caption).foregroundColor(.secondary))
                            .monospacedDigit().contentTransition(.numericText()).foregroundStyle(Theme.label)
                        if suggestion.output == nil && !excluded.contains(suggestion.id) { stepper(suggestion) }
                    }
                }
                if let output = suggestion.output {
                    if output.approved {
                        Text("\(suggestion.meal.label) · \(Portion.label(suggestion.portion))")
                            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            .accessibilityIdentifier("ai-suggestion-status")
                    }
                } else if !excluded.contains(suggestion.id) {
                    if sharedMeal == nil { mealMenu(meal(suggestion), label: "Meal") { meals[suggestion.id] = $0 }.padding(.top, 2) }
                    if !suggestion.reason.isEmpty {
                        Text(suggestion.reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                    }
                }
            }
        }
        .padding(.leading, 6).padding(.trailing, 14).padding(.vertical, 10)
        .opacity(off ? 0.5 : decided ? 0.85 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ai-suggestion")
    }

    @ViewBuilder private func checkbox(_ suggestion: FoodSuggestion) -> some View {
        if let output = suggestion.output {
            Image(systemName: output.approved ? "checkmark.circle.fill" : "minus.circle")
                .font(.system(size: 22)).foregroundStyle(output.approved ? Color.green : Color.secondary)
                .frame(width: 44, height: 44).accessibilityLabel(output.approved ? "Added" : "Skipped")
        } else {
            let on = !excluded.contains(suggestion.id)
            Button {
                if on { excluded.insert(suggestion.id) } else { excluded.remove(suggestion.id) }
                UISelectionFeedbackGenerator().selectionChanged()
            } label: {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(on ? Theme.tint : Color.secondary.opacity(0.6))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(chat.streaming)
                .accessibilityLabel("Include \(suggestion.food.name)").accessibilityValue(on ? "On" : "Off")
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("ai-suggestion-toggle")
        }
    }

    private var actions: some View {
        let total = included.map(calories).reduce(0, +)
        return HStack(spacing: 8) {
            Button(action: skipAll) {
                Text("Skip").font(.subheadline.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 2)
            }.nativeActionStyle().controlSize(.large).tint(.secondary).foregroundStyle(Theme.label)
                .accessibilityLabel(pending.count == 1 ? "Skip this food" : "Skip all foods")
                .accessibilityIdentifier("ai-skip-all")
            Button(action: addIncluded) {
                Text(included.isEmpty ? "Add" : included.count == 1 && pending.count == 1 ? "Add · \(total.formatted()) kcal" : "Add \(included.count) · \(total.formatted()) kcal")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                    .contentTransition(.numericText())
            }.nativeActionStyle(prominent: true).controlSize(.large).tint(Theme.tint).foregroundStyle(Theme.onTint)
                .disabled(included.isEmpty)
                .accessibilityIdentifier("ai-approve-all")
        }.disabled(chat.streaming)
    }

    private func stepper(_ suggestion: FoodSuggestion) -> some View {
        let value = Portion.sanitize(portion(suggestion))
        return HStack(spacing: 0) {
            stepButton("minus", label: "Decrease portion", disabled: value <= 0.25) { setPortion(suggestion, value - 0.25) }
            Text(Portion.mixed(value)).font(.footnote.weight(.bold)).monospacedDigit().contentTransition(.numericText())
                .frame(minWidth: 40).lineLimit(1)
            stepButton("plus", label: "Increase portion", disabled: value >= 20) { setPortion(suggestion, value + 0.25) }
        }.background(Theme.input, in: Capsule())
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Portion, \(Portion.label(value))")
            .accessibilityIdentifier("ai-portion-stepper")
    }

    private func stepButton(_ symbol: String, label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .bold)).frame(width: 34, height: 32)
                .foregroundStyle(disabled ? Color.secondary : Theme.tint).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(disabled || chat.streaming).accessibilityLabel(label)
            .buttonRepeatBehavior(.enabled)
    }

    private func mealMenu(_ selected: Meal, label: String, select: @escaping (Meal) -> Void) -> some View {
        Menu {
            Picker(label, selection: Binding(get: { selected }, set: select)) {
                ForEach(Meal.allCases) { meal in Label(meal.label, systemImage: meal.symbol).tag(meal) }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: selected.symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.tint)
                Text(selected.label).font(.footnote.weight(.semibold)).foregroundStyle(Theme.label)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            }.padding(.horizontal, 10).frame(height: 32).background(Theme.input, in: Capsule())
        }.disabled(chat.streaming)
            .accessibilityLabel("\(label), \(selected.label)").accessibilityIdentifier("ai-meal-picker")
    }

    private func setPortion(_ suggestion: FoodSuggestion, _ value: Double) {
        let next = min(20, Portion.sanitize(value))
        guard next != Portion.sanitize(portion(suggestion)) else { return }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.15)) { portions[suggestion.id] = next }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func skipAll() {
        for suggestion in pending {
            chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: false, store: store)
        }
    }

    private func addIncluded() {
        var added = false
        for suggestion in pending {
            let approved = !excluded.contains(suggestion.id)
            let saved = chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: approved, store: store,
                                     portion: portion(suggestion), meal: meal(suggestion))
            added = (saved && approved) || added
        }
        if added { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }
}

/// "P 12g · C 30g · F 8g" with the macro colors as small dots.
private struct MacroLine: View {
    let nutrition: Nutrition?
    let multiplier: Double
    var body: some View {
        let n = nutrition?.multiplied(by: multiplier)
        HStack(spacing: 10) {
            if let v = n?.protein { item("P", v, Theme.protein) }
            if let v = n?.carbs { item("C", v, Theme.carbs) }
            if let v = n?.fat { item("F", v, Theme.fat) }
        }.accessibilityElement(children: .combine)
    }
    private func item(_ letter: String, _ value: Double, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text("\(letter) \(grams(value, whole: true))").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
        }
    }
}

extension Meal {
    var symbol: String {
        switch self {
        case .breakfast: "sunrise.fill"
        case .lunch: "sun.max.fill"
        case .dinner: "moon.stars.fill"
        case .snacks: "carrot.fill"
        }
    }
}

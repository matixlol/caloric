import SwiftUI

/// Editable suggestions: adjust the portion and meal, then Add, Skip or Add all.
struct AssistantApprovalCard: View {
    let message: ChatMessage
    let chat: AILogService
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var portions: [String: Double] = [:]
    @State private var meals: [String: Meal] = [:]

    private var pending: [FoodSuggestion] { message.suggestions.filter { $0.output == nil } }
    private func portion(_ s: FoodSuggestion) -> Double { s.output == nil ? portions[s.id] ?? s.portion : s.portion }
    private func meal(_ s: FoodSuggestion) -> Meal { s.output == nil ? meals[s.id] ?? s.meal : s.meal }
    private func calories(_ s: FoodSuggestion) -> Int { Int(((s.food.nutrition?.calories ?? 0) * Portion.sanitize(portion(s))).rounded()) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(pending.isEmpty ? "Reviewed" : pending.count == 1 ? "Review 1 food" : "Review \(pending.count) foods")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                let shown = pending.isEmpty ? message.suggestions.filter { $0.output?.approved == true } : pending
                Text("\(shown.map(calories).reduce(0, +).formatted()) kcal total")
                    .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .accessibilityIdentifier("ai-approval-total")
            }.padding(.horizontal, 4)
            ForEach(message.suggestions) { suggestion in row(suggestion) }
            if pending.count >= 2 {
                Button(action: addAll) {
                    Label("Add all \(pending.count) · \(pending.map(calories).reduce(0, +).formatted()) kcal", systemImage: "checkmark.circle.fill")
                        .font(.body.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
                        .contentTransition(.numericText())
                }.nativeActionStyle(prominent: true).controlSize(.large).tint(Theme.tint).foregroundStyle(Theme.onTint)
                    .disabled(chat.streaming).accessibilityIdentifier("ai-approve-all")
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: message.suggestions.map { $0.output?.approved })
    }

    private func row(_ suggestion: FoodSuggestion) -> some View {
        let decided = suggestion.output != nil
        let food = suggestion.food
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(food.name).font(.body.weight(.semibold)).foregroundStyle(Theme.label).lineLimit(2)
                    let meta = [food.brand, food.serving].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    HStack(spacing: 5) {
                        if !food.sourceLabel.isEmpty {
                            Text(food.sourceLabel).font(.system(size: 9, weight: .heavy)).foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 2)
                                .background(Theme.input, in: RoundedRectangle(cornerRadius: 4))
                        }
                        if !meta.isEmpty { Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: -2) {
                    Text(calories(suggestion).formatted()).font(.system(.title2, design: .rounded).weight(.bold))
                        .monospacedDigit().contentTransition(.numericText()).foregroundStyle(Theme.label)
                    Text("kcal").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            }
            MacroBadges(nutrition: Nutrition(protein: food.nutrition?.protein, carbs: food.nutrition?.carbs, fat: food.nutrition?.fat),
                        multiplier: Portion.sanitize(portion(suggestion)), wholeGrams: true)
                .padding(.top, -4)
            if !suggestion.reason.isEmpty {
                Text(suggestion.reason).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let output = suggestion.output {
                HStack(spacing: 6) {
                    Image(systemName: output.approved ? "checkmark.circle.fill" : "minus.circle.fill")
                        .foregroundStyle(output.approved ? Color.green : Color.secondary)
                    Text(output.approved ? "Added to \(suggestion.meal.label) · \(Portion.label(suggestion.portion))" : "Skipped")
                        .font(.footnote.weight(.semibold)).foregroundStyle(output.approved ? Theme.label : Color.secondary)
                }.accessibilityElement(children: .combine).accessibilityIdentifier("ai-suggestion-status")
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { stepper(suggestion); Spacer(minLength: 0); mealMenu(suggestion) }
                    VStack(alignment: .leading, spacing: 8) { stepper(suggestion); mealMenu(suggestion) }
                }
                HStack(spacing: 8) {
                    Button { decide(suggestion, approved: false) } label: {
                        Text("Skip").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                    }.nativeActionStyle().controlSize(.regular).tint(.secondary).foregroundStyle(Theme.label)
                    Button { decide(suggestion, approved: true) } label: {
                        Label("Add", systemImage: "plus").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                    }.nativeActionStyle(prominent: true).controlSize(.regular).tint(Theme.tint).foregroundStyle(Theme.onTint)
                        .accessibilityLabel("Add \(food.name) to \(meal(suggestion).label)")
                        .accessibilityIdentifier("ai-approve")
                }.disabled(chat.streaming)
            }
        }
        .padding(14)
        .background(Theme.card.opacity(decided ? 0.55 : 0.92), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.separator.opacity(0.5), lineWidth: 0.5))
        .opacity(suggestion.output?.approved == false ? 0.7 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ai-suggestion")
    }

    private func stepper(_ suggestion: FoodSuggestion) -> some View {
        let value = Portion.sanitize(portion(suggestion))
        return HStack(spacing: 2) {
            stepButton("minus", label: "Decrease portion", disabled: value <= 0.25) { setPortion(suggestion, value - 0.25) }
            VStack(spacing: -1) {
                Text(Portion.mixed(value)).font(.subheadline.weight(.bold)).monospacedDigit().contentTransition(.numericText())
                Text(value == 1 ? "portion" : "portions").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            }.frame(minWidth: 58).lineLimit(1)
            stepButton("plus", label: "Increase portion", disabled: value >= 20) { setPortion(suggestion, value + 0.25) }
        }.padding(3).background(Theme.input, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Portion").accessibilityValue(Portion.label(value))
            .accessibilityAdjustableAction { direction in setPortion(suggestion, value + (direction == .increment ? 0.25 : -0.25)) }
            .accessibilityIdentifier("ai-portion-stepper")
    }

    private func stepButton(_ symbol: String, label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .bold)).frame(width: 34, height: 34)
                .background(Theme.card, in: Circle()).foregroundStyle(disabled ? Color.secondary : Theme.tint)
        }.buttonStyle(.plain).disabled(disabled || chat.streaming).accessibilityLabel(label)
            .buttonRepeatBehavior(.enabled)
    }

    private func mealMenu(_ suggestion: FoodSuggestion) -> some View {
        Menu {
            Picker("Meal", selection: Binding(get: { meal(suggestion) }, set: { meals[suggestion.id] = $0 })) {
                ForEach(Meal.allCases) { meal in Label(meal.label, systemImage: meal.symbol).tag(meal) }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: meal(suggestion).symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.tint)
                Text(meal(suggestion).label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.label)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
            }.padding(.horizontal, 12).frame(height: 40).background(Theme.input, in: Capsule())
        }.disabled(chat.streaming)
            .accessibilityLabel("Meal, \(meal(suggestion).label)").accessibilityIdentifier("ai-meal-picker")
    }

    private func setPortion(_ suggestion: FoodSuggestion, _ value: Double) {
        let next = min(20, Portion.sanitize(value))
        guard next != Portion.sanitize(portion(suggestion)) else { return }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.15)) { portions[suggestion.id] = next }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func decide(_ suggestion: FoodSuggestion, approved: Bool) {
        let saved = chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: approved, store: store,
                                 portion: portion(suggestion), meal: meal(suggestion))
        if saved && approved { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }

    private func addAll() {
        var added = false
        for suggestion in pending {
            added = chat.approve(messageID: message.id, suggestionID: suggestion.id, approved: true, store: store,
                                 portion: portion(suggestion), meal: meal(suggestion)) || added
        }
        if added { UINotificationFeedbackGenerator().notificationOccurred(.success) }
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

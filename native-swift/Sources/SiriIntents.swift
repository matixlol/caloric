import AppIntents
import Foundation

/// Errors Siri reads to the user verbatim.
struct SiriIntentError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum SiriServingUnit: String, AppEnum {
    case portions, grams
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Serving unit")
    static var caseDisplayRepresentations: [SiriServingUnit: DisplayRepresentation] = [
        .portions: DisplayRepresentation(title: "Portions"),
        .grams: DisplayRepresentation(title: "Grams"),
    ]
}

enum SiriNutrient: String, AppEnum {
    case calories, protein, carbs, fat
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Nutrient")
    static var caseDisplayRepresentations: [SiriNutrient: DisplayRepresentation] = [
        .calories: DisplayRepresentation(title: "Calories"),
        .protein: DisplayRepresentation(title: "Protein"),
        .carbs: DisplayRepresentation(title: "Carbs"),
        .fat: DisplayRepresentation(title: "Fat"),
    ]
}

/// Pure rules shared by the Siri intents and their tests. All the diary writes go through
/// the app's `AppStore` when the running process has one, or the same SQLite database when
/// a background launch has not built one yet, so both paths keep the app's invariants.
enum SiriLog {
    static func normalize(_ text: String) -> String {
        var result = ""
        var spaced = true
        for character in text.lowercased() {
            if character.isLetter || character.isNumber {
                result.append(character); spaced = false
            } else if !spaced {
                result.append(" "); spaced = true
            }
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    /// The meal a new entry belongs to at the given local time.
    static func meal(for date: Date = Date(), calendar: Calendar = .current) -> Meal {
        let hour = Double(calendar.component(.hour, from: date))
            + Double(calendar.component(.minute, from: date)) / 60
        if hour < 11 { return .breakfast }
        if hour < 15.5 { return .lunch }
        if hour < 21 { return .dinner }
        return .snacks
    }

    /// The first gram weight in a serving label such as "100 g", "1 container (150 g)" or "30 grams".
    /// Scanned by hand: regex literals hit lexer quirks in current beta toolchains.
    static func grams(in serving: String?) -> Double? {
        guard let serving else { return nil }
        let text = Array(serving.lowercased())
        var index = 0
        while index < text.count {
            guard text[index].isNumber else { index += 1; continue }
            var end = index
            while end < text.count, text[end].isNumber { end += 1 }
            // Optional decimal fraction: a separator with at least one digit after it.
            if end + 1 < text.count, text[end] == "." || text[end] == ",", text[end + 1].isNumber {
                end += 2
                while end < text.count, text[end].isNumber { end += 1 }
            }
            var cursor = end
            while cursor < text.count, text[cursor] == " " { cursor += 1 }
            if cursor < text.count, text[cursor] == "g" {
                let after = text[(cursor + 1)...]
                let unit = after.isEmpty || !after[after.startIndex].isLetter || after.starts(with: "ram")
                if unit, let value = Double(text[index ..< end].map(String.init).joined().replacing(",", with: ".")),
                   value.isFinite, value > 0 { return value }
            }
            index = max(end, index + 1)
        }
        return nil
    }

    /// Splits an utterance such as "30 grams of oats", "2 portions of oats" or "oats" into an
    /// amount, a unit and the food name. Siri phrases cannot interpolate String parameters, so
    /// the whole elicited answer arrives here. Decimal amounts (rare by voice) fall through to
    /// the food name with their quantity words dropped.
    static func parseSpoken(_ text: String) -> (amount: Double?, unit: SiriServingUnit, name: String) {
        var words = normalize(text).split(separator: " ").map(String.init)
        // "30g" and "30grams" arrive glued when punctuation never separated them.
        for index in words.indices.reversed() {
            if let match = words[index].firstMatch(of: /^([0-9]+)(g(rams?)?)$/) {
                words.replaceSubrange(index...index, with: [String(match.1), String(match.2)])
            }
        }
        if words.count >= 2, let amount = Double(words[0]), amount > 0 {
            let gramUnit = ["g", "gram", "grams"].contains(words[1])
            let portionUnit = ["portion", "portions", "serving", "servings"].contains(words[1])
            if gramUnit || portionUnit {
                var rest = words.dropFirst(2)
                if rest.first == "of" { rest = rest.dropFirst() }
                let name = rest.joined(separator: " ")
                if !name.isEmpty { return (amount, gramUnit ? .grams : .portions, name) }
            }
        }
        let quantityWords = ["g", "gram", "grams", "portion", "portions", "serving", "servings", "of"]
        while let first = words.first, Double(first) != nil || quantityWords.contains(first) { words.removeFirst() }
        return (nil, .portions, words.joined(separator: " "))
    }

    /// Best local entry for a spoken food name: exact name, then prefix, then containment, newest first.
    static func bestMatch(for query: String, in rows: [FoodRecord]) -> FoodRecord? {
        let query = normalize(query)
        guard !query.isEmpty else { return nil }
        var best: (row: FoodRecord, score: Int)?
        for row in rows where !row.data.isQuickAdd {
            let name = normalize(row.data.foodName)
            guard name.contains(query) else { continue }
            let score = name == query ? 0 : (name.hasPrefix(query) ? 1 : 2)
            if let current = best, score > current.score { continue }
            if let current = best, score == current.score, row.data.createdAt <= current.row.data.createdAt { continue }
            best = (row, score)
        }
        return best?.row
    }

    /// A reusable search result shaped like the app's recents rows.
    static func food(from row: FoodRecord) -> SearchFood {
        SearchFood(id: "recent-\(row.id)", canonicalKey: row.id, source: "recent", sourceLabel: "",
                   name: row.data.foodName, brand: row.data.brand, serving: row.data.serving, nutrition: row.data.nutrition)
    }

    /// Entry shape for a spoken amount. Portion amounts reuse the food's serving and the app's
    /// quarter portions; gram amounts bake into the entry's own serving label with exactly scaled
    /// nutrition, so a 40 g request never rounds to a 50 g quarter portion.
    static func resolve(amount: Double?, unit: SiriServingUnit, serving: String?, nutrition: Nutrition?) throws -> (serving: String?, portion: Double, nutrition: Nutrition?) {
        switch unit {
        case .portions:
            return (serving, Portion.sanitize(amount ?? 1), nutrition)
        case .grams:
            guard let amount, amount.isFinite, amount > 0 else { throw SiriIntentError(message: "How many grams should I log?") }
            guard let base = grams(in: serving), base > 0 else {
                throw SiriIntentError(message: "I don't know the gram weight of this food. Log it once in Caloric and Siri will remember the serving.")
            }
            return ("\(String(format: "%g", amount)) g", 1, nutrition?.multiplied(by: amount / base))
        }
    }

    /// A pending entry row built with the same conventions as `AppStore.add`.
    static func makeEntry(after rows: [FoodRecord], food: SearchFood, meal: Meal, portion: Double,
                          day: String = LocalDay.key(), at now: Int64 = LocalDay.milliseconds()) -> FoodRecord {
        let sortIndex = (rows.filter { $0.data.dateKey == day && $0.data.meal == meal && $0.deletedAt == nil }
            .map(\.data.sortIndex).max() ?? -1) + 1
        return FoodRecord(id: "food_entry_\(UUID().uuidString.lowercased())",
                          data: FoodEntry(meal: meal, foodName: food.name, brand: food.brand, serving: food.serving,
                                          portion: Portion.sanitize(portion), nutrition: food.nutrition,
                                          createdAt: now, dateKey: day, sortIndex: sortIndex),
                          updatedAt: now, dirty: true)
    }
}

/// Wording Siri speaks, kept pure for tests.
enum SiriText {
    static func count(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value.rounded())) ?? "\(Int(value.rounded()))"
    }

    static func logged(name: String, portion: Double, gramAmount: Double?, meal: Meal, nutrition: Nutrition?, today: Double, goal: Double) -> String {
        let description = gramAmount.map { "\(count($0)) g of \(name)" } ?? "\(Portion.label(portion)) of \(name)"
        var sentence = "Logged \(description) to \(meal.label), \(count(nutrition?.calories ?? 0)) kcal."
        if goal > 0 { sentence += " You're at \(count(today)) of \(count(goal)) kcal today." }
        return sentence
    }

    static func loggedCalories(_ calories: Double, meal: Meal, today: Double, goal: Double) -> String {
        var sentence = "Logged \(count(calories)) calories to \(meal.label)."
        if goal > 0 { sentence += " You're at \(count(today)) of \(count(goal)) kcal today." }
        return sentence
    }

    static func totals(_ nutrition: Nutrition, settings: UserSettings) -> String {
        "Today you're at \(count(nutrition.calories ?? 0)) of \(count(Double(settings.calorieGoal))) kcal, "
            + "protein \(count(nutrition.protein ?? 0)) of \(count(Double(settings.proteinGoal))) g, "
            + "carbs \(count(nutrition.carbs ?? 0)) of \(count(Double(settings.carbsGoal))) g, "
            + "fat \(count(nutrition.fat ?? 0)) of \(count(Double(settings.fatGoal))) g."
    }

    static func nutrient(_ nutrient: SiriNutrient, nutrition: Nutrition, settings: UserSettings) -> String {
        switch nutrient {
        case .calories:
            let goal = Double(settings.calorieGoal)
            return goal > 0
                ? "You've logged \(count(nutrition.calories ?? 0)) of \(count(goal)) kcal today."
                : "You've logged \(count(nutrition.calories ?? 0)) kcal today."
        case .protein: return remaining(nutrition.protein, goal: Double(settings.proteinGoal), name: "protein")
        case .carbs: return remaining(nutrition.carbs, goal: Double(settings.carbsGoal), name: "carbs")
        case .fat: return remaining(nutrition.fat, goal: Double(settings.fatGoal), name: "fat")
        }
    }

    private static func remaining(_ value: Double?, goal: Double, name: String) -> String {
        let logged = count(value ?? 0)
        guard goal > 0 else { return "You've logged \(logged) g of \(name) today." }
        let left = max(0, goal - (value ?? 0))
        return left <= 0 ? "You've hit your \(name) goal — \(logged) g today."
            : "You've logged \(logged) g of \(name) today, \(count(left)) g to go."
    }
}

/// Reads the diary through the live store when this process has one, or the same
/// per-account SQLite database when a background Siri launch has not built one yet.
@MainActor
enum SiriDiary {
    static func load() throws -> (entries: [FoodRecord], settings: UserSettings) {
        if let store = AppStore.active, store.ready, store.userID != nil {
            return (store.entries, store.settings)
        }
        guard let userID = NativeAuth.shared.user?.id else {
            throw SiriIntentError(message: "Open Caloric and sign in first.")
        }
        return try read(userID: userID)
    }

    static func read(userID: String) throws -> (entries: [FoodRecord], settings: UserSettings) {
        let database = try SQLiteStore(url: AppStore.databaseURL(userID: userID))
        let rows = try database.loadEntries().filter { $0.deletedAt == nil }
        let settings = (try database.loadSettings())?.data ?? UserSettings()
        return (rows, settings)
    }

    /// Writes through the live store (which syncs and updates the widget), or directly into
    /// the database with a dirty row the app syncs on its next launch.
    static func append(_ food: SearchFood, meal: Meal, portion: Double) throws -> FoodRecord {
        if let store = AppStore.active, store.ready, store.userID != nil {
            return try store.add(food: food, meal: meal, portion: portion)
        }
        guard let userID = NativeAuth.shared.user?.id else {
            throw SiriIntentError(message: "Open Caloric and sign in first.")
        }
        let database = try SQLiteStore(url: AppStore.databaseURL(userID: userID))
        let rows = try database.loadEntries()
        let row = SiriLog.makeEntry(after: rows, food: food, meal: meal, portion: portion)
        try database.save(row)
        let day = LocalDay.key()
        let today = rows.filter { $0.data.dateKey == day && $0.deletedAt == nil } + [row]
        WidgetSnapshot.write(nutrition: Nutrition.total(today), settings: (try database.loadSettings())?.data ?? UserSettings())
        return row
    }

    static func todayTotals(from diary: (entries: [FoodRecord], settings: UserSettings)) -> (Nutrition, UserSettings) {
        (Nutrition.total(diary.entries.filter { $0.data.dateKey == LocalDay.key() }), diary.settings)
    }
}

struct LogFoodIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Food"
    static let description = IntentDescription("Adds a food to today's diary, reusing what you logged before or searching MyFitnessPal and Open Food Facts.")

    @Parameter(title: "Food", requestValueDialog: IntentDialog("Which food should I log?")) var foodName: String
    @Parameter(title: "Amount") var amount: Double?
    @Parameter(title: "Unit") var unit: SiriServingUnit?

    static var parameterSummary: some ParameterSummary { Summary("Log \(\.$foodName)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: try await SiriIntents.logFood(spoken: foodName, amount: amount, unit: unit)))
    }
}

struct LogCaloriesIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Calories"
    static let description = IntentDescription("Quick-adds calories to today's diary using your macro split.")

    @Parameter(title: "Calories", requestValueDialog: IntentDialog("How many calories?")) var calories: Double

    static var parameterSummary: some ParameterSummary { Summary("Log \(\.$calories) calories") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: try await SiriIntents.logCalories(calories)))
    }
}

struct TodayTotalsIntent: AppIntent {
    static let title: LocalizedStringResource = "Today's Totals"
    static let description = IntentDescription("Speaks today's calories and macros against your goals.")

    @Parameter(title: "Nutrient") var nutrient: SiriNutrient?

    static var parameterSummary: some ParameterSummary { Summary("Show \(\.$nutrient) for today") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: try await SiriIntents.totals(nutrient: nutrient)))
    }
}

/// The intent bodies; every branch reports through `IntentDialog` text the tests cover via `SiriText`.
@MainActor
enum SiriIntents {
    static func logFood(spoken: String, amount: Double?, unit: SiriServingUnit?) async throws -> String {
        let parsed = SiriLog.parseSpoken(spoken)
        let name = parsed.name
        guard !name.isEmpty else { throw SiriIntentError(message: "Which food should I log?") }
        let resolvedAmount = amount ?? parsed.amount
        let resolvedUnit = unit ?? parsed.unit
        if let resolvedAmount, !(resolvedAmount.isFinite && resolvedAmount > 0 && resolvedAmount <= 100000) {
            throw SiriIntentError(message: "Use an amount between 0 and 100,000.")
        }
        let meal = SiriLog.meal()
        let diary = try SiriDiary.load()

        let food: SearchFood
        if let match = SiriLog.bestMatch(for: name, in: diary.entries) {
            food = SiriLog.food(from: match)
        } else {
            // First-time foods resolve through the same search the app's food screen uses.
            let results = try? await APIClient().search(name, provider: "all")
            guard let result = results?.first else {
                throw SiriIntentError(message: "I couldn't find \(name). Add it in Caloric once and Siri will remember it.")
            }
            food = result
        }
        let resolved = try SiriLog.resolve(amount: resolvedAmount, unit: resolvedUnit, serving: food.serving, nutrition: food.nutrition)
        let entry = SearchFood(id: food.id, canonicalKey: food.canonicalKey, source: food.source, sourceLabel: food.sourceLabel,
                               name: food.name, brand: food.brand, serving: resolved.serving, nutrition: resolved.nutrition)
        let row = try SiriDiary.append(entry, meal: meal, portion: resolved.portion)
        let (totals, settings) = SiriDiary.todayTotals(from: try SiriDiary.load())
        let gramAmount: Double? = resolvedUnit == .grams ? resolvedAmount : nil
        return SiriText.logged(name: row.data.foodName, portion: row.data.portion, gramAmount: gramAmount, meal: meal,
                               nutrition: row.data.nutrition?.multiplied(by: row.data.portion),
                               today: totals.calories ?? 0, goal: Double(settings.calorieGoal))
    }

    static func logCalories(_ spoken: Double) async throws -> String {
        guard let calories = QuickAdd.calories("\(spoken)") else {
            throw SiriIntentError(message: "Calories must be between 1 and 10,000.")
        }
        let meal = SiriLog.meal()
        let diary = try SiriDiary.load()
        let food = SearchFood(id: "quick", canonicalKey: "quick", source: "manual", sourceLabel: "",
                              name: "Quick add", serving: "Manual entry",
                              nutrition: QuickAdd.nutrition(calories: calories, split: diary.settings))
        let row = try SiriDiary.append(food, meal: meal, portion: 1)
        let (totals, settings) = SiriDiary.todayTotals(from: try SiriDiary.load())
        return SiriText.loggedCalories(calories, meal: meal, today: totals.calories ?? 0, goal: Double(settings.calorieGoal))
    }

    static func totals(nutrient: SiriNutrient?) async throws -> String {
        let (nutrition, settings) = SiriDiary.todayTotals(from: try SiriDiary.load())
        return nutrient.map { SiriText.nutrient($0, nutrition: nutrition, settings: settings) }
            ?? SiriText.totals(nutrition, settings: settings)
    }
}

struct CaloricAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: LogFoodIntent(),
                    phrases: [
                        "Log food in \(.applicationName)",
                        "Add food in \(.applicationName)",
                    ],
                    shortTitle: "Log Food",
                    systemImageName: "fork.knife")
        AppShortcut(intent: LogCaloriesIntent(),
                    phrases: [
                        "Log calories in \(.applicationName)",
                    ],
                    shortTitle: "Log Calories",
                    systemImageName: "flame.fill")
        AppShortcut(intent: TodayTotalsIntent(),
                    phrases: [
                        "What's my \(\.$nutrient) in \(.applicationName)",
                        "Show my \(.applicationName) totals",
                    ],
                    shortTitle: "Today's Totals",
                    systemImageName: "chart.bar.fill")
    }
}

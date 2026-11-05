import Foundation

enum Meal: String, Codable, CaseIterable, Identifiable {
    case breakfast, lunch, dinner, snacks
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var emptyCopy: String { "No \(rawValue) entries yet." }
}

struct Nutrition: Codable, Equatable {
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugars: Double?
    var sodiumMg: Double?
    var potassiumMg: Double?

    func multiplied(by portion: Double) -> Nutrition {
        Nutrition(calories: calories.map { $0 * portion }, protein: protein.map { $0 * portion },
                  carbs: carbs.map { $0 * portion }, fat: fat.map { $0 * portion },
                  fiber: fiber.map { $0 * portion }, sugars: sugars.map { $0 * portion },
                  sodiumMg: sodiumMg.map { $0 * portion }, potassiumMg: potassiumMg.map { $0 * portion })
    }
    static func total(_ entries: [FoodRecord]) -> Nutrition {
        entries.reduce(Nutrition(calories: 0, protein: 0, carbs: 0, fat: 0)) { sum, entry in
            let n = entry.data.nutrition?.multiplied(by: entry.data.portion)
            return Nutrition(calories: (sum.calories ?? 0) + (n?.calories ?? 0),
                             protein: (sum.protein ?? 0) + (n?.protein ?? 0),
                             carbs: (sum.carbs ?? 0) + (n?.carbs ?? 0), fat: (sum.fat ?? 0) + (n?.fat ?? 0))
        }
    }
}

struct FoodEntry: Codable, Equatable {
    var meal: Meal
    var foodName: String
    var brand: String?
    var serving: String?
    var portion: Double
    var nutrition: Nutrition?
    var createdAt: Int64
    var dateKey: String
    var sortIndex: Double
    var recipeId: String?
    var recipeItems: [RecipeItem]?
    var meta: String { [Portion.label(portion), brand, serving].compactMap { $0 }.joined(separator: " • ") }
}

struct RecipeItem: Codable, Equatable {
    var id: String
    var foodName: String
    var brand: String?
    var serving: String?
    var portion: Double
    var nutrition: Nutrition?
}

struct Recipe: Codable, Equatable {
    var name: String
    var items: [RecipeItem]
    var createdAt: Int64
    var nutrition: Nutrition { Nutrition.aggregate(items) }
}

struct RecipeRecord: Codable, Identifiable, Equatable {
    var id: String
    var data: Recipe
    var updatedAt: Int64
    var deletedAt: Int64?
    var dirty = false
    enum CodingKeys: String, CodingKey { case id, data, updatedAt, deletedAt }
}

extension Nutrition {
    static func aggregate(_ items: [RecipeItem]) -> Nutrition {
        var result = Nutrition()
        for key in [\Nutrition.calories, \.protein, \.carbs, \.fat, \.fiber, \.sugars, \.sodiumMg, \.potassiumMg] {
            let values = items.compactMap { item in item.nutrition?[keyPath: key].map { $0 * Portion.sanitize(item.portion) } }
            result[keyPath: key] = values.isEmpty ? nil : values.reduce(0, +)
        }
        return result
    }
    var hasCalorieMismatch: Bool {
        guard let calories, let protein, let carbs, let fat,
              [calories, protein, carbs, fat].allSatisfy(\.isFinite), calories > 0 else { return false }
        return abs(protein * 4 + carbs * 4 + fat * 9 - calories) / calories > 0.15
    }
}

enum QuickAdd {
    static func calories(_ text: String) -> Double? {
        guard let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite, value > 0, value <= 10000 else { return nil }
        return value.rounded()
    }
    /// Grams of a macro that supply `percent` of `calories`, at 4 kcal/g (protein, carbs) or 9 kcal/g (fat).
    static func grams(_ calories: Double, percent: Int, kcalPerGram: Double) -> Double {
        (calories * Double(percent) / 100 / kcalPerGram * 10).rounded() / 10
    }
    static func nutrition(calories: String, split: UserSettings) -> Nutrition? {
        guard let value = Self.calories(calories) else { return nil }
        return Nutrition(calories: value, protein: grams(value, percent: split.macroProteinPct, kcalPerGram: 4),
                         carbs: grams(value, percent: split.macroCarbsPct, kcalPerGram: 4), fat: grams(value, percent: split.macroFatPct, kcalPerGram: 9))
    }
    /// The calorie split an existing entry's macros imply, falling back to the user's daily ratios when it has none.
    static func split(of nutrition: Nutrition?, fallback: UserSettings) -> UserSettings {
        let energy = [(nutrition?.protein ?? 0) * 4, (nutrition?.carbs ?? 0) * 4, (nutrition?.fat ?? 0) * 9].map { max(0, $0) }
        let total = energy.reduce(0, +)
        guard total > 0 else { return fallback }
        let exact = energy.map { $0 / total * 100 }
        var percents = exact.map { Int($0) }
        for i in exact.indices.sorted(by: { exact[$0] - Double(percents[$0]) > exact[$1] - Double(percents[$1]) }).prefix(100 - percents.reduce(0, +)) { percents[i] += 1 }
        var split = fallback
        (split.macroProteinPct, split.macroCarbsPct, split.macroFatPct) = (percents[0], percents[1], percents[2])
        return split
    }
}

extension FoodEntry { var isQuickAdd: Bool { foodName == "Quick add" && serving == "Manual entry" } }

struct FoodRecord: Codable, Identifiable, Equatable {
    var id: String
    var data: FoodEntry
    var updatedAt: Int64
    var deletedAt: Int64?
    var dirty = false
    enum CodingKeys: String, CodingKey { case id, data, updatedAt, deletedAt }
}

struct UserSettings: Codable, Equatable {
    var calorieGoal = 2500
    var macroProteinPct = 30
    var macroCarbsPct = 50
    var macroFatPct = 20
    var proteinGoal: Int { Int((Double(calorieGoal * macroProteinPct) / 400).rounded()) }
    var carbsGoal: Int { Int((Double(calorieGoal * macroCarbsPct) / 400).rounded()) }
    var fatGoal: Int { Int((Double(calorieGoal * macroFatPct) / 900).rounded()) }
    var isValid: Bool {
        (100...10000).contains(calorieGoal) && [macroProteinPct, macroCarbsPct, macroFatPct].allSatisfy { (0...100).contains($0) }
        && macroProteinPct + macroCarbsPct + macroFatPct == 100
    }
}

struct SettingsRecord: Codable {
    var id = "settings"
    var data: UserSettings
    var updatedAt: Int64
    var dirty = false
    enum CodingKeys: String, CodingKey { case id, data, updatedAt }
}

struct BootstrapResponse: Decodable {
    var foodEntries: [FoodRecord]
    var settings: SettingsRecord?
    var recipes: [RecipeRecord] = []
    enum CodingKeys: String, CodingKey { case foodEntries, settings, recipes }
    init(foodEntries: [FoodRecord], settings: SettingsRecord?, recipes: [RecipeRecord] = []) {
        self.foodEntries = foodEntries; self.settings = settings; self.recipes = recipes
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        foodEntries = try values.decode([FoodRecord].self, forKey: .foodEntries)
        settings = try values.decodeIfPresent(SettingsRecord.self, forKey: .settings)
        recipes = try values.decodeIfPresent([RecipeRecord].self, forKey: .recipes) ?? []
    }
}
struct PushRequest: Encodable { var foodEntries: [FoodRecord]; var settings: SettingsRecord?; var recipes: [RecipeRecord] = [] }
struct PushResponse: Decodable {
    var acceptedFoodEntryIds: [String]
    var acceptedSettings: Bool
    var acceptedRecipeIds: [String] = []
    enum CodingKeys: String, CodingKey { case acceptedFoodEntryIds, acceptedSettings, acceptedRecipeIds }
    init(acceptedFoodEntryIds: [String], acceptedSettings: Bool, acceptedRecipeIds: [String] = []) {
        self.acceptedFoodEntryIds = acceptedFoodEntryIds; self.acceptedSettings = acceptedSettings; self.acceptedRecipeIds = acceptedRecipeIds
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        acceptedFoodEntryIds = try values.decode([String].self, forKey: .acceptedFoodEntryIds)
        acceptedSettings = try values.decode(Bool.self, forKey: .acceptedSettings)
        acceptedRecipeIds = try values.decodeIfPresent([String].self, forKey: .acceptedRecipeIds) ?? []
    }
}

struct SearchFood: Codable, Identifiable, Equatable {
    var id: String
    var canonicalKey: String
    var source: String
    var sourceLabel: String
    var name: String
    var brand: String?
    var serving: String?
    var nutrition: Nutrition?
    var resultId: String?
    /// MyFitnessPal's verified (official) entries; absent for everything else.
    var verified: Bool? = nil
    var meta: String { [brand, serving].compactMap { $0 }.joined(separator: " • ") }
}
struct SearchResponse: Decodable { var foods: [SearchFood]; var hasMore: Bool? }

enum Portion {
    static func sanitize(_ value: Double) -> Double { value.isFinite ? max(0.25, (value * 4).rounded() / 4) : 1 }
    static func mixed(_ value: Double) -> String {
        let p = sanitize(value), whole = Int(p), quarter = Int((p - Double(whole)) * 4)
        let fraction = ["", "1/4", "1/2", "3/4"][quarter]
        return quarter == 0 ? "\(whole)" : whole > 0 ? "\(whole) \(fraction)" : fraction
    }
    static func label(_ value: Double) -> String { "\(mixed(value)) \(sanitize(value) == 1 ? "portion" : "portions")" }
}

enum LocalDay {
    static func key(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
    static func shifted(_ offset: Int) -> Date { Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date() }
    static func milliseconds(_ date: Date = Date()) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
}

enum AppConfiguration {
    static var backendURL: URL {
        URL(string: Bundle.main.object(forInfoDictionaryKey: "CaloricBackendURL") as? String ?? "")
            ?? URL(string: "https://backend.caloric.mati.lol")!
    }
    static var uiTesting: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-ui-testing")
        #else
        false
        #endif
    }
}

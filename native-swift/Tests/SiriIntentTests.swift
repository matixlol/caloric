import XCTest
@testable import CaloricSwift

final class SiriIntentTests: XCTestCase {
    private func date(_ hour: Int, _ minute: Int = 0) -> (Date, Calendar) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let components = DateComponents(year: 2026, month: 11, day: 21, hour: hour, minute: minute)
        return (calendar.date(from: components)!, calendar)
    }

    private func record(_ name: String, nutrition: Nutrition? = Nutrition(calories: 100, protein: 10, carbs: 10, fat: 5),
                       serving: String? = nil, portion: Double = 1, createdAt: Int64 = 0, day: String = "2026-11-21") -> FoodRecord {
        FoodRecord(id: "food_entry_\(name)", data: FoodEntry(meal: .lunch, foodName: name, brand: nil, serving: serving,
            portion: portion, nutrition: nutrition, createdAt: createdAt, dateKey: day, sortIndex: 0), updatedAt: 0)
    }

    func testMealFollowsLocalTimeOfDay() {
        let (morning, calendar) = date(10, 59)
        let (midday, _) = date(11)
        let (afternoon, _) = date(15, 29)
        let (evening, _) = date(15, 30)
        let (night, _) = date(21)
        XCTAssertEqual([morning, midday, afternoon, evening, night].map { SiriLog.meal(for: $0, calendar: calendar) },
                       [.breakfast, .lunch, .lunch, .dinner, .snacks])
    }

    func testGramWeightsParseFromServingLabels() {
        XCTAssertEqual(["100 g", "100g", "30 grams", "1 container (150 g)", "2.5 G", "1,5 g"].map { SiriLog.grams(in: $0) },
                       [100, 100, 30, 150, 2.5, 1.5])
        XCTAssertNil(SiriLog.grams(in: "1 cup"))
        XCTAssertNil(SiriLog.grams(in: "1 large"))
        XCTAssertNil(SiriLog.grams(in: nil))
        XCTAssertNil(SiriLog.grams(in: "0 g"))
    }

    func testParseSpokenExtractsAmountUnitAndName() {
        XCTAssertEqual(SiriLog.parseSpoken("30 grams of oats").amount, 30)
        XCTAssertEqual(SiriLog.parseSpoken("30 grams of oats").unit, .grams)
        XCTAssertEqual(SiriLog.parseSpoken("30 grams of oats").name, "oats")
        XCTAssertEqual(SiriLog.parseSpoken("30g peanut butter").amount, 30)
        XCTAssertEqual(SiriLog.parseSpoken("30g peanut butter").unit, .grams)
        XCTAssertEqual(SiriLog.parseSpoken("30g peanut butter").name, "peanut butter")
        XCTAssertEqual(SiriLog.parseSpoken("2 servings of rice").amount, 2)
        XCTAssertEqual(SiriLog.parseSpoken("2 servings of rice").unit, .portions)
        XCTAssertEqual(SiriLog.parseSpoken("Oats").amount, nil)
        XCTAssertEqual(SiriLog.parseSpoken("Oats").unit, .portions)
        XCTAssertEqual(SiriLog.parseSpoken("Oats").name, "oats")
        // Decimal quantities keep the food name usable without a unit conversion.
        XCTAssertEqual(SiriLog.parseSpoken("1.5 portions of pasta").amount, nil)
        XCTAssertEqual(SiriLog.parseSpoken("1.5 portions of pasta").name, "pasta")
    }

    func testBestMatchPrefersExactThenPrefixThenContainmentAndNewest() {
        let rows = [record("Rolled oats", createdAt: 1), record("Oats", createdAt: 1), record("Instant oatmeal", createdAt: 9),
                    record("Quick add", serving: "Manual entry", createdAt: 99)]
        XCTAssertEqual(SiriLog.bestMatch(for: "oats", in: rows)?.data.foodName, "Oats")
        XCTAssertEqual(SiriLog.bestMatch(for: "rolled", in: rows)?.data.foodName, "Rolled oats")
        XCTAssertEqual(SiriLog.bestMatch(for: "OATMEAL", in: rows)?.data.foodName, "Instant oatmeal")
        XCTAssertEqual(SiriLog.bestMatch(for: "banana", in: rows)?.data.foodName, nil)
        // Quick-add rows and empty queries never match.
        XCTAssertEqual(SiriLog.bestMatch(for: "quick add", in: rows)?.data.foodName, nil)
        XCTAssertEqual(SiriLog.bestMatch(for: "  ", in: rows)?.data.foodName, nil)
        // Newest wins among equal scores.
        let ties = [record("Oats", createdAt: 1), record("Oats", createdAt: 5)]
        XCTAssertEqual(SiriLog.bestMatch(for: "oats", in: ties)?.data.createdAt, 5)
    }

    func testResolveShapesGramAndPortionEntries() throws {
        let nutrition = Nutrition(calories: 389, protein: 17, carbs: 66, fat: 7)
        // Gram amounts bake into the serving with exactly scaled nutrition and one portion.
        let grams = try SiriLog.resolve(amount: 40, unit: .grams, serving: "100 g", nutrition: nutrition)
        XCTAssertEqual(grams.serving, "40 g")
        XCTAssertEqual(grams.portion, 1)
        XCTAssertEqual(grams.nutrition?.calories ?? 0, 155.6, accuracy: 0.01)
        // Portion amounts keep the food's serving and the app's quarter portions.
        let portions = try SiriLog.resolve(amount: 2.5, unit: .portions, serving: "100 g", nutrition: nutrition)
        XCTAssertEqual(portions.serving, "100 g")
        XCTAssertEqual(portions.portion, 2.5)
        XCTAssertEqual(portions.nutrition?.calories ?? 0, 389)
        XCTAssertEqual(try SiriLog.resolve(amount: nil, unit: .portions, serving: nil, nutrition: nil).portion, 1)
        XCTAssertThrowsError(try SiriLog.resolve(amount: nil, unit: .grams, serving: "100 g", nutrition: nil))
        XCTAssertThrowsError(try SiriLog.resolve(amount: 30, unit: .grams, serving: "1 cup", nutrition: nil)) {
            XCTAssertEqual(($0 as? LocalizedError)?.errorDescription?.contains("gram weight"), true)
        }
    }

    func testMakeEntryFollowsDiaryConventions() {
        let rows = [record("A", createdAt: 1, day: "2026-11-21")]
        var row = rows[0]; row.data.sortIndex = 3; row.data.meal = .dinner
        let made = SiriLog.makeEntry(after: [row], food: SearchFood(id: "x", canonicalKey: "x", source: "recent",
            sourceLabel: "", name: "Oats", serving: "100 g", nutrition: Nutrition(calories: 389)), meal: .dinner,
            portion: 0.3, day: "2026-11-21", at: 1234)
        XCTAssertEqual(made.data.sortIndex, 4)
        XCTAssertTrue(made.dirty)
        XCTAssertTrue(made.id.hasPrefix("food_entry_"))
        XCTAssertEqual(made.data.dateKey, "2026-11-21")
        XCTAssertEqual(made.data.meal, .dinner)
        XCTAssertEqual(made.data.nutrition?.calories, 389)
    }

    func testTotalsTextSpeaksCaloriesAndMacroGoals() {
        let settings = UserSettings(calorieGoal: 2500, macroProteinPct: 30, macroCarbsPct: 50, macroFatPct: 20)
        let nutrition = Nutrition(calories: 1320, protein: 84, carbs: 150, fat: 29)
        let text = SiriText.totals(nutrition, settings: settings)
        XCTAssertEqual(text, "Today you're at 1,320 of 2,500 kcal, protein 84 of 188 g, carbs 150 of 313 g, fat 29 of 56 g.")
        XCTAssertEqual(SiriText.nutrient(.protein, nutrition: nutrition, settings: settings),
                       "You've logged 84 g of protein today, 104 g to go.")
        XCTAssertEqual(SiriText.nutrient(.protein, nutrition: Nutrition(protein: 200), settings: settings),
                       "You've hit your protein goal — 200 g today.")
        XCTAssertEqual(SiriText.nutrient(.calories, nutrition: nutrition, settings: settings),
                       "You've logged 1,320 of 2,500 kcal today.")
    }

    func testLoggedTextDescribesGramsAndPortions() {
        let settings = UserSettings()
        let grams = SiriText.logged(name: "Oats", portion: 0.3, gramAmount: 30, meal: .lunch,
                                    nutrition: Nutrition(calories: 117), today: 1417, goal: 2500)
        XCTAssertEqual(grams, "Logged 30 g of Oats to Lunch, 117 kcal. You're at 1,417 of 2,500 kcal today.")
        let portions = SiriText.logged(name: "Oats", portion: 1.25, gramAmount: nil, meal: .lunch,
                                       nutrition: Nutrition(calories: 486), today: 1786, goal: 2500)
        XCTAssertEqual(portions, "Logged 1 1/4 portions of Oats to Lunch, 486 kcal. You're at 1,786 of 2,500 kcal today.")
        XCTAssertEqual(SiriText.loggedCalories(500, meal: .lunch, today: 500, goal: 2500),
                       "Logged 500 calories to Lunch. You're at 500 of 2,500 kcal today.")
    }

    func testDatabaseURLMatchesStoreLayout() {
        XCTAssertEqual(AppStore.databaseURL(userID: "user-a").lastPathComponent,
                       "user-a".utf8.map { String(format: "%02x", $0) }.joined() + ".sqlite")
        XCTAssertTrue(AppStore.databaseURL(userID: "user-a").deletingLastPathComponent().lastPathComponent == "CaloricSwift")
    }
}

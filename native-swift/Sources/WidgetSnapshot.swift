import Foundation
import WidgetKit

struct WidgetSnapshot: Codable, Equatable {
    static let group = "group.lol.mati.caloric.swift"
    var dateKey: String
    var calories: Double
    var calorieGoal: Double
    var calorieProgress: Double
    var proteinProgress: Double
    var carbsProgress: Double
    var fatProgress: Double
    init(nutrition: Nutrition, settings: UserSettings, day: String = LocalDay.key()) {
        dateKey = day; calories = (nutrition.calories ?? 0).rounded(); calorieGoal = Double(settings.calorieGoal)
        calorieProgress = ((nutrition.calories ?? 0) / max(1, calorieGoal) * 100).rounded()
        proteinProgress = ((nutrition.protein ?? 0) / Double(max(1, settings.proteinGoal)) * 100).rounded()
        carbsProgress = ((nutrition.carbs ?? 0) / Double(max(1, settings.carbsGoal)) * 100).rounded()
        fatProgress = ((nutrition.fat ?? 0) / Double(max(1, settings.fatGoal)) * 100).rounded()
    }
    static func write(nutrition: Nutrition, settings: UserSettings) {
        guard let defaults = UserDefaults(suiteName: group), let data = try? JSONEncoder().encode(Self(nutrition: nutrition, settings: settings)), defaults.data(forKey: "todaySummary") != data else { return }
        defaults.set(data, forKey: "todaySummary")
        WidgetCenter.shared.reloadTimelines(ofKind: "CaloricWidget")
    }
    static func clear() {
        UserDefaults(suiteName: group)?.removeObject(forKey: "todaySummary")
        WidgetCenter.shared.reloadTimelines(ofKind: "CaloricWidget")
    }
}

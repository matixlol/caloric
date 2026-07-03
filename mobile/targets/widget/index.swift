import WidgetKit
import SwiftUI

// MARK: - Shared data

/// Snapshot written by the JS app (see WidgetSyncCoordinator.tsx) into the
/// shared App Group as a JSON object under `todaySummary`.
struct TodaySummary: Codable {
  var dateKey: String
  var calories: Double
  var calorieGoal: Double
  var calorieProgress: Double
  var proteinProgress: Double
  var carbsProgress: Double
  var fatProgress: Double

  static let placeholder = TodaySummary(
    dateKey: "",
    calories: 1450,
    calorieGoal: 2500,
    calorieProgress: 58,
    proteinProgress: 72,
    carbsProgress: 48,
    fatProgress: 60
  )

  /// A zeroed-out summary for a given day (used when the stored snapshot is
  /// stale, i.e. belongs to a previous day).
  static func empty(dateKey: String, calorieGoal: Double) -> TodaySummary {
    TodaySummary(
      dateKey: dateKey,
      calories: 0,
      calorieGoal: calorieGoal,
      calorieProgress: 0,
      proteinProgress: 0,
      carbsProgress: 0,
      fatProgress: 0
    )
  }
}

enum WidgetData {
  /// Derive the App Group from this extension's own bundle id. The widget's
  /// bundle id is "<appBundleId>.CaloricWidget" and the group is
  /// "group.<appBundleId>", so both dev and prod variants resolve correctly.
  static var appGroup: String {
    let bundleId = Bundle.main.bundleIdentifier ?? "lol.mati.caloric.CaloricWidget"
    let suffix = ".CaloricWidget"
    let base = bundleId.hasSuffix(suffix) ? String(bundleId.dropLast(suffix.count)) : bundleId
    return "group.\(base)"
  }

  static func currentDateKey(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar.current
    formatter.locale = Locale.current
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }

  /// Reads the stored snapshot. If it is missing or belongs to a previous day,
  /// returns a zeroed summary for today so an idle widget rolls over at midnight.
  static func load(for date: Date) -> TodaySummary {
    let todayKey = currentDateKey(date)
    let defaults = UserDefaults(suiteName: appGroup)
    guard
      let data = defaults?.data(forKey: "todaySummary"),
      let summary = try? JSONDecoder().decode(TodaySummary.self, from: data)
    else {
      return TodaySummary.empty(dateKey: todayKey, calorieGoal: 2500)
    }

    if summary.dateKey != todayKey {
      return TodaySummary.empty(dateKey: todayKey, calorieGoal: summary.calorieGoal)
    }

    return summary
  }
}

// MARK: - Timeline

struct CaloricEntry: TimelineEntry {
  let date: Date
  let summary: TodaySummary
}

struct CaloricProvider: TimelineProvider {
  func placeholder(in context: Context) -> CaloricEntry {
    CaloricEntry(date: Date(), summary: .placeholder)
  }

  func getSnapshot(in context: Context, completion: @escaping (CaloricEntry) -> Void) {
    let now = Date()
    let summary = context.isPreview ? .placeholder : WidgetData.load(for: now)
    completion(CaloricEntry(date: now, summary: summary))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CaloricEntry>) -> Void) {
    let now = Date()
    let entry = CaloricEntry(date: now, summary: WidgetData.load(for: now))

    // Refresh at the next local midnight so a day with no app activity resets.
    let startOfTomorrow = Calendar.current.nextDate(
      after: now,
      matching: DateComponents(hour: 0, minute: 0, second: 0),
      matchingPolicy: .nextTime
    ) ?? now.addingTimeInterval(60 * 60)

    completion(Timeline(entries: [entry], policy: .after(startOfTomorrow)))
  }
}

// MARK: - Views

/// Macro colors mirrored from the app's `src/theme/macroColors.ts`.
enum MacroColor {
  static let protein = Color(hex: 0x2563EB)
  static let carbs = Color(hex: 0xF59E0B)
  static let fat = Color(hex: 0x14B8A6)
}

private extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }
}

private func kcalText(_ value: Double) -> String {
  let formatter = NumberFormatter()
  formatter.numberStyle = .decimal
  formatter.maximumFractionDigits = 0
  return formatter.string(from: NSNumber(value: value)) ?? "\(Int(value))"
}

/// Lock screen — rectangular: total eaten kcal + % of goal + per-macro % eaten.
struct RectangularView: View {
  let summary: TodaySummary

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("\(kcalText(summary.calories)) kcal  \(Int(summary.calorieProgress))%")
        .font(.headline)
        .widgetAccentable()
      Text("P \(Int(summary.proteinProgress))%  C \(Int(summary.carbsProgress))%  F \(Int(summary.fatProgress))%")
        .font(.caption)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Lock screen — circular: ring of calories eaten vs. goal.
struct CircularView: View {
  let summary: TodaySummary

  var body: some View {
    Gauge(value: min(summary.calorieProgress / 100, 1)) {
      Text("kcal")
    } currentValueLabel: {
      Text(kcalText(summary.calories))
        .font(.system(size: 14, weight: .semibold))
        .minimumScaleFactor(0.5)
    }
    .gaugeStyle(.accessoryCircularCapacity)
  }
}

/// Compact macro row sized for the square home-screen widget.
private struct MacroBar: View {
  let label: String
  let progress: Double
  let color: Color

  var body: some View {
    HStack(spacing: 6) {
      Text(label)
        .font(.caption2)
        .foregroundStyle(color)
        .frame(width: 14, alignment: .leading)
      // Fill is clamped to 100% even when the % label runs past goal.
      ProgressView(value: min(progress / 100, 1))
        .tint(color)
      Text("\(Int(progress))%")
        .font(.caption2)
        .monospacedDigit()
        .frame(width: 40, alignment: .trailing)
    }
  }
}

/// Home screen — small (square): kcal eaten / goal, % of goal, and macros.
struct SmallView: View {
  let summary: TodaySummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      VStack(alignment: .leading, spacing: 0) {
        Text("\(kcalText(summary.calories)) kcal")
          .font(.system(size: 22, weight: .bold))
          .minimumScaleFactor(0.6)
          .lineLimit(1)
        Text("\(Int(summary.calorieProgress))% of \(kcalText(summary.calorieGoal))")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      MacroBar(label: "P", progress: summary.proteinProgress, color: MacroColor.protein)
      MacroBar(label: "C", progress: summary.carbsProgress, color: MacroColor.carbs)
      MacroBar(label: "F", progress: summary.fatProgress, color: MacroColor.fat)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct CaloricWidgetEntryView: View {
  @Environment(\.widgetFamily) private var family
  var entry: CaloricProvider.Entry

  var body: some View {
    content
      .widgetBackgroundCompat()
  }

  @ViewBuilder
  private var content: some View {
    switch family {
    case .accessoryCircular:
      CircularView(summary: entry.summary)
    case .accessoryRectangular:
      RectangularView(summary: entry.summary)
    default:
      SmallView(summary: entry.summary)
    }
  }
}

private extension View {
  /// iOS 17 requires widgets to declare a container background; older systems
  /// render fine without it.
  @ViewBuilder
  func widgetBackgroundCompat() -> some View {
    if #available(iOS 17.0, *) {
      self.containerBackground(.fill.tertiary, for: .widget)
    } else {
      self.padding()
    }
  }
}

// MARK: - Widget

struct CaloricWidget: Widget {
  let kind = "CaloricWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CaloricProvider()) { entry in
      CaloricWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Today's Nutrition")
    .description("Calories eaten and how much of each macro you've hit today.")
    .supportedFamilies([.accessoryRectangular, .accessoryCircular, .systemSmall])
  }
}

@main
struct CaloricWidgetBundle: WidgetBundle {
  var body: some Widget {
    CaloricWidget()
  }
}

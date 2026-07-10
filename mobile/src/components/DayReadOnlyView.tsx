import { Platform, PlatformColor, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { FoodEntry, UserSettings } from "@caloric/data-model";
import { MEAL_TIMES, type MealKey, normalizeMeal } from "../meals";
import { formatPortionLabel, sanitizePortion } from "../portion";
import { macroColors } from "../theme/macroColors";
import { isQuickAddEntry } from "../quickAdd";
import { hasCalorieMacroMismatch } from "../nutritionConsistency";
import { CalorieMismatchBadge } from "./CalorieMismatchBadge";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  tertiaryLabel: iosColor("tertiaryLabel", "#9CA3AF"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: "#2563EB",
  macroProtein: macroColors.protein.background,
  macroCarbs: macroColors.carbs.background,
  macroFat: macroColors.fat.background,
};

export type DayMealEntry = {
  id: string;
  name: string;
  meta?: string;
  calories: number;
  hasCalorieMacroMismatch: boolean;
};

export type FoodEntryWithId = FoodEntry & { id: string };

export type DayViewData = {
  selectedDateKey: string;
  dayOffset?: number;
  dayTitle: string;
  daySubtitle: string;
  logsByMeal: Record<MealKey, DayMealEntry[]>;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  calorieGoal: number;
  proteinGoal: number;
  carbsGoal: number;
  fatGoal: number;
  calorieProgress: number;
  proteinProgress: number;
  carbsProgress: number;
  fatProgress: number;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatCalories(value: number) {
  return Math.round(value).toLocaleString();
}

function formatGrams(value: number) {
  return Math.round(value).toLocaleString();
}

function calculateMacroGoals(settings: UserSettings) {
  const calorieGoal = settings.calorieGoal;
  const proteinPct = settings.macroProteinPct;
  const carbsPct = settings.macroCarbsPct;
  const fatPct = settings.macroFatPct;

  return {
    calorieGoal,
    proteinGoal: Math.round((calorieGoal * (proteinPct / 100)) / 4),
    carbsGoal: Math.round((calorieGoal * (carbsPct / 100)) / 4),
    fatGoal: Math.round((calorieGoal * (fatPct / 100)) / 9),
  };
}

function buildLogsByMeal(entries: FoodEntryWithId[]): Record<MealKey, DayMealEntry[]> {
  const grouped: Record<MealKey, DayMealEntry[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snacks: [],
  };

  // Honor the persisted per-meal sortIndex. The store reads entries back in
  // createdAt order, so without this a drag-reorder is written but never
  // reflected on the next revision and rows appear to snap back.
  const ordered = [...entries].sort((a, b) => a.sortIndex - b.sortIndex);

  ordered.forEach((entry) => {
    const meal = normalizeMeal(entry.meal);
    if (!meal) return;

    const portion = sanitizePortion(entry.portion);

    grouped[meal].push({
      id: entry.id,
      name: entry.foodName,
      meta: [formatPortionLabel(portion), entry.brand, entry.serving].filter(Boolean).join(" • "),
      calories: (entry.nutrition?.calories ?? 0) * portion,
      hasCalorieMacroMismatch:
        !isQuickAddEntry(entry) && hasCalorieMacroMismatch(entry.nutrition),
    });
  });

  return grouped;
}

export function buildDayViewData({
  entries,
  selectedDateKey,
  dayOffset,
  dayTitle,
  daySubtitle,
  settings,
}: {
  entries: FoodEntryWithId[];
  selectedDateKey: string;
  dayOffset?: number;
  dayTitle: string;
  daySubtitle: string;
  settings: UserSettings;
}): DayViewData {
  const { calorieGoal, proteinGoal, carbsGoal, fatGoal } = calculateMacroGoals(settings);
  const calories = entries.reduce(
    (sum, entry) => sum + (entry.nutrition?.calories ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const protein = entries.reduce(
    (sum, entry) => sum + (entry.nutrition?.protein ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const carbs = entries.reduce(
    (sum, entry) => sum + (entry.nutrition?.carbs ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const fat = entries.reduce(
    (sum, entry) => sum + (entry.nutrition?.fat ?? 0) * sanitizePortion(entry.portion),
    0,
  );

  return {
    selectedDateKey,
    dayOffset,
    dayTitle,
    daySubtitle,
    logsByMeal: buildLogsByMeal(entries),
    calories,
    protein,
    carbs,
    fat,
    calorieGoal,
    proteinGoal,
    carbsGoal,
    fatGoal,
    calorieProgress: clampPercent((calories / calorieGoal) * 100),
    proteinProgress: clampPercent((protein / Math.max(proteinGoal, 1)) * 100),
    carbsProgress: clampPercent((carbs / Math.max(carbsGoal, 1)) * 100),
    fatProgress: clampPercent((fat / Math.max(fatGoal, 1)) * 100),
  };
}

export function DaySummaryCard({ view }: { view: DayViewData }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryLabel}>Calories</Text>
      <View style={styles.summaryValueRow}>
        <Text style={styles.summaryValue}>{formatCalories(view.calories)}</Text>
        <Text style={styles.summaryGoal}>/ {view.calorieGoal.toLocaleString()}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${view.calorieProgress}%` }]} />
      </View>
      <View style={styles.summaryDivider} />
      <View style={styles.macroColumns}>
        <View style={styles.macroColumn}>
          <Text style={styles.macroLabel}>Protein</Text>
          <Text style={styles.macroValue}>
            {formatGrams(view.protein)}
            <Text style={styles.macroGoal}> / {view.proteinGoal}</Text>
          </Text>
          <View style={styles.macroTrack}>
            <View
              style={[
                styles.macroFill,
                styles.macroProteinFill,
                { width: `${view.proteinProgress}%` },
              ]}
            />
          </View>
        </View>

        <View style={[styles.macroColumn, styles.macroColumnDivider]}>
          <Text style={styles.macroLabel}>Carbs</Text>
          <Text style={styles.macroValue}>
            {formatGrams(view.carbs)}
            <Text style={styles.macroGoal}> / {view.carbsGoal}</Text>
          </Text>
          <View style={styles.macroTrack}>
            <View
              style={[
                styles.macroFill,
                styles.macroCarbsFill,
                { width: `${view.carbsProgress}%` },
              ]}
            />
          </View>
        </View>

        <View style={[styles.macroColumn, styles.macroColumnDivider]}>
          <Text style={styles.macroLabel}>Fat</Text>
          <Text style={styles.macroValue}>
            {formatGrams(view.fat)}
            <Text style={styles.macroGoal}> / {view.fatGoal}</Text>
          </Text>
          <View style={styles.macroTrack}>
            <View
              style={[
                styles.macroFill,
                styles.macroFatFill,
                { width: `${view.fatProgress}%` },
              ]}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

export function ReadOnlyDayView({
  view,
  contentContainerStyle,
  listStyle,
  topInset = 0,
  bottomInset = 24,
}: {
  view: DayViewData;
  contentContainerStyle?: StyleProp<ViewStyle>;
  listStyle?: StyleProp<ViewStyle>;
  topInset?: number;
  bottomInset?: number;
}) {
  const header = (
    <View style={styles.listHeaderOuter}>
      <View style={styles.listHeader}>
        <View style={styles.dayTitleRow}>
          <View style={styles.dayTitleMain}>
            <Text style={styles.largeTitle}>{view.dayTitle}</Text>
            <Text style={styles.daySubtitle}>{view.daySubtitle}</Text>
          </View>
        </View>

        {view.dayOffset !== undefined && view.dayOffset !== 0 ? (
          <View style={styles.backToTodayButton}>
            <Text style={styles.backToTodayText}>Back to today</Text>
          </View>
        ) : null}

        <DaySummaryCard view={view} />
      </View>
    </View>
  );

  return (
    <ScrollView
      style={listStyle}
      contentContainerStyle={[
        styles.contentContainer,
        {
          paddingTop: topInset,
          paddingBottom: bottomInset,
        },
        contentContainerStyle,
      ]}
    >
      {header}
      {MEAL_TIMES.map((meal, index) => {
        const entries = view.logsByMeal[meal.key];
        const mealCalories = entries.reduce((sum, entry) => sum + entry.calories, 0);

        return (
          <View key={`readonly-${view.selectedDateKey}-${meal.key}`} style={styles.mealSection}>
            <View pointerEvents="none" style={styles.mealSideLabel}>
              <Text numberOfLines={1} style={styles.mealSideLabelText}>
                {meal.label.toUpperCase()}
              </Text>
            </View>

            <View style={[styles.mealHeaderCard, index > 0 && styles.mealHeaderCardSpaced]}>
              <View style={styles.mealHeader}>
                <View style={styles.mealCaloriesRow}>
                  <Text style={styles.mealCalories}>{formatCalories(mealCalories)}</Text>
                  <Text style={styles.mealCaloriesUnit}>kcal</Text>
                </View>
              </View>
            </View>

            {entries.length === 0 ? (
              <View style={[styles.mealBodyCard, styles.mealBodyCardLast]}>
                <Text style={styles.emptyText}>{meal.emptyCopy}</Text>
              </View>
            ) : (
              entries.map((entry, entryIndex) => {
                const isLast = entryIndex === entries.length - 1;

                return (
                  <View key={`readonly-entry-${entry.id}`} style={[styles.mealBodyCard, isLast && styles.mealBodyCardLast]}>
                    <View style={[styles.rowPressable, !isLast && styles.rowWithDivider]}>
                      <View style={styles.row}>
                        <View style={styles.rowMain}>
                          <Text style={styles.rowTitle}>{entry.name}</Text>
                          {entry.meta ? <Text style={styles.rowSubtitle}>{entry.meta}</Text> : null}
                          {entry.hasCalorieMacroMismatch ? <CalorieMismatchBadge /> : null}
                        </View>
                        <Text style={styles.rowValue}>{formatCalories(entry.calories)}</Text>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  contentContainer: {
    paddingHorizontal: 16,
  },
  listHeaderOuter: {
    overflow: "hidden",
    marginBottom: 10,
  },
  listHeader: {
    gap: 8,
  },
  mealSection: {
    position: "relative",
    marginBottom: 2,
  },
  dayTitleRow: {
    minHeight: 52,
    justifyContent: "center",
  },
  dayTitleMain: {
    alignItems: "flex-start",
  },
  largeTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: palette.label,
  },
  daySubtitle: {
    marginTop: 1,
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  backToTodayButton: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: palette.card,
  },
  backToTodayText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "600",
    color: palette.tint,
  },
  summaryCard: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  summaryLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: palette.secondaryLabel,
  },
  summaryValueRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    marginTop: 8,
  },
  summaryValue: {
    fontSize: 46,
    lineHeight: 50,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  summaryGoal: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "500",
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
    marginBottom: 2,
  },
  progressTrack: {
    marginTop: 12,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.tertiaryLabel,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: palette.tint,
  },
  summaryDivider: {
    marginTop: 14,
    marginBottom: 14,
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.separator,
  },
  macroColumns: {
    flexDirection: "row",
  },
  macroColumn: {
    flex: 1,
    gap: 6,
  },
  macroColumnDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: palette.separator,
    paddingLeft: 12,
    marginLeft: 12,
  },
  macroLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    letterSpacing: 0,
  },
  macroValue: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  macroGoal: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "500",
    color: palette.secondaryLabel,
  },
  macroTrack: {
    marginTop: 2,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.tertiaryLabel,
    overflow: "hidden",
  },
  macroFill: {
    height: "100%",
  },
  macroProteinFill: {
    backgroundColor: palette.macroProtein,
  },
  macroCarbsFill: {
    backgroundColor: palette.macroCarbs,
  },
  macroFatFill: {
    backgroundColor: palette.macroFat,
  },
  mealSideLabel: {
    position: "absolute",
    left: -12,
    top: 0,
    bottom: 0,
    width: 26,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
    elevation: 1,
  },
  mealSideLabelText: {
    position: "absolute",
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
    color: palette.secondaryLabel,
    letterSpacing: 1.6,
    width: 96,
    textAlign: "center",
    transform: [{ rotate: "-90deg" }],
  },
  mealHeaderCard: {
    flex: 1,
    marginLeft: 14,
    backgroundColor: palette.card,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  mealHeaderCardSpaced: {
    marginTop: 10,
  },
  mealHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  mealCaloriesRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  mealCalories: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  mealCaloriesUnit: {
    fontSize: 11,
    lineHeight: 11,
    fontWeight: "600",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  mealBodyCard: {
    marginLeft: 14,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
  },
  mealBodyCardLast: {
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    overflow: "hidden",
  },
  rowPressable: {
    backgroundColor: palette.card,
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingRight: 12,
  },
  rowWithDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.separator,
  },
  rowMain: {
    flex: 1,
    paddingVertical: 10,
  },
  rowTitle: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  rowSubtitle: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  rowValue: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  emptyText: {
    paddingVertical: 14,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
});

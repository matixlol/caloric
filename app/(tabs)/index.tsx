import { useRouter } from "expo-router";
import { useAccount } from "jazz-tools/expo";
import {
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MEAL_TIMES, type MealKey, normalizeMeal } from "../../src/meals";
import { CaloricAccount } from "../../src/jazz/schema";

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
};

const DEFAULT_CALORIE_GOAL = 2500;
const DEFAULT_PROTEIN_PCT = 30;
const DEFAULT_CARBS_PCT = 50;
const DEFAULT_FAT_PCT = 20;

type MealEntry = {
  id: string;
  name: string;
  meta?: string;
  calories: number;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function MealRow({
  name,
  meta,
  calories,
  isLast,
}: {
  name: string;
  meta?: string;
  calories: number;
  isLast: boolean;
}) {
  return (
    <View style={[styles.row, !isLast && styles.rowWithDivider]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{name}</Text>
        {meta ? <Text style={styles.rowSubtitle}>{meta}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{calories.toLocaleString()}</Text>
    </View>
  );
}

function MealSection({
  label,
  emptyCopy,
  entries,
  calories,
  onAddFood,
}: {
  label: string;
  emptyCopy: string;
  entries: MealEntry[];
  calories: number;
  onAddFood: () => void;
}) {
  return (
    <View style={styles.mealRow}>
      <View style={styles.mealSideLabel}>
        <Text numberOfLines={1} style={styles.mealSideLabelText}>
          {label.toUpperCase()}
        </Text>
      </View>

      {/* Keep each meal body isolated so this can become a drop target later. */}
      <View style={styles.mealCard}>
        <View style={styles.mealHeader}>
          <View style={styles.mealCaloriesRow}>
            <Text style={styles.mealCalories}>{calories.toLocaleString()}</Text>
            <Text style={styles.mealCaloriesUnit}>kcal</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add food to ${label}`}
            onPress={onAddFood}
            style={styles.addIconButton}
          >
            <Text style={styles.addIconButtonText}>+</Text>
          </Pressable>
        </View>

        {entries.length === 0 ? (
          <Text style={styles.emptyText}>{emptyCopy}</Text>
        ) : (
          entries.map((entry, index) => (
            <MealRow
              key={entry.id}
              name={entry.name}
              meta={entry.meta}
              calories={entry.calories}
              isLast={index === entries.length - 1}
            />
          ))
        )}
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: { $each: { nutrition: true } } } },
  });

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  const logs = (me.root.logs ?? [])
    .filter(
      (entry): entry is NonNullable<typeof entry> & { $isLoaded: true } =>
        Boolean(entry?.$isLoaded),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  const caloriesConsumed = logs.reduce((sum, entry) => sum + (entry.nutrition?.calories ?? 0), 0);
  const protein = logs.reduce((sum, entry) => sum + (entry.nutrition?.protein ?? 0), 0);
  const carbs = logs.reduce((sum, entry) => sum + (entry.nutrition?.carbs ?? 0), 0);
  const fat = logs.reduce((sum, entry) => sum + (entry.nutrition?.fat ?? 0), 0);

  const goal = me.root.calorieGoal || DEFAULT_CALORIE_GOAL;
  const proteinPct = me.root.macroProteinPct ?? DEFAULT_PROTEIN_PCT;
  const carbsPct = me.root.macroCarbsPct ?? DEFAULT_CARBS_PCT;
  const fatPct = me.root.macroFatPct ?? DEFAULT_FAT_PCT;
  const calorieProgress = clampPercent((caloriesConsumed / goal) * 100);

  const proteinGoal = Math.round((goal * (proteinPct / 100)) / 4);
  const carbsGoal = Math.round((goal * (carbsPct / 100)) / 4);
  const fatGoal = Math.round((goal * (fatPct / 100)) / 9);

  const proteinProgress = clampPercent((protein / Math.max(proteinGoal, 1)) * 100);
  const carbsProgress = clampPercent((carbs / Math.max(carbsGoal, 1)) * 100);
  const fatProgress = clampPercent((fat / Math.max(fatGoal, 1)) * 100);

  const logsByMeal: Record<MealKey, MealEntry[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snacks: [],
  };

  logs.forEach((entry) => {
    const meal = normalizeMeal(entry.meal);
    if (!meal) return;

    logsByMeal[meal].push({
      id: entry.$jazz.id,
      name: entry.foodName,
      meta: [entry.brand, entry.serving].filter(Boolean).join(" • "),
      calories: entry.nutrition?.calories ?? 0,
    });
  });

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <Text style={styles.largeTitle}>Today</Text>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Calories</Text>
          <View style={styles.summaryValueRow}>
            <Text style={styles.summaryValue}>{caloriesConsumed.toLocaleString()}</Text>
            <Text style={styles.summaryGoal}>/ {goal.toLocaleString()}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${calorieProgress}%` }]} />
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.macroColumns}>
            <View style={styles.macroColumn}>
              <Text style={styles.macroLabel}>Protein</Text>
              <Text style={styles.macroValue}>
                {Math.round(protein)}g
                <Text style={styles.macroGoal}> / {proteinGoal}g</Text>
              </Text>
              <View style={styles.macroTrack}>
                <View style={[styles.macroFill, { width: `${proteinProgress}%` }]} />
              </View>
            </View>

            <View style={[styles.macroColumn, styles.macroColumnDivider]}>
              <Text style={styles.macroLabel}>Carbs</Text>
              <Text style={styles.macroValue}>
                {Math.round(carbs)}g
                <Text style={styles.macroGoal}> / {carbsGoal}g</Text>
              </Text>
              <View style={styles.macroTrack}>
                <View style={[styles.macroFill, { width: `${carbsProgress}%` }]} />
              </View>
            </View>

            <View style={[styles.macroColumn, styles.macroColumnDivider]}>
              <Text style={styles.macroLabel}>Fat</Text>
              <Text style={styles.macroValue}>
                {Math.round(fat)}g
                <Text style={styles.macroGoal}> / {fatGoal}g</Text>
              </Text>
              <View style={styles.macroTrack}>
                <View style={[styles.macroFill, { width: `${fatProgress}%` }]} />
              </View>
            </View>
          </View>
        </View>

        <View style={styles.mealList}>
          {MEAL_TIMES.map((meal) => {
            const entries = logsByMeal[meal.key];
            const calories = entries.reduce((sum, entry) => sum + entry.calories, 0);

            return (
              <MealSection
                key={meal.key}
                label={meal.label}
                emptyCopy={meal.emptyCopy}
                entries={entries}
                calories={calories}
                onAddFood={() =>
                  router.navigate({
                    pathname: "/log-food",
                    params: { meal: meal.key },
                  })
                }
              />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  contentContainer: {
    paddingHorizontal: 16,
    gap: 10,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
  loadingText: {
    fontSize: 16,
    color: palette.secondaryLabel,
  },
  largeTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: palette.label,
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
    backgroundColor: palette.tint,
  },
  mealList: {
    gap: 10,
    paddingBottom: 12,
    marginHorizontal: -10,
  },
  mealRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 4,
  },
  mealSideLabel: {
    width: 26,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
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
  mealCard: {
    flex: 1,
    backgroundColor: palette.card,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: palette.separator,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  mealHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  mealCalories: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  mealCaloriesRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  mealCaloriesUnit: {
    fontSize: 11,
    lineHeight: 11,
    fontWeight: "600",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  addIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
  addIconButtonText: {
    fontSize: 22,
    lineHeight: 24,
    fontWeight: "600",
    color: palette.tint,
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
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

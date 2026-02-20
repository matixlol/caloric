import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useAccount } from "jazz-tools/expo";
import { useEffect, useMemo, useState } from "react";
import {
  type LayoutChangeEvent,
  Platform,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import DraggableFlatList, { type RenderItemParams } from "react-native-draggable-flatlist";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MEAL_TIMES, type MealKey, normalizeMeal } from "../../src/meals";
import { formatPortionLabel, sanitizePortion } from "../../src/portion";
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
  destructive: iosColor("systemRed", "#DC2626"),
  destructiveText: "#FFFFFF",
};

const DEFAULT_CALORIE_GOAL = 2500;
const DEFAULT_PROTEIN_PCT = 30;
const DEFAULT_CARBS_PCT = 50;
const DEFAULT_FAT_PCT = 20;

const HEADER_HEIGHT_ESTIMATE = 74;
const ENTRY_HEIGHT_ESTIMATE = 54;
const EMPTY_HEIGHT_ESTIMATE = 60;

type MealEntry = {
  id: string;
  name: string;
  meta?: string;
  calories: number;
};

type MealHeaderItem = {
  type: "header";
  key: string;
  meal: MealKey;
  label: string;
  calories: number;
  isFirst: boolean;
};

type MealEntryItem = {
  type: "entry";
  key: string;
  meal: MealKey;
  entry: MealEntry;
};

type MealEmptyItem = {
  type: "empty";
  key: string;
  meal: MealKey;
  copy: string;
};

type MealListItem = MealHeaderItem | MealEntryItem | MealEmptyItem;

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatCalories(value: number) {
  return Math.round(value).toLocaleString();
}

function formatGrams(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}g` : `${rounded.toFixed(1)}g`;
}

function estimateItemHeight(item: MealListItem) {
  if (item.type === "header") return HEADER_HEIGHT_ESTIMATE;
  if (item.type === "entry") return ENTRY_HEIGHT_ESTIMATE;
  return EMPTY_HEIGHT_ESTIMATE;
}

function MealRow({
  id,
  name,
  meta,
  calories,
  isLast,
  isActive,
  onDelete,
  onPress,
  onDrag,
}: {
  id: string;
  name: string;
  meta?: string;
  calories: number;
  isLast: boolean;
  isActive: boolean;
  onDelete: (id: string) => void;
  onPress: (id: string) => void;
  onDrag: () => void;
}) {
  return (
    <Swipeable
      containerStyle={styles.rowSwipeContainer}
      childrenContainerStyle={styles.rowSwipeChildren}
      friction={2}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.rightActionsContainer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${name}`}
            onPress={() => onDelete(id)}
            style={styles.deleteAction}
          >
            <Ionicons color={palette.destructiveText} name="trash-outline" size={20} />
          </Pressable>
        </View>
      )}
      rightThreshold={40}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${name}`}
        delayLongPress={170}
        disabled={isActive}
        onLongPress={onDrag}
        onPress={() => onPress(id)}
        style={[styles.rowPressable, !isLast && styles.rowWithDivider]}
      >
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>{name}</Text>
            {meta ? <Text style={styles.rowSubtitle}>{meta}</Text> : null}
          </View>
          <Text style={styles.rowValue}>{formatCalories(calories)}</Text>
        </View>
      </Pressable>
    </Swipeable>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: { $each: { nutrition: true } } } },
  });
  const logsValue = me.$isLoaded ? me.root.logs : undefined;

  const logs = useMemo(() => {
    if (!me.$isLoaded) {
      return [];
    }

    return (logsValue ?? []).filter(
      (entry): entry is NonNullable<typeof entry> & { $isLoaded: true } => Boolean(entry?.$isLoaded),
    );
  }, [logsValue, me.$isLoaded]);

  const logsByMeal = useMemo<Record<MealKey, MealEntry[]>>(() => {
    const grouped: Record<MealKey, MealEntry[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: [],
    };

    logs.forEach((entry) => {
      const meal = normalizeMeal(entry.meal);
      if (!meal) return;

      const portion = sanitizePortion(entry.portion);

      grouped[meal].push({
        id: entry.$jazz.id,
        name: entry.foodName,
        meta: [formatPortionLabel(portion), entry.brand, entry.serving].filter(Boolean).join(" • "),
        calories: (entry.nutrition?.calories ?? 0) * portion,
      });
    });

    return grouped;
  }, [logs]);

  const mealListItems = useMemo<MealListItem[]>(() => {
    const items: MealListItem[] = [];

    MEAL_TIMES.forEach((meal, mealIndex) => {
      const entries = logsByMeal[meal.key];
      const calories = entries.reduce((sum, entry) => sum + entry.calories, 0);

      items.push({
        type: "header",
        key: `header-${meal.key}`,
        meal: meal.key,
        label: meal.label,
        calories,
        isFirst: mealIndex === 0,
      });

      if (entries.length === 0) {
        items.push({
          type: "empty",
          key: `empty-${meal.key}`,
          meal: meal.key,
          copy: meal.emptyCopy,
        });
        return;
      }

      entries.forEach((entry) => {
        items.push({
          type: "entry",
          key: `entry-${entry.id}`,
          meal: meal.key,
          entry,
        });
      });
    });

    return items;
  }, [logsByMeal]);

  const [dragItems, setDragItems] = useState<MealListItem[]>(mealListItems);

  useEffect(() => {
    setDragItems(mealListItems);
  }, [mealListItems]);

  const [itemHeights, setItemHeights] = useState<Record<string, number>>({});

  const sectionHeights = useMemo<Record<MealKey, number>>(() => {
    const heights: Record<MealKey, number> = {
      breakfast: 0,
      lunch: 0,
      dinner: 0,
      snacks: 0,
    };

    let activeMeal: MealKey = "breakfast";

    dragItems.forEach((item) => {
      if (item.type === "header") {
        activeMeal = item.meal;
      }

      const measuredHeight = itemHeights[item.key] ?? estimateItemHeight(item);
      heights[activeMeal] += measuredHeight;
    });

    return heights;
  }, [dragItems, itemHeights]);

  const entryIsLastByKey = useMemo<Record<string, boolean>>(() => {
    const isLastByKey: Record<string, boolean> = {};

    for (let index = 0; index < dragItems.length; index += 1) {
      const item = dragItems[index];
      if (item.type !== "entry") {
        continue;
      }

      let isLast = true;

      for (let nextIndex = index + 1; nextIndex < dragItems.length; nextIndex += 1) {
        const next = dragItems[nextIndex];
        if (next.type === "header") {
          break;
        }

        if (next.type === "entry") {
          isLast = false;
          break;
        }
      }

      isLastByKey[item.key] = isLast;
    }

    return isLastByKey;
  }, [dragItems]);

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  const rootLogs = me.root.logs;

  const caloriesConsumed = logs.reduce(
    (sum, entry) => sum + (entry.nutrition?.calories ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const protein = logs.reduce(
    (sum, entry) => sum + (entry.nutrition?.protein ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const carbs = logs.reduce(
    (sum, entry) => sum + (entry.nutrition?.carbs ?? 0) * sanitizePortion(entry.portion),
    0,
  );
  const fat = logs.reduce(
    (sum, entry) => sum + (entry.nutrition?.fat ?? 0) * sanitizePortion(entry.portion),
    0,
  );

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

  const recordItemHeight = (itemKey: string, event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;

    setItemHeights((prev) => {
      const current = prev[itemKey] ?? 0;
      if (Math.abs(current - next) < 0.5) {
        return prev;
      }

      return { ...prev, [itemKey]: next };
    });
  };

  const handleDeleteEntry = (entryId: string) => {
    if (!rootLogs) {
      return;
    }

    const index = rootLogs.findIndex((entry) => entry?.$isLoaded && entry.$jazz.id === entryId);
    if (index === -1) {
      return;
    }

    rootLogs.$jazz.splice(index, 1);
  };

  const handleOpenEntry = (entryId: string) => {
    router.push({
      pathname: "/entry-details",
      params: { entryId },
    });
  };

  const persistDraggedOrder = (orderedItems: MealListItem[]) => {
    if (!rootLogs || logs.length === 0) {
      return;
    }

    const entryIdsByMeal: Record<MealKey, string[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: [],
    };

    let activeMeal: MealKey = "breakfast";

    orderedItems.forEach((item) => {
      if (item.type === "header") {
        activeMeal = item.meal;
        return;
      }

      if (item.type === "entry") {
        entryIdsByMeal[activeMeal].push(item.entry.id);
      }
    });

    const seenEntryIds = new Set<string>();

    (Object.keys(entryIdsByMeal) as MealKey[]).forEach((meal) => {
      entryIdsByMeal[meal].forEach((id) => {
        seenEntryIds.add(id);
      });
    });

    logs.forEach((entry) => {
      if (seenEntryIds.has(entry.$jazz.id)) {
        return;
      }

      const normalizedMeal = normalizeMeal(entry.meal) ?? "lunch";
      entryIdsByMeal[normalizedMeal].push(entry.$jazz.id);
    });

    const logsById = new Map(logs.map((entry) => [entry.$jazz.id, entry] as const));
    const reordered: typeof logs = [];

    MEAL_TIMES.forEach((mealTime) => {
      entryIdsByMeal[mealTime.key].forEach((entryId) => {
        const entry = logsById.get(entryId);
        if (!entry) {
          return;
        }

        if (normalizeMeal(entry.meal) !== mealTime.key) {
          entry.$jazz.set("meal", mealTime.key);
        }

        reordered.push(entry);
      });
    });

    if (reordered.length !== logs.length) {
      return;
    }

    rootLogs.$jazz.splice(0, rootLogs.length, ...reordered);
  };

  const listHeader = (
    <View style={styles.listHeader}>
      <Text style={styles.largeTitle}>Today</Text>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>Calories</Text>
        <View style={styles.summaryValueRow}>
          <Text style={styles.summaryValue}>{formatCalories(caloriesConsumed)}</Text>
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
              {formatGrams(protein)}
              <Text style={styles.macroGoal}> / {proteinGoal}g</Text>
            </Text>
            <View style={styles.macroTrack}>
              <View style={[styles.macroFill, { width: `${proteinProgress}%` }]} />
            </View>
          </View>

          <View style={[styles.macroColumn, styles.macroColumnDivider]}>
            <Text style={styles.macroLabel}>Carbs</Text>
            <Text style={styles.macroValue}>
              {formatGrams(carbs)}
              <Text style={styles.macroGoal}> / {carbsGoal}g</Text>
            </Text>
            <View style={styles.macroTrack}>
              <View style={[styles.macroFill, { width: `${carbsProgress}%` }]} />
            </View>
          </View>

          <View style={[styles.macroColumn, styles.macroColumnDivider]}>
            <Text style={styles.macroLabel}>Fat</Text>
            <Text style={styles.macroValue}>
              {formatGrams(fat)}
              <Text style={styles.macroGoal}> / {fatGoal}g</Text>
            </Text>
            <View style={styles.macroTrack}>
              <View style={[styles.macroFill, { width: `${fatProgress}%` }]} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );

  const renderItem = ({ item, drag, isActive }: RenderItemParams<MealListItem>) => {
    if (item.type === "header") {
      return (
        <View onLayout={(event) => recordItemHeight(item.key, event)} style={styles.mealRow}>
          <View
            pointerEvents="none"
            style={[styles.mealSideLabel, { height: Math.max(sectionHeights[item.meal], 48) }]}
          >
            <Text numberOfLines={1} style={styles.mealSideLabelText}>
              {item.label.toUpperCase()}
            </Text>
          </View>

          <View style={[styles.mealHeaderCard, !item.isFirst && styles.mealHeaderCardSpaced]}>
            <View style={styles.mealHeader}>
              <View style={styles.mealCaloriesRow}>
                <Text style={styles.mealCalories}>{formatCalories(item.calories)}</Text>
                <Text style={styles.mealCaloriesUnit}>kcal</Text>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add food to ${item.label}`}
                onPress={() =>
                  router.navigate({
                    pathname: "/log-food",
                    params: { meal: item.meal },
                  })
                }
                style={styles.addIconButton}
              >
                <Text style={styles.addIconButtonText}>+</Text>
              </Pressable>
            </View>
          </View>
        </View>
      );
    }

    if (item.type === "empty") {
      return (
        <View
          onLayout={(event) => recordItemHeight(item.key, event)}
          style={[styles.mealBodyCard, styles.mealBodyCardLast]}
        >
          <Text style={styles.emptyText}>{item.copy}</Text>
        </View>
      );
    }

    const isLast = entryIsLastByKey[item.key] ?? true;

    return (
      <View
        onLayout={(event) => recordItemHeight(item.key, event)}
        style={[styles.mealBodyCard, isLast && styles.mealBodyCardLast]}
      >
        <MealRow
          id={item.entry.id}
          name={item.entry.name}
          meta={item.entry.meta}
          calories={item.entry.calories}
          isLast={isLast}
          isActive={isActive}
          onDelete={handleDeleteEntry}
          onPress={handleOpenEntry}
          onDrag={drag}
        />
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <DraggableFlatList
        activationDistance={8}
        autoscrollSpeed={120}
        autoscrollThreshold={80}
        containerStyle={styles.listContainer}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + 24,
          },
        ]}
        data={dragItems}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={listHeader}
        onDragEnd={({ data }) => {
          setDragItems(data);
          persistDraggedOrder(data);
        }}
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  listContainer: {
    flex: 1,
    backgroundColor: palette.background,
  },
  contentContainer: {
    paddingHorizontal: 16,
  },
  listHeader: {
    gap: 10,
    marginBottom: 10,
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
  mealRow: {
    position: "relative",
    flexDirection: "row",
    alignItems: "stretch",
  },
  mealSideLabel: {
    position: "absolute",
    left: -12,
    top: 0,
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
  rowSwipeContainer: {
    overflow: "hidden",
  },
  rowSwipeChildren: {
    backgroundColor: palette.card,
  },
  rightActionsContainer: {
    width: 76,
    justifyContent: "center",
    alignItems: "stretch",
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
  deleteAction: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.destructive,
  },
  emptyText: {
    paddingVertical: 14,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
});

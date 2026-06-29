import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FoodEntryRecord } from "../src/data/store";
import { useDataStoreActions, useDataStoreReady, useFoodEntry } from "../src/data/DataProvider";
import { mealLabelFor, normalizeMeal } from "../src/meals";
import {
  PORTION_DELTAS,
  formatPortionDecimal,
  formatPortionLabel,
  sanitizePortion,
} from "../src/portion";
import {
  isQuickAddEntry,
  parseCalorieInput,
  parseOptionalMacroInput,
} from "../src/quickAdd";
import { macroColors } from "../src/theme/macroColors";

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

const MIN_MACRO_SECTION_SHARE = 0.2;

function formatCalories(value: number) {
  return Math.round(value).toLocaleString();
}

function formatGrams(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}g` : `${rounded.toFixed(1)}g`;
}

function buildMacroSectionShares(calories: number[]) {
  const positiveCalories = calories.map((value) => Math.max(0, value));
  const total = positiveCalories.reduce((sum, value) => sum + value, 0);

  if (total <= 0) {
    return positiveCalories.map(() => 1 / positiveCalories.length);
  }

  const baseShares = positiveCalories.map((value) => value / total);
  const smallIndexes = baseShares
    .map((share, index) => ({ share, index }))
    .filter(({ share }) => share < MIN_MACRO_SECTION_SHARE)
    .map(({ index }) => index);

  if (smallIndexes.length === 0) {
    return baseShares;
  }

  const largeIndexes = baseShares
    .map((share, index) => ({ share, index }))
    .filter(({ share }) => share >= MIN_MACRO_SECTION_SHARE)
    .map(({ index }) => index);

  if (largeIndexes.length === 0) {
    return baseShares.map(() => 1 / baseShares.length);
  }

  const deficit = smallIndexes.reduce(
    (sum, index) => sum + (MIN_MACRO_SECTION_SHARE - baseShares[index]),
    0,
  );
  const available = largeIndexes.reduce((sum, index) => sum + baseShares[index], 0);

  if (available <= 0 || deficit >= available) {
    return baseShares.map(() => 1 / baseShares.length);
  }

  const adjustedShares = [...baseShares];
  smallIndexes.forEach((index) => {
    adjustedShares[index] = MIN_MACRO_SECTION_SHARE;
  });
  largeIndexes.forEach((index) => {
    adjustedShares[index] = baseShares[index] - (deficit * baseShares[index]) / available;
  });

  return adjustedShares;
}

function formatCaloriesInput(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  return String(Math.round(value));
}

function formatMacroInput(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

type QuickAddEditorProps = {
  entry: FoodEntryRecord;
  onUpdateNutrition: (apply: (nutrition: Record<string, number>) => void) => void;
};

function QuickAddEditor({ entry, onUpdateNutrition }: QuickAddEditorProps) {
  const [caloriesText, setCaloriesText] = useState(() =>
    formatCaloriesInput(entry.nutrition?.calories),
  );
  const [proteinText, setProteinText] = useState(() =>
    formatMacroInput(entry.nutrition?.protein),
  );
  const [carbsText, setCarbsText] = useState(() => formatMacroInput(entry.nutrition?.carbs));
  const [fatText, setFatText] = useState(() => formatMacroInput(entry.nutrition?.fat));

  const commitCalories = () => {
    const parsed = parseCalorieInput(caloriesText);
    if (parsed === null) {
      setCaloriesText(formatCaloriesInput(entry.nutrition?.calories));
      return;
    }
    setCaloriesText(String(parsed));
    onUpdateNutrition((nutrition) => {
      nutrition.calories = parsed;
    });
  };

  const commitMacro = (
    key: "protein" | "carbs" | "fat",
    text: string,
    setText: (value: string) => void,
  ) => {
    const parsed = parseOptionalMacroInput(text);
    if (parsed === null) {
      setText(formatMacroInput(entry.nutrition?.[key]));
      return;
    }
    if (parsed === undefined) {
      setText("");
      onUpdateNutrition((nutrition) => {
        delete nutrition[key];
      });
      return;
    }
    setText(formatMacroInput(parsed));
    onUpdateNutrition((nutrition) => {
      nutrition[key] = parsed;
    });
  };

  return (
    <View style={styles.quickAddCard}>
      <View style={styles.quickAddCaloriesField}>
        <Text style={styles.quickAddFieldLabel}>Calories</Text>
        <TextInput
          accessibilityLabel="Calories"
          value={caloriesText}
          onChangeText={setCaloriesText}
          onEndEditing={commitCalories}
          onBlur={commitCalories}
          keyboardType="number-pad"
          placeholder="250"
          placeholderTextColor={palette.tertiaryLabel}
          selectTextOnFocus
          returnKeyType="done"
          style={styles.quickAddCaloriesInput}
        />
      </View>
      <View style={styles.quickAddMacroRow}>
        <View style={styles.quickAddMacroField}>
          <Text style={styles.quickAddFieldLabel}>Protein</Text>
          <TextInput
            accessibilityLabel="Protein grams"
            value={proteinText}
            onChangeText={setProteinText}
            onEndEditing={() => commitMacro("protein", proteinText, setProteinText)}
            onBlur={() => commitMacro("protein", proteinText, setProteinText)}
            keyboardType="decimal-pad"
            placeholder="g"
            placeholderTextColor={palette.tertiaryLabel}
            selectTextOnFocus
            style={styles.quickAddMacroInput}
          />
        </View>
        <View style={styles.quickAddMacroField}>
          <Text style={styles.quickAddFieldLabel}>Carbs</Text>
          <TextInput
            accessibilityLabel="Carbs grams"
            value={carbsText}
            onChangeText={setCarbsText}
            onEndEditing={() => commitMacro("carbs", carbsText, setCarbsText)}
            onBlur={() => commitMacro("carbs", carbsText, setCarbsText)}
            keyboardType="decimal-pad"
            placeholder="g"
            placeholderTextColor={palette.tertiaryLabel}
            selectTextOnFocus
            style={styles.quickAddMacroInput}
          />
        </View>
        <View style={styles.quickAddMacroField}>
          <Text style={styles.quickAddFieldLabel}>Fat</Text>
          <TextInput
            accessibilityLabel="Fat grams"
            value={fatText}
            onChangeText={setFatText}
            onEndEditing={() => commitMacro("fat", fatText, setFatText)}
            onBlur={() => commitMacro("fat", fatText, setFatText)}
            keyboardType="decimal-pad"
            placeholder="g"
            placeholderTextColor={palette.tertiaryLabel}
            selectTextOnFocus
            style={styles.quickAddMacroInput}
          />
        </View>
      </View>
    </View>
  );
}

export default function EntryDetailsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ entryId?: string | string[] }>();
  const isDataReady = useDataStoreReady();
  const { updateFoodEntry } = useDataStoreActions();
  const entryId = Array.isArray(params.entryId) ? params.entryId[0] : params.entryId;
  const { data: entry, isLoading } = useFoodEntry(entryId);

  if (!isDataReady || isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  if (!entry) {
    return (
      <View style={styles.screen}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Entry not found</Text>
          <Text style={styles.errorBody}>This log entry was removed or is unavailable.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => router.back()}
            style={styles.doneButton}
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const portion = sanitizePortion(entry.portion);
  const protein = (entry.nutrition?.protein ?? 0) * portion;
  const carbs = (entry.nutrition?.carbs ?? 0) * portion;
  const fat = (entry.nutrition?.fat ?? 0) * portion;
  const proteinCalories = protein * 4;
  const carbsCalories = carbs * 4;
  const fatCalories = fat * 9;
  const macroSectionShares = buildMacroSectionShares([proteinCalories, carbsCalories, fatCalories]);
  const meal = normalizeMeal(entry.meal);
  const mealLabel = meal ? mealLabelFor(meal) : entry.meal;
  const isQuickAdd = isQuickAddEntry(entry);
  const metaParts = isQuickAdd ? [mealLabel] : [mealLabel, entry.brand, entry.serving];
  const meta = metaParts.filter(Boolean).join(" • ");

  const handleUpdateNutrition = (apply: (nutrition: Record<string, number>) => void) => {
    void updateFoodEntry(entry.id, (current) => {
      const nutrition = { ...current.nutrition } as Record<string, number>;
      apply(nutrition);
      return {
        meal: current.meal,
        foodName: current.foodName,
        brand: current.brand,
        serving: current.serving,
        portion: current.portion,
        nutrition,
        createdAt: current.createdAt,
        dateKey: current.dateKey,
        sortIndex: current.sortIndex,
      };
    });
  };

  const handleAdjustPortion = (delta: number) => {
    const nextPortion = sanitizePortion(portion + delta);
    if (nextPortion === portion) {
      return;
    }

    void updateFoodEntry(entry.id, (current) => ({
      meal: current.meal,
      foodName: current.foodName,
      brand: current.brand,
      serving: current.serving,
      portion: nextPortion,
      nutrition: current.nutrition,
      createdAt: current.createdAt,
      dateKey: current.dateKey,
      sortIndex: current.sortIndex,
    }));
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: 16,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <Text style={styles.title}>{entry.foodName}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close details"
            onPress={() => router.back()}
            style={styles.closeButton}
          >
            <Ionicons color={palette.secondaryLabel} name="close" size={20} />
          </Pressable>
        </View>

        {meta ? <Text style={styles.metaText}>{meta}</Text> : null}

        {isQuickAdd ? (
          <QuickAddEditor entry={entry} onUpdateNutrition={handleUpdateNutrition} />
        ) : (
        <View style={styles.portionCard}>
          <Text style={styles.portionLabel}>Portion</Text>
          <Text style={styles.portionValue}>{formatPortionLabel(portion)}</Text>
          <Text style={styles.portionDecimal}>{`${formatPortionDecimal(portion)}x base serving`}</Text>

          <View style={styles.portionControlRow}>
            {PORTION_DELTAS.map((action) => {
              const nextPortion = sanitizePortion(portion + action.delta);
              const disabled = nextPortion === portion;

              return (
                <Pressable
                  key={action.label}
                  accessibilityRole="button"
                  accessibilityLabel={`Adjust portion ${action.label}`}
                  disabled={disabled}
                  onPress={() => handleAdjustPortion(action.delta)}
                  style={[styles.portionButton, disabled && styles.portionButtonDisabled]}
                >
                  <Text
                    style={[styles.portionButtonText, disabled && styles.portionButtonTextDisabled]}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        )}

        {!isQuickAdd&&<View style={styles.nutritionCard}>
          <View style={styles.macroLegendRow}>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroProtein }]} />
              <Text style={styles.macroLegendText}>Protein</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroCarbs }]} />
              <Text style={styles.macroLegendText}>Carbs</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroFat }]} />
              <Text style={styles.macroLegendText}>Fat</Text>
            </View>
          </View>
          <View style={styles.macroSectionTrack}>
            <View
              style={[
                styles.macroSection,
                styles.macroProteinSection,
                { flexBasis: 0, flexGrow: macroSectionShares[0], flexShrink: 1 },
              ]}
            >
              <Text style={[styles.macroSectionValue, styles.macroSectionTextLight]}>
                {formatGrams(protein)}
              </Text>
              <Text style={[styles.macroSectionCalories, styles.macroSectionSubTextLight]}>
                {`${formatCalories(proteinCalories)} kcal`}
              </Text>
            </View>

            <View
              style={[
                styles.macroSection,
                styles.macroCarbsSection,
                { flexBasis: 0, flexGrow: macroSectionShares[1], flexShrink: 1 },
              ]}
            >
              <Text style={[styles.macroSectionValue, styles.macroSectionTextDark]}>
                {formatGrams(carbs)}
              </Text>
              <Text style={[styles.macroSectionCalories, styles.macroSectionSubTextDark]}>
                {`${formatCalories(carbsCalories)} kcal`}
              </Text>
            </View>

            <View
              style={[
                styles.macroSection,
                styles.macroFatSection,
                { flexBasis: 0, flexGrow: macroSectionShares[2], flexShrink: 1 },
              ]}
            >
              <Text style={[styles.macroSectionValue, styles.macroSectionTextLight]}>
                {formatGrams(fat)}
              </Text>
              <Text style={[styles.macroSectionCalories, styles.macroSectionSubTextLight]}>
                {`${formatCalories(fatCalories)} kcal`}
              </Text>
            </View>
          </View>
        </View>}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => router.back()}
          style={styles.doneButton}
        >
          <Text style={styles.doneButtonText}>Done</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
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
  contentContainer: {
    paddingHorizontal: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
    color: palette.label,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.card,
  },
  metaText: {
    fontSize: 14,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  portionCard: {
    borderRadius: 14,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  quickAddCard: {
    borderRadius: 14,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  quickAddCaloriesField: {
    gap: 6,
  },
  quickAddFieldLabel: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "700",
    color: palette.secondaryLabel,
  },
  quickAddCaloriesInput: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
    color: palette.label,
    paddingHorizontal: 12,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  quickAddMacroRow: {
    flexDirection: "row",
    gap: 8,
  },
  quickAddMacroField: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  quickAddMacroInput: {
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
    color: palette.label,
    paddingHorizontal: 10,
    fontSize: 16,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  portionLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
  },
  portionValue: {
    marginTop: 4,
    fontSize: 30,
    lineHeight: 34,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  portionDecimal: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 18,
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
  },
  portionControlRow: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  portionButton: {
    minWidth: 68,
    minHeight: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.separator,
  },
  portionButtonDisabled: {
    backgroundColor: palette.tertiaryLabel,
    borderColor: palette.tertiaryLabel,
    opacity: 0.45,
  },
  portionButtonText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.tint,
    fontVariant: ["tabular-nums"],
  },
  portionButtonTextDisabled: {
    color: palette.secondaryLabel,
  },
  nutritionCard: {
    borderRadius: 14,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  macroLegendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  macroLegendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  macroLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  macroLegendText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
  },
  macroSectionTrack: {
    minHeight: 102,
    borderRadius: 14,
    overflow: "hidden",
    flexDirection: "row",
    backgroundColor: iosColor("quaternarySystemFill", "#E5E7EB"),
  },
  macroSection: {
    paddingHorizontal: 8,
    paddingVertical: 10,
    justifyContent: "center",
    gap: 2,
  },
  macroProteinSection: {
    backgroundColor: palette.macroProtein,
  },
  macroCarbsSection: {
    backgroundColor: palette.macroCarbs,
  },
  macroFatSection: {
    backgroundColor: palette.macroFat,
  },
  macroSectionValue: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  macroSectionCalories: {
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
  },
  macroSectionTextLight: {
    color: "#FFFFFF",
  },
  macroSectionTextDark: {
    color: "#111827",
  },
  macroSectionSubTextLight: {
    color: "rgba(255,255,255,0.86)",
  },
  macroSectionSubTextDark: {
    color: "rgba(17,24,39,0.72)",
  },
  doneButton: {
    marginTop: 4,
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  doneButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    gap: 8,
  },
  errorTitle: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    color: palette.label,
  },
  errorBody: {
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
});

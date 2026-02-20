import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAccount } from "jazz-tools/expo";
import { Platform, PlatformColor, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../src/jazz/schema";
import { mealLabelFor, normalizeMeal } from "../src/meals";
import {
  PORTION_DELTAS,
  formatPortionDecimal,
  formatPortionLabel,
  sanitizePortion,
} from "../src/portion";

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
  macroProtein: "#2563EB",
  macroCarbs: "#F59E0B",
  macroFat: "#14B8A6",
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

export default function EntryDetailsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ entryId?: string | string[] }>();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: { $each: { nutrition: true } } } },
  });

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  const entryId = Array.isArray(params.entryId) ? params.entryId[0] : params.entryId;
  const entry =
    entryId && me.root.logs
      ? me.root.logs.find((item) => item?.$isLoaded && item.$jazz.id === entryId) ?? null
      : null;

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
  const calories = (entry.nutrition?.calories ?? 0) * portion;
  const protein = (entry.nutrition?.protein ?? 0) * portion;
  const carbs = (entry.nutrition?.carbs ?? 0) * portion;
  const fat = (entry.nutrition?.fat ?? 0) * portion;
  const proteinCalories = protein * 4;
  const carbsCalories = carbs * 4;
  const fatCalories = fat * 9;
  const macroSectionShares = buildMacroSectionShares([proteinCalories, carbsCalories, fatCalories]);
  const meal = normalizeMeal(entry.meal);
  const mealLabel = meal ? mealLabelFor(meal) : entry.meal;
  const meta = [mealLabel, entry.brand, entry.serving].filter(Boolean).join(" • ");

  const handleAdjustPortion = (delta: number) => {
    const nextPortion = sanitizePortion(portion + delta);
    if (nextPortion === portion) {
      return;
    }

    entry.$jazz.set("portion", nextPortion);
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

        <View style={styles.nutritionCard}>
          <View style={styles.nutritionRow}>
            <Text style={styles.nutritionKey}>Calories</Text>
            <Text style={styles.nutritionValue}>{`${formatCalories(calories)} kcal`}</Text>
          </View>
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
        </View>

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
  nutritionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  nutritionKey: {
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  nutritionValue: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "600",
    color: palette.label,
    fontVariant: ["tabular-nums"],
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

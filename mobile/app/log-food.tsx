import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useAccount } from "jazz-tools/expo";
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
import { normalizeLocalDateKey } from "../src/date";
import { type SearchFood, searchFoods } from "../src/food-search";
import { mealLabelFor, normalizeMeal } from "../src/meals";
import { CaloricAccount } from "../src/jazz/schema";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: "#2563EB",
  tintDisabled: "#D1D5DB",
  buttonText: "#FFFFFF",
  searchInputBackground: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
  error: "#B91C1C",
};

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MAX_ITEMS = 20;
function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unable to search foods right now.";
}
function FoodRow({
  sourceLabel,
  name,
  meta,
  calories,
  selected,
  isLast,
  onPress,
}: {
  sourceLabel: SearchFood["sourceLabel"];
  name: string;
  meta: string;
  calories: number;
  selected: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.foodRow, !isLast && styles.foodRowDivider]}
    >
      <View style={styles.foodMain}>
        <View style={styles.foodTitleRow}>
          <Text style={styles.sourceBadge}>{sourceLabel}</Text>
          <Text style={styles.foodName}>{name}</Text>
        </View>
        <Text style={styles.foodMeta}>{meta}</Text>
      </View>
      <View style={styles.foodRight}>
        <Text style={styles.foodCalories}>{calories.toLocaleString()}</Text>
        <Text style={styles.foodUnit}>kcal</Text>
      </View>
      {selected ? <Text style={styles.selectedMark}>✓</Text> : null}
    </Pressable>
  );
}

export default function LogFoodScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ meal?: string | string[]; day?: string | string[] }>();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: true } },
  });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [foods, setFoods] = useState<SearchFood[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [query]);

  useEffect(() => {
    if (!me.$isLoaded) {
      return;
    }

    const normalizedQuery = debouncedQuery.trim();

    if (normalizedQuery.length < 2) {
      setFoods([]);
      setSelectedFoodId(null);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setIsSearching(true);
      setSearchError(null);

      try {
        const nextFoods = await searchFoods(normalizedQuery, {
          signal: controller.signal,
          maxItems: SEARCH_MAX_ITEMS,
        });
        setFoods(nextFoods);
        setSelectedFoodId((current) =>
          current && nextFoods.some((food) => food.id === current) ? current : null,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        setFoods([]);
        setSelectedFoodId(null);
        setSearchError(getErrorMessage(error));
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [debouncedQuery, me.$isLoaded]);

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading account…</Text>
      </View>
    );
  }

  const selectedMeal = normalizeMeal(params.meal) ?? "lunch";
  const selectedDay = Array.isArray(params.day) ? params.day[0] : params.day;
  const selectedDateKey = normalizeLocalDateKey(selectedDay, Date.now());
  const selectedMealLabel = mealLabelFor(selectedMeal);
  const selectedFood = foods.find((food) => food.id === selectedFoodId) || null;
  const trimmedQuery = query.trim();
  const canShowResults = trimmedQuery.length >= 2;

  const handleAddToLog = () => {
    if (!selectedFood) return;

    if (!me.root.logs) {
      me.root.$jazz.set("logs", []);
    }

    const createdAt = Date.now();

    me.root.logs?.$jazz.push({
      meal: selectedMeal,
      foodName: selectedFood.name,
      brand: selectedFood.brand,
      serving: selectedFood.serving,
      portion: 1,
      nutrition: selectedFood.nutrition
        ? {
            calories: selectedFood.nutrition.calories,
            protein: selectedFood.nutrition.protein,
            carbs: selectedFood.nutrition.carbs,
            fat: selectedFood.nutrition.fat,
            fiber: selectedFood.nutrition.fiber,
            sugars: selectedFood.nutrition.sugars,
            sodiumMg: selectedFood.nutrition.sodiumMg,
            potassiumMg: selectedFood.nutrition.potassiumMg,
          }
        : undefined,
      createdAt,
      dateKey: selectedDateKey,
    });

    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/");
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: insets.bottom + 96,
          },
        ]}
      >
        <Text style={styles.largeTitle}>Foods</Text>
        <Text style={styles.subtitle}>
          Search and pick one item to add to {selectedMealLabel.toLowerCase()}
        </Text>

        <View style={styles.searchCard}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search foods (example: banana)"
            placeholderTextColor={palette.secondaryLabel}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>

        {!canShowResults ? (
          <Text style={styles.helperText}>Enter at least 2 characters to search.</Text>
        ) : null}
        {canShowResults && isSearching ? <Text style={styles.helperText}>Searching…</Text> : null}
        {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}

        {canShowResults && !isSearching && !searchError && foods.length === 0 ? (
          <Text style={styles.helperText}>{`No foods found for "${trimmedQuery}".`}</Text>
        ) : null}

        {foods.length > 0 ? (
          <View style={styles.card}>
            {foods.map((food, index) => {
              const calories = food.nutrition?.calories ?? 0;
              const meta =
                [food.brand, food.serving].filter(Boolean).join(" • ") ||
                "No serving details";

              return (
                <FoodRow
                  key={food.id}
                  sourceLabel={food.sourceLabel}
                  name={food.name}
                  meta={meta}
                  calories={calories}
                  selected={selectedFoodId === food.id}
                  isLast={index === foods.length - 1}
                  onPress={() => setSelectedFoodId(food.id)}
                />
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.actionBarContainer, { paddingBottom: insets.bottom + 12 }]}>
        {canUseGlass ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor="rgba(255,255,255,0.2)"
            style={StyleSheet.absoluteFillObject}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!selectedFood}
          onPress={handleAddToLog}
          style={[styles.actionButton, !selectedFood && styles.actionButtonDisabled]}
        >
          <Text style={styles.actionButtonText}>Add to {selectedMealLabel}</Text>
        </Pressable>
      </View>
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
    paddingHorizontal: 4,
  },
  subtitle: {
    marginTop: 2,
    marginBottom: 14,
    paddingHorizontal: 4,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  card: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  searchCard: {
    backgroundColor: palette.card,
    borderRadius: 14,
    padding: 12,
  },
  searchInput: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: palette.searchInputBackground,
    color: palette.label,
    paddingHorizontal: 12,
    fontSize: 16,
    lineHeight: 20,
  },
  helperText: {
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 4,
    fontSize: 14,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  errorText: {
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 4,
    fontSize: 14,
    lineHeight: 18,
    color: palette.error,
  },
  foodRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  foodRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.separator,
  },
  foodMain: {
    flex: 1,
  },
  foodTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sourceBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    color: palette.tint,
    backgroundColor: "rgba(37,99,235,0.12)",
  },
  foodName: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  foodMeta: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  foodRight: {
    alignItems: "flex-end",
    minWidth: 64,
  },
  foodCalories: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  foodUnit: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    color: palette.secondaryLabel,
  },
  selectedMark: {
    fontSize: 18,
    lineHeight: 22,
    color: palette.tint,
    fontWeight: "700",
  },
  actionBarContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: "rgba(255,255,255,0.35)",
    overflow: "hidden",
  },
  actionButton: {
    borderRadius: 12,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  actionButtonDisabled: {
    backgroundColor: palette.tintDisabled,
  },
  actionButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.buttonText,
  },
});

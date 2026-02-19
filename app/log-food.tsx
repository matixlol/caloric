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
const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

type MfpNutritionalContents = {
  energy?: {
    value?: unknown;
  };
  protein?: unknown;
  carbohydrates?: unknown;
  fat?: unknown;
  fiber?: unknown;
  sugar?: unknown;
  sodium?: unknown;
  potassium?: unknown;
};

type MfpServingSize = {
  value?: unknown;
  unit?: unknown;
};

type MfpFood = {
  id?: unknown;
  version?: unknown;
  description?: unknown;
  brand_name?: unknown;
  serving_sizes?: unknown;
  nutritional_contents?: MfpNutritionalContents | null;
};

type SearchPayload = {
  search?: {
    data?: {
      items?: { item?: MfpFood | null }[];
    } | null;
  } | null;
  details?: {
    foodId?: unknown;
    version?: unknown;
    status?: unknown;
    data?: MfpFood | null;
  }[] | null;
  error?: unknown;
  message?: unknown;
};

type SearchFood = {
  id: string;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugars?: number;
    sodiumMg?: number;
    potassiumMg?: number;
  };
};

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function formatServing(servingSizes: unknown): string | undefined {
  if (!Array.isArray(servingSizes)) {
    return undefined;
  }

  for (const candidate of servingSizes) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const serving = candidate as MfpServingSize;
    const value = asNumber(serving.value);
    const unit = asString(serving.unit);

    if (value !== undefined && unit) {
      return `${value} ${unit}`;
    }

    if (value !== undefined) {
      return String(value);
    }

    if (unit) {
      return unit;
    }
  }

  return undefined;
}

function mapNutrition(contents: MfpNutritionalContents | null | undefined): SearchFood["nutrition"] {
  if (!contents) {
    return undefined;
  }

  const nutrition = {
    calories: asNumber(contents.energy?.value),
    protein: asNumber(contents.protein),
    carbs: asNumber(contents.carbohydrates),
    fat: asNumber(contents.fat),
    fiber: asNumber(contents.fiber),
    sugars: asNumber(contents.sugar),
    sodiumMg: asNumber(contents.sodium),
    potassiumMg: asNumber(contents.potassium),
  };

  if (Object.values(nutrition).every((value) => value === undefined)) {
    return undefined;
  }

  return nutrition;
}

function mapSearchResults(payload: SearchPayload): SearchFood[] {
  const detailById = new Map<string, MfpFood>();
  const details = payload.details ?? [];

  for (const detail of details) {
    if (!detail || typeof detail !== "object") {
      continue;
    }

    const status = asNumber(detail.status);
    if (status !== 200 || !detail.data || typeof detail.data !== "object") {
      continue;
    }

    const foodId = asString(detail.foodId);
    const version = asString(detail.version);
    if (!foodId || !version) {
      continue;
    }

    detailById.set(`${foodId}:${version}`, detail.data);
  }

  const items = payload.search?.data?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const results: SearchFood[] = [];
  const seen = new Set<string>();

  for (const row of items) {
    const item = row?.item;
    if (!item || typeof item !== "object") {
      continue;
    }

    const foodId = asString(item.id);
    const version = asString(item.version);
    if (!foodId || !version) {
      continue;
    }

    const compositeId = `${foodId}:${version}`;
    if (seen.has(compositeId)) {
      continue;
    }
    seen.add(compositeId);

    const detail = detailById.get(compositeId);
    const source = detail ?? item;
    const name = asString(source.description) ?? asString(item.description);
    if (!name) {
      continue;
    }

    const brand = asString(source.brand_name) ?? asString(item.brand_name);
    const serving = formatServing(source.serving_sizes) ?? formatServing(item.serving_sizes);
    const nutrition = mapNutrition(source.nutritional_contents ?? item.nutritional_contents);

    results.push({
      id: compositeId,
      name,
      brand,
      serving,
      nutrition,
    });
  }

  return results;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unable to search foods right now.";
}

async function searchFoods(query: string, signal: AbortSignal): Promise<SearchFood[]> {
  const url = new URL("/search", `${BACKEND_BASE_URL}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("maxItems", String(SEARCH_MAX_ITEMS));
  url.searchParams.set("includeDetails", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
  });

  let payload: SearchPayload | null = null;
  try {
    payload = (await response.json()) as SearchPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiMessage = payload ? asString(payload.message) : undefined;
    throw new Error(apiMessage ?? `Search request failed with ${response.status}`);
  }

  if (payload?.error) {
    throw new Error(asString(payload.message) ?? "Search request failed.");
  }

  return mapSearchResults(payload ?? {});
}

function FoodRow({
  name,
  meta,
  calories,
  selected,
  isLast,
  onPress,
}: {
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
        <Text style={styles.foodName}>{name}</Text>
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
  const params = useLocalSearchParams<{ meal?: string | string[] }>();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: true } },
  });
  const [query, setQuery] = useState("");
  const [foods, setFoods] = useState<SearchFood[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  useEffect(() => {
    if (!me.$isLoaded) {
      return;
    }

    const normalizedQuery = query.trim();

    if (normalizedQuery.length < 2) {
      setFoods([]);
      setSelectedFoodId(null);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setIsSearching(true);
      setSearchError(null);

      try {
        const nextFoods = await searchFoods(normalizedQuery, controller.signal);
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
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [me.$isLoaded, query]);

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading account…</Text>
      </View>
    );
  }

  const selectedMeal = normalizeMeal(params.meal) ?? "lunch";
  const selectedMealLabel = mealLabelFor(selectedMeal);
  const selectedFood = foods.find((food) => food.id === selectedFoodId) || null;
  const trimmedQuery = query.trim();
  const canShowResults = trimmedQuery.length >= 2;

  const handleAddToLog = () => {
    if (!selectedFood) return;

    if (!me.root.logs) {
      me.root.$jazz.set("logs", []);
    }

    me.root.logs?.$jazz.push({
      meal: selectedMeal,
      foodName: selectedFood.name,
      brand: selectedFood.brand,
      serving: selectedFood.serving,
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
      createdAt: Date.now(),
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

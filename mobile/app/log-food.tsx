import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
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
import {
  type SearchFood,
  type SearchFoodsBySource,
  type SearchFoodSource,
  searchFoods,
} from "../src/food-search";
import { MacroBadges } from "../src/components/MacroBadges";
import { useAllFoodEntries, useDataStoreActions, useDataStoreReady } from "../src/data/DataProvider";
import { mealLabelFor, normalizeMeal } from "../src/meals";

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
  badgeBackground: iosColor("quaternarySystemFill", "#E5E7EB"),
  badgeSelectedBackground: "#E8EEFF",
  badgeSelectedBorder: "#BDD0FF",
  badgeText: iosColor("tertiaryLabel", "#6B7280"),
  buttonText: "#FFFFFF",
  searchInputBackground: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
  error: "#B91C1C",
};

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MAX_ITEMS = 20;
const RECENT_ITEMS_LIMIT = 50;
type SearchProviderFilter = "all" | SearchFoodSource;

const PROVIDER_FILTERS: { key: SearchProviderFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mfp", label: "MFP" },
  { key: "openfoodfacts", label: "OFF" },
  { key: "anmat", label: "ANMAT" },
];

function createEmptyFoodsBySource(): SearchFoodsBySource {
  return {
    anmat: [],
    openfoodfacts: [],
    mfp: [],
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Unable to search foods right now.";
  }

  return "Unknown error.";
}

function FoodRow({
  sourceLabel,
  name,
  brand,
  serving,
  nutrition,
  selected,
  isLast,
  onPress,
}: {
  sourceLabel?: SearchFood["sourceLabel"] | null;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: SearchFood["nutrition"];
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
        <View style={styles.foodMetaRow}>
          {brand ? <Text style={styles.foodMeta}>{brand}</Text> : null}
          {sourceLabel ? <Text style={styles.inlineSourceBadge}>{sourceLabel}</Text> : null}
          {serving ? <Text style={styles.foodMeta}>{brand ? `• ${serving}` : serving}</Text> : null}
          {!brand && !serving ? <Text style={styles.foodMeta}>No serving details</Text> : null}
        </View>
        <MacroBadges nutrition={nutrition} />
      </View>
      {selected ? <Text style={styles.selectedMark}>✓</Text> : null}
    </Pressable>
  );
}

export default function LogFoodScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ meal?: string | string[]; day?: string | string[] }>();
  const isDataReady = useDataStoreReady();
  const { data: allFoodEntries } = useAllFoodEntries();
  const { createFoodEntry } = useDataStoreActions();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [foods, setFoods] = useState<SearchFood[]>([]);
  const [foodsBySource, setFoodsBySource] = useState<SearchFoodsBySource>(createEmptyFoodsBySource);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const [selectedRecentEntryId, setSelectedRecentEntryId] = useState<string | null>(null);
  const [activeProviderFilter, setActiveProviderFilter] = useState<SearchProviderFilter>("all");
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
    if (!isDataReady) {
      return;
    }

    const normalizedQuery = debouncedQuery.trim();

    if (normalizedQuery.length < 2) {
      setFoods([]);
      setFoodsBySource(createEmptyFoodsBySource());
      setSelectedFoodId(null);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setFoods([]);
      setFoodsBySource(createEmptyFoodsBySource());
      setSelectedFoodId(null);
      setIsSearching(true);
      setSearchError(null);

      try {
        const nextFoods = await searchFoods(normalizedQuery, {
          signal: controller.signal,
          maxItems: SEARCH_MAX_ITEMS,
          onProgress: (progress) => {
            setFoods(progress.foods);
            setFoodsBySource(progress.foodsBySource);
          },
        });
        setFoods(nextFoods);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        setFoods([]);
        setFoodsBySource(createEmptyFoodsBySource());
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
  }, [debouncedQuery, isDataReady]);

  if (!isDataReady) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading data…</Text>
      </View>
    );
  }

  const selectedMeal = normalizeMeal(params.meal) ?? "lunch";
  const selectedDay = Array.isArray(params.day) ? params.day[0] : params.day;
  const selectedDateKey = normalizeLocalDateKey(selectedDay, Date.now());
  const selectedMealLabel = mealLabelFor(selectedMeal);
  const trimmedQuery = query.trim();
  const canShowResults = trimmedQuery.length >= 2;
  const recentEntries = allFoodEntries.slice(-RECENT_ITEMS_LIMIT).reverse();
  const allFetchedFoods = [
    ...foodsBySource.anmat,
    ...foodsBySource.openfoodfacts,
    ...foodsBySource.mfp,
  ];
  const selectedFood =
    canShowResults ? allFetchedFoods.find((food) => food.id === selectedFoodId) || null : null;
  const selectedRecentEntry =
    !canShowResults
      ? recentEntries.find((entry) => entry.id === selectedRecentEntryId) || null
      : null;
  const providerCounts: Record<SearchFoodSource, number> = {
    anmat: foodsBySource.anmat.length,
    openfoodfacts: foodsBySource.openfoodfacts.length,
    mfp: foodsBySource.mfp.length,
  };
  const visibleFoods = activeProviderFilter === "all" ? foods : foodsBySource[activeProviderFilter];

  const handleAddToLog = () => {
    const createdAt = Date.now();

    if (selectedFood) {
      void createFoodEntry({
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
    } else if (selectedRecentEntry) {
      void createFoodEntry({
        meal: selectedMeal,
        foodName: selectedRecentEntry.foodName,
        brand: selectedRecentEntry.brand,
        serving: selectedRecentEntry.serving,
        portion: selectedRecentEntry.portion,
        nutrition: selectedRecentEntry.nutrition,
        createdAt,
        dateKey: selectedDateKey,
      });
    } else {
      return;
    }

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
          <>
            <Text style={styles.sectionTitle}>Recent</Text>
            {recentEntries.length > 0 ? (
              <View style={styles.card}>
                {recentEntries.map((entry, index) => (
                  <FoodRow
                    key={entry.id}
                    name={entry.foodName}
                    brand={entry.brand}
                    serving={entry.serving}
                    nutrition={entry.nutrition}
                    selected={selectedRecentEntryId === entry.id}
                    isLast={index === recentEntries.length - 1}
                    onPress={() => {
                      setSelectedRecentEntryId(entry.id);
                      setSelectedFoodId(null);
                    }}
                  />
                ))}
              </View>
            ) : (
              <Text style={styles.helperText}>No recent items yet.</Text>
            )}
          </>
        ) : null}
        {canShowResults ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.providerFilterRow}
          >
            {PROVIDER_FILTERS.map((filter) => {
              const isActive = activeProviderFilter === filter.key;
              const count = filter.key === "all" ? foods.length : providerCounts[filter.key];

              return (
                <Pressable
                  key={filter.key}
                  accessibilityRole="button"
                  onPress={() => setActiveProviderFilter(filter.key)}
                  style={[styles.providerChip, isActive && styles.providerChipActive]}
                >
                  <Text style={[styles.providerChipText, isActive && styles.providerChipTextActive]}>
                    {filter.label}
                  </Text>
                  <Text style={[styles.providerChipCount, isActive && styles.providerChipCountActive]}>
                    {count}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        {canShowResults && isSearching ? (
          <Text style={styles.helperText}>
            Searching MFP, OpenFoodFacts, and ANMAT. Results appear as each source returns.
          </Text>
        ) : null}
        {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}

        {canShowResults && !isSearching && !searchError && foods.length === 0 ? (
          <Text style={styles.helperText}>{`No foods found for "${trimmedQuery}".`}</Text>
        ) : null}
        {canShowResults && !isSearching && !searchError && foods.length > 0 && visibleFoods.length === 0 ? (
          <Text style={styles.helperText}>{`No results from that source for "${trimmedQuery}".`}</Text>
        ) : null}

        {visibleFoods.length > 0 ? (
          <View style={styles.card}>
            {visibleFoods.map((food, index) => {
              return (
                <FoodRow
                  key={food.id}
                  sourceLabel={food.sourceLabel}
                  name={food.name}
                  brand={food.brand}
                  serving={food.serving}
                  nutrition={food.nutrition}
                  selected={selectedFoodId === food.id}
                  isLast={index === visibleFoods.length - 1}
                  onPress={() => {
                    setSelectedFoodId(food.id);
                    setSelectedRecentEntryId(null);
                  }}
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
          disabled={!selectedFood && !selectedRecentEntry}
          onPress={handleAddToLog}
          style={[
            styles.actionButton,
            !selectedFood && !selectedRecentEntry && styles.actionButtonDisabled,
          ]}
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
  sectionTitle: {
    marginTop: 12,
    marginBottom: 10,
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
  providerFilterRow: {
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 10,
  },
  providerChip: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: palette.separator,
    borderRadius: 9,
    backgroundColor: palette.card,
    paddingHorizontal: 10,
  },
  providerChipActive: {
    borderColor: palette.badgeSelectedBorder,
    backgroundColor: palette.badgeSelectedBackground,
  },
  providerChipText: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: "600",
    color: palette.label,
  },
  providerChipTextActive: {
    color: palette.tint,
  },
  providerChipCount: {
    fontSize: 12,
    lineHeight: 14,
    color: palette.secondaryLabel,
  },
  providerChipCountActive: {
    color: palette.tint,
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
  foodMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  foodMeta: {
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  inlineSourceBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
    color: palette.badgeText,
    backgroundColor: palette.badgeBackground,
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

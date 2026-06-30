import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type * as ExpoHaptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { normalizeLocalDateKey } from "../src/date";
import {
  type DisplayedFoodSource,
  DISPLAYED_SOURCE_ORDER,
  type SearchFood,
  type SearchFoodsBySource,
  SEARCH_MAX_PAGES,
  SEARCH_PAGE_SIZE,
  appendUniqueFoods,
  createEmptyFoodsBySource,
  fetchFoodSourcePage,
  interleaveFoods,
  queueAnmatQuery,
} from "../src/food-search";
import { MacroBadges } from "../src/components/MacroBadges";
import { useAllFoodEntries, useDataStoreActions, useDataStoreReady } from "../src/data/DataProvider";
import type { FoodEntryRecord } from "../src/data/store";
import { mealLabelFor, normalizeMeal } from "../src/meals";
import { formatMixedQuarter, formatPortionLabel, sanitizePortion } from "../src/portion";
import {
  QUICK_ADD_FOOD_NAME,
  QUICK_ADD_MANUAL_SERVING,
  isQuickAddEntry,
  parseCalorieInput,
  parseOptionalMacroInput,
} from "../src/quickAdd";

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
const RECENT_ITEMS_LIMIT = 50;
// Trigger loading the next page once the user scrolls within this many points
// of the bottom of the list.
const INFINITE_SCROLL_THRESHOLD_PX = 360;
const QUICK_ADD_DEFAULT_CALORIES = 250;
const QUICK_ADD_MIN_CALORIES = 50;
const QUICK_ADD_SLIDER_MAX_CALORIES = 600;
const QUICK_ADD_CALORIE_STEP = 50;
const QUICK_ADD_DRAG_STEP_PX = 25;
const QUICK_ADD_FIRST_STEP_OFFSET_PX = 54;
const QUICK_ADD_LONG_PRESS_MS = 260;
type SearchProviderFilter = "all" | DisplayedFoodSource;

const PROVIDER_FILTERS: { key: SearchProviderFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mfp", label: "MFP" },
  { key: "openfoodfacts", label: "OFF" },
];

function createEmptyHasMore(): Record<DisplayedFoodSource, boolean> {
  return {
    openfoodfacts: false,
    mfp: false,
  };
}

const QUICK_ADD_CALORIE_VALUES = Array.from(
  {
    length:
      (QUICK_ADD_SLIDER_MAX_CALORIES - QUICK_ADD_MIN_CALORIES) / QUICK_ADD_CALORIE_STEP + 1,
  },
  (_, index) => QUICK_ADD_MIN_CALORIES + index * QUICK_ADD_CALORIE_STEP,
);
const QUICK_ADD_REVERSED_CALORIE_VALUES = [...QUICK_ADD_CALORIE_VALUES].reverse();

const PORTION_DRAG_STEP_PX = 25;
const PORTION_FIRST_STEP_OFFSET_PX = 54;
// Whole-number rows render 2x taller in the rail, so they cost 2x the drag to
// cross — keeps the highlight tracking the rail you actually see.
const PORTION_WHOLE_STEP_WEIGHT = 2;
// 1/4 through 3 portions in quarter steps: [0.25, 0.5, ..., 3]
const PORTION_SLIDER_VALUES = Array.from({ length: 12 }, (_, index) => (index + 1) * 0.25);
const PORTION_REVERSED_SLIDER_VALUES = [...PORTION_SLIDER_VALUES].reverse();
// Cumulative drag distance (after the dead zone) at which each value is centered,
// weighting whole-number steps so they match their taller rows.
const PORTION_SLIDER_DRAG_OFFSETS = PORTION_SLIDER_VALUES.reduce<number[]>(
  (offsets, value, index) => {
    if (index === 0) {
      offsets.push(0);
      return offsets;
    }

    const prevWeight = Number.isInteger(PORTION_SLIDER_VALUES[index - 1])
      ? PORTION_WHOLE_STEP_WEIGHT
      : 1;
    const currentWeight = Number.isInteger(value) ? PORTION_WHOLE_STEP_WEIGHT : 1;
    const stepPx = (PORTION_DRAG_STEP_PX * (prevWeight + currentWeight)) / 2;
    offsets.push(offsets[index - 1] + stepPx);
    return offsets;
  },
  [],
);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Unable to search foods right now.";
  }

  return "Unknown error.";
}

function formatCalories(value: number): string {
  return Math.round(value).toLocaleString();
}

function getCaloriesFromDragDelta(deltaY: number): number | null {
  const upwardDrag = -deltaY;
  const sliderDrag = upwardDrag - QUICK_ADD_FIRST_STEP_OFFSET_PX;
  if (sliderDrag < 0) {
    return null;
  }

  const deltaSteps = Math.round(sliderDrag / QUICK_ADD_DRAG_STEP_PX);
  const nextIndex = Math.min(
    QUICK_ADD_CALORIE_VALUES.length - 1,
    Math.max(0, deltaSteps),
  );

  return QUICK_ADD_CALORIE_VALUES[nextIndex];
}

function getPortionFromDragDelta(deltaY: number): number | null {
  const upwardDrag = -deltaY;
  const sliderDrag = upwardDrag - PORTION_FIRST_STEP_OFFSET_PX;
  if (sliderDrag < 0) {
    return null;
  }

  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < PORTION_SLIDER_DRAG_OFFSETS.length; index += 1) {
    const distance = Math.abs(sliderDrag - PORTION_SLIDER_DRAG_OFFSETS[index]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return PORTION_SLIDER_VALUES[nearestIndex];
}

function logQuickAddGesture(event: string, details?: Record<string, unknown>) {
  if (!__DEV__) {
    return;
  }

  console.log(`[quick-add] ${event}`, details ?? {});
}

function triggerSelectionHaptic() {
  if (Platform.OS === "web") {
    return;
  }

  const Haptics = require("expo-haptics") as typeof ExpoHaptics;
  void Haptics.selectionAsync().catch(() => {});
}

function triggerImpactHaptic() {
  if (Platform.OS === "web") {
    return;
  }

  const Haptics = require("expo-haptics") as typeof ExpoHaptics;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

function normalizeSearchText(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function buildRecentEntryKey(entry: FoodEntryRecord): string {
  return [
    normalizeSearchText(entry.foodName),
    normalizeSearchText(entry.brand),
    normalizeSearchText(entry.serving),
    formatPortionLabel(entry.portion),
  ].join("|");
}

function matchesRecentEntry(entry: FoodEntryRecord, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  const searchableText = normalizeSearchText(
    [entry.foodName, entry.brand, entry.serving].filter(Boolean).join(" "),
  );

  return tokens.every((token) => searchableText.includes(token));
}

function getRecentSearchMatches(entries: FoodEntryRecord[], query: string): FoodEntryRecord[] {
  const matches: FoodEntryRecord[] = [];
  const seenKeys = new Set<string>();

  for (const entry of entries) {
    if (!matchesRecentEntry(entry, query)) {
      continue;
    }

    const dedupeKey = buildRecentEntryKey(entry);
    if (seenKeys.has(dedupeKey)) {
      continue;
    }

    seenKeys.add(dedupeKey);
    matches.push(entry);
  }

  return matches;
}

function FoodRow({
  sourceLabel,
  name,
  brand,
  serving,
  portionLabel,
  nutritionMultiplier = 1,
  nutrition,
  selected,
  isLast,
  onPress,
}: {
  sourceLabel?: SearchFood["sourceLabel"] | null;
  name: string;
  brand?: string;
  serving?: string;
  portionLabel?: string;
  nutritionMultiplier?: number;
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
          {portionLabel ? <Text style={styles.foodMeta}>{portionLabel}</Text> : null}
          {brand ? (
            <Text style={styles.foodMeta}>{portionLabel ? `• ${brand}` : brand}</Text>
          ) : null}
          {sourceLabel ? <Text style={styles.inlineSourceBadge}>{sourceLabel}</Text> : null}
          {serving ? (
            <Text style={styles.foodMeta}>{portionLabel || brand ? `• ${serving}` : serving}</Text>
          ) : null}
          {!portionLabel && !brand && !serving ? (
            <Text style={styles.foodMeta}>No serving details</Text>
          ) : null}
        </View>
        <MacroBadges nutrition={nutrition} multiplier={nutritionMultiplier} />
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
  const [foodsBySource, setFoodsBySource] = useState<SearchFoodsBySource>(createEmptyFoodsBySource);
  // Append-only interleaved list for the "All" tab. Each loaded page is
  // interleaved once into a block and appended, so earlier results never shift.
  const [mergedFoods, setMergedFoods] = useState<SearchFood[]>([]);
  const [hasMoreBySource, setHasMoreBySource] =
    useState<Record<DisplayedFoodSource, boolean>>(createEmptyHasMore);
  const [loadedPage, setLoadedPage] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const [selectedRecentEntryId, setSelectedRecentEntryId] = useState<string | null>(null);
  const [activeProviderFilter, setActiveProviderFilter] = useState<SearchProviderFilter>("all");
  const [isQuickAddExpanded, setIsQuickAddExpanded] = useState(false);
  const [isQuickAddPickerActive, setIsQuickAddPickerActive] = useState(false);
  const [quickAddCaloriesText, setQuickAddCaloriesText] = useState(
    String(QUICK_ADD_DEFAULT_CALORIES),
  );
  const [quickAddProteinText, setQuickAddProteinText] = useState("");
  const [quickAddCarbsText, setQuickAddCarbsText] = useState("");
  const [quickAddFatText, setQuickAddFatText] = useState("");
  const [quickAddSliderCalories, setQuickAddSliderCalories] = useState<number | null>(null);
  const [isPortionPickerActive, setIsPortionPickerActive] = useState(false);
  const [portionSliderValue, setPortionSliderValue] = useState<number | null>(null);
  const [keyboardBottomOffset, setKeyboardBottomOffset] = useState(0);
  const isQuickAddExpandedRef = useRef(false);
  const isQuickAddPickerActiveRef = useRef(false);
  const isQuickAddLongPressingRef = useRef(false);
  const quickAddDragCaloriesRef = useRef<number | null>(null);
  const quickAddLongPressStartDeltaYRef = useRef(0);
  const isPortionLongPressingRef = useRef(false);
  const portionDragValueRef = useRef<number | null>(null);
  const portionLongPressStartDeltaYRef = useRef(0);
  const canAddToLogRef = useRef(false);
  const addToLogRef = useRef<(portionOverride?: number) => void>(() => {});
  // Aborts the in-flight search (and any in-flight load-more) when the query
  // changes or the screen unmounts.
  const searchControllerRef = useRef<AbortController | null>(null);
  // Guards against re-entrant load-more requests fired by rapid scroll events.
  const loadingMoreRef = useRef(false);
  // canonicalKeys already placed in mergedFoods, so appended pages skip
  // duplicates without re-deriving (and reordering) the whole list.
  const mergedKeysRef = useRef<Set<string>>(new Set());
  // Snapshot of the state load-more needs, refreshed every render to avoid
  // stale closures inside the scroll handler.
  const loadMoreStateRef = useRef({
    hasMoreBySource,
    loadedPage,
    activeProviderFilter,
    activeQuery: "",
    isSearching,
  });
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  const selectedMeal = normalizeMeal(params.meal) ?? "lunch";
  const selectedDay = Array.isArray(params.day) ? params.day[0] : params.day;
  const selectedDateKey = normalizeLocalDateKey(selectedDay, Date.now());
  const selectedMealLabel = mealLabelFor(selectedMeal);
  const parsedQuickAddCalories = parseCalorieInput(quickAddCaloriesText);
  const parsedQuickAddProtein = parseOptionalMacroInput(quickAddProteinText);
  const parsedQuickAddCarbs = parseOptionalMacroInput(quickAddCarbsText);
  const parsedQuickAddFat = parseOptionalMacroInput(quickAddFatText);
  const isQuickAddButtonActive = isQuickAddExpanded || isQuickAddPickerActive;
  const canQuickAdd =
    parsedQuickAddCalories !== null &&
    parsedQuickAddProtein !== null &&
    parsedQuickAddCarbs !== null &&
    parsedQuickAddFat !== null;
  const activeQuery = debouncedQuery.trim();
  const foods = mergedFoods;

  loadMoreStateRef.current = {
    hasMoreBySource,
    loadedPage,
    activeProviderFilter,
    activeQuery,
    isSearching,
  };

  isQuickAddExpandedRef.current = isQuickAddExpanded;
  isQuickAddPickerActiveRef.current = isQuickAddPickerActive;

  const navigateAfterAdd = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/");
  }, [router]);

  const handleQuickAddToLog = useCallback(
    (caloriesOverride?: number) => {
      const isCaloriesOnlyOverride = caloriesOverride !== undefined;
      const calories = caloriesOverride ?? parsedQuickAddCalories;
      if (calories === null) {
        return false;
      }

      if (
        !isCaloriesOnlyOverride &&
        (parsedQuickAddProtein === null ||
          parsedQuickAddCarbs === null ||
          parsedQuickAddFat === null)
      ) {
        return false;
      }

      const nutrition: NonNullable<FoodEntryRecord["nutrition"]> = { calories };
      if (!isCaloriesOnlyOverride) {
        if (typeof parsedQuickAddProtein === "number") {
          nutrition.protein = parsedQuickAddProtein;
        }
        if (typeof parsedQuickAddCarbs === "number") {
          nutrition.carbs = parsedQuickAddCarbs;
        }
        if (typeof parsedQuickAddFat === "number") {
          nutrition.fat = parsedQuickAddFat;
        }
      }

      logQuickAddGesture("add-entry", {
        calories,
        meal: selectedMeal,
        mode: isCaloriesOnlyOverride ? "hold" : "typed",
      });

      void createFoodEntry({
        meal: selectedMeal,
        foodName: QUICK_ADD_FOOD_NAME,
        serving: QUICK_ADD_MANUAL_SERVING,
        portion: 1,
        nutrition,
        createdAt: Date.now(),
        dateKey: selectedDateKey,
      });

      navigateAfterAdd();
      return true;
    },
    [
      createFoodEntry,
      navigateAfterAdd,
      parsedQuickAddCalories,
      parsedQuickAddCarbs,
      parsedQuickAddFat,
      parsedQuickAddProtein,
      selectedDateKey,
      selectedMeal,
    ],
  );

  const applyQuickAddDragCalories = useCallback((deltaY: number) => {
    const nextCalories = getCaloriesFromDragDelta(deltaY);
    if (quickAddDragCaloriesRef.current === nextCalories) {
      return;
    }

    quickAddDragCaloriesRef.current = nextCalories;
    logQuickAddGesture("move:value-change", {
      deltaY,
      nextCalories,
      firstStepOffset: QUICK_ADD_FIRST_STEP_OFFSET_PX,
      stepPx: QUICK_ADD_DRAG_STEP_PX,
    });
    setQuickAddSliderCalories(nextCalories);
    if (nextCalories !== null) {
      triggerSelectionHaptic();
    }
  }, []);

  const toggleQuickAddPanel = useCallback(() => {
    logQuickAddGesture("tap:toggle-panel", {
      wasExpanded: isQuickAddExpandedRef.current,
      wasPickerActive: isQuickAddPickerActiveRef.current,
    });
    setIsQuickAddExpanded((isExpanded) => !isExpanded);
    setIsQuickAddPickerActive(false);
    setSelectedFoodId(null);
    setSelectedRecentEntryId(null);
  }, []);

  const startQuickAddPicker = useCallback((startTranslationY: number) => {
    logQuickAddGesture("long-press:start-picker", {
      startTranslationY,
      firstSelectableCalories: QUICK_ADD_MIN_CALORIES,
    });
    isQuickAddLongPressingRef.current = true;
    quickAddLongPressStartDeltaYRef.current = startTranslationY;
    quickAddDragCaloriesRef.current = null;
    setQuickAddSliderCalories(null);
    setIsQuickAddExpanded(false);
    setIsQuickAddPickerActive(true);
    setSelectedFoodId(null);
    setSelectedRecentEntryId(null);
    triggerSelectionHaptic();
  }, []);

  const finishQuickAddHoldGesture = useCallback(() => {
    if (!isQuickAddLongPressingRef.current) {
      logQuickAddGesture("release:hold-without-active");
      return;
    }

    const selectedCalories = quickAddDragCaloriesRef.current;
    logQuickAddGesture("release:hold", {
      selectedCalories,
      longPressStartDeltaY: quickAddLongPressStartDeltaYRef.current,
    });
    isQuickAddLongPressingRef.current = false;
    setIsQuickAddPickerActive(false);
    setIsQuickAddExpanded(false);
    if (selectedCalories === null) {
      logQuickAddGesture("release:hold-empty");
      return;
    }

    setQuickAddCaloriesText(String(selectedCalories));
    const didAdd = handleQuickAddToLog(selectedCalories);
    logQuickAddGesture("release:hold-add", {
      selectedCalories,
      didAdd,
    });
    triggerImpactHaptic();
  }, [handleQuickAddToLog]);

  const cancelQuickAddGesture = useCallback(() => {
    logQuickAddGesture("terminate", {
      wasLongPressing: isQuickAddLongPressingRef.current,
      calories: quickAddDragCaloriesRef.current,
    });
    isQuickAddLongPressingRef.current = false;
    setIsQuickAddPickerActive(false);
    setIsQuickAddExpanded(false);
  }, []);

  const quickAddGesture = useMemo(() => {
    const holdDragGesture = Gesture.Pan()
      .activateAfterLongPress(QUICK_ADD_LONG_PRESS_MS)
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onBegin(() => {
        logQuickAddGesture("grant", {
          isExpanded: isQuickAddExpandedRef.current,
          isPickerActive: isQuickAddPickerActiveRef.current,
        });
        isQuickAddLongPressingRef.current = false;
        quickAddLongPressStartDeltaYRef.current = 0;
      })
      .onStart((event) => {
        startQuickAddPicker(event.translationY);
      })
      .onUpdate((event) => {
        if (!isQuickAddLongPressingRef.current) {
          return;
        }

        const adjustedDy = event.translationY - quickAddLongPressStartDeltaYRef.current;
        logQuickAddGesture("move:active", {
          dx: event.translationX,
          dy: event.translationY,
          adjustedDy,
        });
        applyQuickAddDragCalories(adjustedDy);
      })
      .onEnd((_event, success) => {
        logQuickAddGesture("pan:end", { success });
        if (success) {
          finishQuickAddHoldGesture();
        }
      })
      .onFinalize((_event, success) => {
        logQuickAddGesture("pan:finalize", {
          success,
          wasLongPressing: isQuickAddLongPressingRef.current,
        });
        if (!success && isQuickAddLongPressingRef.current) {
          cancelQuickAddGesture();
        }
      });

    const tapGesture = Gesture.Tap()
      .maxDuration(QUICK_ADD_LONG_PRESS_MS)
      .maxDistance(16)
      .runOnJS(true)
      .onEnd((_event, success) => {
        logQuickAddGesture("tap:end", { success });
        if (success) {
          toggleQuickAddPanel();
        }
      });

    return Gesture.Exclusive(holdDragGesture, tapGesture);
  }, [
    applyQuickAddDragCalories,
    cancelQuickAddGesture,
    finishQuickAddHoldGesture,
    startQuickAddPicker,
    toggleQuickAddPanel,
  ]);

  const applyPortionDragValue = useCallback((deltaY: number) => {
    const nextPortion = getPortionFromDragDelta(deltaY);
    if (portionDragValueRef.current === nextPortion) {
      return;
    }

    portionDragValueRef.current = nextPortion;
    setPortionSliderValue(nextPortion);
    if (nextPortion !== null) {
      triggerSelectionHaptic();
    }
  }, []);

  const startPortionPicker = useCallback((startTranslationY: number) => {
    if (!canAddToLogRef.current) {
      return;
    }

    isPortionLongPressingRef.current = true;
    portionLongPressStartDeltaYRef.current = startTranslationY;
    portionDragValueRef.current = null;
    setPortionSliderValue(null);
    setIsPortionPickerActive(true);
    triggerSelectionHaptic();
  }, []);

  const finishPortionHoldGesture = useCallback(() => {
    if (!isPortionLongPressingRef.current) {
      return;
    }

    const selectedPortion = portionDragValueRef.current;
    isPortionLongPressingRef.current = false;
    setIsPortionPickerActive(false);
    if (selectedPortion === null) {
      return;
    }

    addToLogRef.current(selectedPortion);
    triggerImpactHaptic();
  }, []);

  const cancelPortionGesture = useCallback(() => {
    isPortionLongPressingRef.current = false;
    setIsPortionPickerActive(false);
  }, []);

  const portionGesture = useMemo(() => {
    const holdDragGesture = Gesture.Pan()
      .activateAfterLongPress(QUICK_ADD_LONG_PRESS_MS)
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onBegin(() => {
        isPortionLongPressingRef.current = false;
        portionLongPressStartDeltaYRef.current = 0;
      })
      .onStart((event) => {
        startPortionPicker(event.translationY);
      })
      .onUpdate((event) => {
        if (!isPortionLongPressingRef.current) {
          return;
        }

        const adjustedDy = event.translationY - portionLongPressStartDeltaYRef.current;
        applyPortionDragValue(adjustedDy);
      })
      .onEnd((_event, success) => {
        if (success) {
          finishPortionHoldGesture();
        }
      })
      .onFinalize((_event, success) => {
        if (!success && isPortionLongPressingRef.current) {
          cancelPortionGesture();
        }
      });

    const tapGesture = Gesture.Tap()
      .maxDuration(QUICK_ADD_LONG_PRESS_MS)
      .maxDistance(16)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success && canAddToLogRef.current) {
          addToLogRef.current();
        }
      });

    return Gesture.Exclusive(holdDragGesture, tapGesture);
  }, [applyPortionDragValue, cancelPortionGesture, finishPortionHoldGesture, startPortionPicker]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setKeyboardBottomOffset(Math.max(0, event.endCoordinates.height - insets.bottom));
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardBottomOffset(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [insets.bottom]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [query]);

  // Interleaves one page's per-source results into a single block and appends it
  // to the "All" list. The shared mergedKeysRef drops anything already shown, so
  // the merge only ever grows at the end — earlier rows never move.
  const appendMergedBlock = useCallback(
    (pageFoodsBySource: Partial<Record<DisplayedFoodSource, SearchFood[]>>) => {
      const block = interleaveFoods(
        DISPLAYED_SOURCE_ORDER.map((source) => pageFoodsBySource[source] ?? []),
        mergedKeysRef.current,
      );
      if (block.length > 0) {
        setMergedFoods((prev) => [...prev, ...block]);
      }
    },
    [],
  );

  // Fetches `page` from each of `sources` in parallel, accumulates per-source
  // results progressively (for the per-source tabs), then appends one
  // interleaved block to the "All" list. Returns whether any source succeeded.
  const loadPage = useCallback(
    async (
      searchQuery: string,
      page: number,
      sources: DisplayedFoodSource[],
      controller: AbortController,
    ): Promise<{ succeeded: boolean; firstError: unknown }> => {
      const settled = await Promise.allSettled(
        sources.map(async (source) => {
          const { foods: pageFoods, hasMore } = await fetchFoodSourcePage(searchQuery, source, page, {
            signal: controller.signal,
            pageSize: SEARCH_PAGE_SIZE,
          });
          if (controller.signal.aborted) {
            return { source, foods: [] as SearchFood[], hasMore: false, applied: false };
          }
          setFoodsBySource((prev) => ({
            ...prev,
            [source]: appendUniqueFoods(prev[source], pageFoods),
          }));
          setHasMoreBySource((prev) => ({ ...prev, [source]: hasMore }));
          return { source, foods: pageFoods, hasMore, applied: true };
        }),
      );

      if (controller.signal.aborted) {
        return { succeeded: false, firstError: undefined };
      }

      const pageFoodsBySource: Partial<Record<DisplayedFoodSource, SearchFood[]>> = {};
      let appliedCount = 0;
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.applied) {
          pageFoodsBySource[result.value.source] = result.value.foods;
          appliedCount += 1;
        }
      }

      if (appliedCount > 0) {
        appendMergedBlock(pageFoodsBySource);
      }

      const firstRejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      return { succeeded: appliedCount > 0, firstError: firstRejected?.reason };
    },
    [appendMergedBlock],
  );

  useEffect(() => {
    if (!isDataReady) {
      return;
    }

    const normalizedQuery = debouncedQuery.trim();

    if (normalizedQuery.length < 2) {
      searchControllerRef.current?.abort();
      searchControllerRef.current = null;
      loadingMoreRef.current = false;
      mergedKeysRef.current = new Set();
      setFoodsBySource(createEmptyFoodsBySource());
      setMergedFoods([]);
      setHasMoreBySource(createEmptyHasMore());
      setLoadedPage(0);
      setSelectedFoodId(null);
      setSearchError(null);
      setIsSearching(false);
      setIsLoadingMore(false);
      return;
    }

    const controller = new AbortController();
    searchControllerRef.current = controller;
    loadingMoreRef.current = false;
    mergedKeysRef.current = new Set();

    void (async () => {
      setFoodsBySource(createEmptyFoodsBySource());
      setMergedFoods([]);
      setHasMoreBySource(createEmptyHasMore());
      setLoadedPage(0);
      setSelectedFoodId(null);
      setIsSearching(true);
      setIsLoadingMore(false);
      setSearchError(null);

      // Keep recording the query so ANMAT results can be seeded from it later.
      void queueAnmatQuery(normalizedQuery, {
        signal: controller.signal,
        pageSize: SEARCH_PAGE_SIZE,
      }).catch(() => {});

      const { succeeded, firstError } = await loadPage(
        normalizedQuery,
        1,
        DISPLAYED_SOURCE_ORDER,
        controller,
      );

      if (controller.signal.aborted) {
        return;
      }

      if (succeeded) {
        setLoadedPage(1);
      } else {
        setSearchError(getErrorMessage(firstError));
      }

      setIsSearching(false);
    })();

    return () => {
      controller.abort();
    };
  }, [debouncedQuery, isDataReady, loadPage]);

  const loadMoreFoods = useCallback(() => {
    if (loadingMoreRef.current) {
      return;
    }

    const {
      hasMoreBySource: currentHasMore,
      loadedPage: currentPage,
      activeProviderFilter: filter,
      activeQuery: searchQuery,
      isSearching: searching,
    } = loadMoreStateRef.current;

    if (searching || searchQuery.length < 2 || currentPage < 1 || currentPage >= SEARCH_MAX_PAGES) {
      return;
    }

    // Only page in if the currently visible tab can still grow.
    const viewHasMore =
      filter === "all"
        ? DISPLAYED_SOURCE_ORDER.some((source) => currentHasMore[source])
        : currentHasMore[filter];
    if (!viewHasMore) {
      return;
    }

    // Advance every source that still has more, so the "All" list stays
    // complete regardless of which tab triggered the load.
    const sources = DISPLAYED_SOURCE_ORDER.filter((source) => currentHasMore[source]);
    if (sources.length === 0) {
      return;
    }

    const controller = searchControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return;
    }

    const nextPage = currentPage + 1;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    void (async () => {
      const { succeeded } = await loadPage(searchQuery, nextPage, sources, controller);
      if (succeeded && !controller.signal.aborted) {
        setLoadedPage(nextPage);
      }

      loadingMoreRef.current = false;
      if (!controller.signal.aborted) {
        setIsLoadingMore(false);
      }
    })();
  }, [loadPage]);

  const handleSearchScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      const distanceToBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceToBottom <= INFINITE_SCROLL_THRESHOLD_PX) {
        loadMoreFoods();
      }
    },
    [loadMoreFoods],
  );

  if (!isDataReady) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading data…</Text>
      </View>
    );
  }

  const trimmedQuery = query.trim();
  const canShowResults = trimmedQuery.length >= 2;
  const recentEntries = allFoodEntries
    .filter((entry) => !isQuickAddEntry(entry))
    .slice(-RECENT_ITEMS_LIMIT)
    .reverse();
  const recentSearchMatches = canShowResults
    ? getRecentSearchMatches(recentEntries, trimmedQuery)
    : recentEntries;
  const allFetchedFoods = [...foodsBySource.openfoodfacts, ...foodsBySource.mfp];
  const selectedFood =
    canShowResults ? allFetchedFoods.find((food) => food.id === selectedFoodId) || null : null;
  const selectedRecentEntry =
    recentSearchMatches.find((entry) => entry.id === selectedRecentEntryId) || null;
  const providerCounts: Record<DisplayedFoodSource, number> = {
    openfoodfacts: foodsBySource.openfoodfacts.length,
    mfp: foodsBySource.mfp.length,
  };
  const visibleFoods = activeProviderFilter === "all" ? foods : foodsBySource[activeProviderFilter];

  const handleAddToLog = (portionOverride?: number) => {
    const createdAt = Date.now();

    if (selectedFood) {
      void createFoodEntry({
        meal: selectedMeal,
        foodName: selectedFood.name,
        brand: selectedFood.brand,
        serving: selectedFood.serving,
        portion: portionOverride ?? 1,
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
      const portion = portionOverride ?? sanitizePortion(selectedRecentEntry.portion);

      void createFoodEntry({
        meal: selectedMeal,
        foodName: selectedRecentEntry.foodName,
        brand: selectedRecentEntry.brand,
        serving: selectedRecentEntry.serving,
        portion,
        nutrition: selectedRecentEntry.nutrition,
        createdAt,
        dateKey: selectedDateKey,
      });
    } else {
      return;
    }

    navigateAfterAdd();
  };

  canAddToLogRef.current = Boolean(selectedFood || selectedRecentEntry);
  addToLogRef.current = handleAddToLog;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        onScroll={handleSearchScroll}
        scrollEventThrottle={16}
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
            <Text style={styles.sectionTitle}>Recents</Text>
            {recentEntries.length > 0 ? (
              <View style={styles.card}>
                {recentEntries.map((entry, index) => (
                  <FoodRow
                    key={entry.id}
                    name={entry.foodName}
                    brand={entry.brand}
                    serving={entry.serving}
                    portionLabel={formatPortionLabel(entry.portion)}
                    nutritionMultiplier={sanitizePortion(entry.portion)}
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
        {canShowResults && recentSearchMatches.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Recents</Text>
            <View style={styles.card}>
              {recentSearchMatches.map((entry, index) => (
                <FoodRow
                  key={entry.id}
                  name={entry.foodName}
                  brand={entry.brand}
                  serving={entry.serving}
                  portionLabel={formatPortionLabel(entry.portion)}
                  nutritionMultiplier={sanitizePortion(entry.portion)}
                  nutrition={entry.nutrition}
                  selected={selectedRecentEntryId === entry.id}
                  isLast={index === recentSearchMatches.length - 1}
                  onPress={() => {
                    setSelectedRecentEntryId(entry.id);
                    setSelectedFoodId(null);
                  }}
                />
              ))}
            </View>
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
            Searching MFP and OpenFoodFacts. Results appear as each source returns.
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
        {canShowResults && isLoadingMore ? (
          <Text style={styles.helperText}>Loading more…</Text>
        ) : null}
      </ScrollView>

      <View
        style={[
          styles.actionBarContainer,
          {
            bottom: isQuickAddExpanded ? keyboardBottomOffset : 0,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        {canUseGlass ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor="rgba(255,255,255,0.2)"
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {isQuickAddPickerActive ? (
          <View pointerEvents="none" style={styles.quickAddSliderPopover}>
            <View style={styles.quickAddSliderCard}>
              <Text style={styles.quickAddSliderHint}>Hold & slide</Text>
              <Text style={styles.quickAddSliderValue}>
                {quickAddSliderCalories === null
                  ? "Slide up"
                  : `${formatCalories(quickAddSliderCalories)} kcal`}
              </Text>
              <View style={styles.quickAddSliderRail}>
                {QUICK_ADD_REVERSED_CALORIE_VALUES.map((calories) => {
                  const isSelected = quickAddSliderCalories === calories;
                  const isPassed =
                    quickAddSliderCalories !== null && calories <= quickAddSliderCalories;

                  return (
                    <View key={calories} style={styles.quickAddSliderStepRow}>
                      <Text
                        style={[
                          styles.quickAddSliderStepLabel,
                          isSelected && styles.quickAddSliderStepLabelSelected,
                        ]}
                      >
                        {calories}
                      </Text>
                      <View
                        style={[
                          styles.quickAddSliderStepSquare,
                          isPassed && styles.quickAddSliderStepSquarePassed,
                          isSelected && styles.quickAddSliderStepSquareSelected,
                        ]}
                      />
                    </View>
                  );
                })}
              </View>
            </View>
            <View style={styles.quickAddSliderStem} />
          </View>
        ) : null}
        {isPortionPickerActive ? (
          <View pointerEvents="none" style={styles.portionSliderPopover}>
            <View style={styles.quickAddSliderCard}>
              <Text style={styles.quickAddSliderHint}>Hold & slide</Text>
              <Text style={styles.quickAddSliderValue}>
                {portionSliderValue === null
                  ? "Slide up"
                  : `${formatMixedQuarter(portionSliderValue)}×`}
              </Text>
              <View style={styles.quickAddSliderRail}>
                {PORTION_REVERSED_SLIDER_VALUES.map((value) => {
                  const isSelected = portionSliderValue === value;
                  const isPassed = portionSliderValue !== null && value <= portionSliderValue;
                  const isWhole = Number.isInteger(value);

                  return (
                    <View
                      key={value}
                      style={[
                        styles.quickAddSliderStepRow,
                        isWhole && styles.quickAddSliderStepRowWhole,
                      ]}
                    >
                      <Text
                        style={[
                          styles.quickAddSliderStepLabel,
                          isWhole && styles.quickAddSliderStepLabelWhole,
                          isSelected && styles.quickAddSliderStepLabelSelected,
                        ]}
                      >
                        {formatMixedQuarter(value)}
                      </Text>
                      <View
                        style={[
                          styles.quickAddSliderStepSquare,
                          isWhole && styles.quickAddSliderStepSquareWhole,
                          isPassed && styles.quickAddSliderStepSquarePassed,
                          isSelected && styles.quickAddSliderStepSquareSelected,
                          isWhole && styles.quickAddSliderStepSquareWholeTall,
                        ]}
                      />
                    </View>
                  );
                })}
              </View>
            </View>
            <View style={styles.quickAddSliderStem} />
          </View>
        ) : null}
        {isQuickAddExpanded && !isQuickAddPickerActive ? (
          <View style={styles.quickAddPanel}>
            <View style={styles.quickAddHeaderRow}>
              <Text style={styles.quickAddTitle}>Quick add</Text>
              <Text style={styles.quickAddValueText}>
                {parsedQuickAddCalories
                  ? `${formatCalories(parsedQuickAddCalories)} kcal`
                  : "Calories"}
              </Text>
            </View>
            <View style={styles.quickAddForm}>
              <View style={styles.quickAddCaloriesField}>
                <Text style={styles.quickAddFieldLabel}>Calories</Text>
                <TextInput
                  value={quickAddCaloriesText}
                  onChangeText={setQuickAddCaloriesText}
                  keyboardType="number-pad"
                  placeholder="250"
                  placeholderTextColor={palette.secondaryLabel}
                  selectTextOnFocus
                  style={styles.quickAddCaloriesInput}
                />
              </View>
              <View style={styles.quickAddMacroRow}>
                <View style={styles.quickAddMacroField}>
                  <Text style={styles.quickAddFieldLabel}>Protein</Text>
                  <TextInput
                    value={quickAddProteinText}
                    onChangeText={setQuickAddProteinText}
                    keyboardType="decimal-pad"
                    placeholder="g"
                    placeholderTextColor={palette.secondaryLabel}
                    style={styles.quickAddMacroInput}
                  />
                </View>
                <View style={styles.quickAddMacroField}>
                  <Text style={styles.quickAddFieldLabel}>Carbs</Text>
                  <TextInput
                    value={quickAddCarbsText}
                    onChangeText={setQuickAddCarbsText}
                    keyboardType="decimal-pad"
                    placeholder="g"
                    placeholderTextColor={palette.secondaryLabel}
                    style={styles.quickAddMacroInput}
                  />
                </View>
                <View style={styles.quickAddMacroField}>
                  <Text style={styles.quickAddFieldLabel}>Fat</Text>
                  <TextInput
                    value={quickAddFatText}
                    onChangeText={setQuickAddFatText}
                    keyboardType="decimal-pad"
                    placeholder="g"
                    placeholderTextColor={palette.secondaryLabel}
                    style={styles.quickAddMacroInput}
                  />
                </View>
              </View>
            </View>
          </View>
        ) : null}
        <View style={styles.actionButtonRow}>
          {isQuickAddExpanded ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canQuickAdd}
              onPress={() => handleQuickAddToLog()}
              style={[styles.actionButton, !canQuickAdd && styles.actionButtonDisabled]}
            >
              <Text style={styles.actionButtonText}>Add quick</Text>
            </Pressable>
          ) : (
            <GestureDetector gesture={portionGesture}>
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel={`Add to ${selectedMealLabel}`}
                accessibilityState={{ disabled: !selectedFood && !selectedRecentEntry }}
                collapsable={false}
                style={[
                  styles.actionButton,
                  !selectedFood && !selectedRecentEntry && styles.actionButtonDisabled,
                ]}
              >
                <Text style={styles.actionButtonText}>
                  {isPortionPickerActive && portionSliderValue !== null
                    ? `Add ${formatMixedQuarter(portionSliderValue)}`
                    : `Add to ${selectedMealLabel}`}
                </Text>
              </View>
            </GestureDetector>
          )}
          <GestureDetector gesture={quickAddGesture}>
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel="Quick add"
              accessibilityState={{ selected: isQuickAddButtonActive }}
              collapsable={false}
              style={[styles.quickAddButton, isQuickAddButtonActive && styles.quickAddButtonActive]}
            >
              <Text
                style={[
                  styles.quickAddButtonText,
                  isQuickAddButtonActive && styles.quickAddButtonTextActive,
                ]}
              >
                Quick add
              </Text>
            </View>
          </GestureDetector>
        </View>
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
    overflow: "visible",
    zIndex: 10,
  },
  quickAddSliderPopover: {
    position: "absolute",
    right: 16,
    bottom: 82,
    width: 132,
    alignItems: "center",
    zIndex: 20,
  },
  portionSliderPopover: {
    position: "absolute",
    left: 16,
    bottom: 82,
    width: 132,
    alignItems: "center",
    zIndex: 20,
  },
  quickAddSliderCard: {
    width: 132,
    borderRadius: 14,
    backgroundColor: palette.card,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    shadowColor: "#000000",
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  quickAddSliderHint: {
    textAlign: "center",
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    color: palette.secondaryLabel,
  },
  quickAddSliderValue: {
    marginTop: 2,
    marginBottom: 8,
    textAlign: "center",
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
    color: palette.tint,
    fontVariant: ["tabular-nums"],
  },
  quickAddSliderRail: {
    gap: 3,
  },
  quickAddSliderStepRow: {
    height: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  quickAddSliderStepLabel: {
    width: 44,
    textAlign: "right",
    fontSize: 10,
    lineHeight: 12,
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
  },
  quickAddSliderStepLabelWhole: {
    color: palette.label,
    fontWeight: "800",
  },
  quickAddSliderStepLabelSelected: {
    color: palette.tint,
    fontWeight: "800",
  },
  quickAddSliderStepSquare: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: palette.separator,
    backgroundColor: palette.separator,
  },
  quickAddSliderStepRowWhole: {
    height: 44,
  },
  quickAddSliderStepSquareWhole: {
    borderColor: palette.secondaryLabel,
  },
  quickAddSliderStepSquareWholeTall: {
    height: 40,
  },
  quickAddSliderStepSquarePassed: {
    borderColor: palette.badgeSelectedBorder,
    backgroundColor: palette.badgeSelectedBorder,
  },
  quickAddSliderStepSquareSelected: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderColor: palette.tint,
    backgroundColor: palette.tint,
  },
  quickAddSliderStem: {
    width: 3,
    height: 20,
    borderRadius: 2,
    backgroundColor: palette.tint,
    opacity: 0.65,
  },
  quickAddPanel: {
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: palette.card,
    padding: 12,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  quickAddHeaderRow: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  quickAddTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "700",
    color: palette.label,
  },
  quickAddValueText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "700",
    color: palette.tint,
    fontVariant: ["tabular-nums"],
  },
  quickAddForm: {
    marginTop: 10,
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
    backgroundColor: palette.searchInputBackground,
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
    backgroundColor: palette.searchInputBackground,
    color: palette.label,
    paddingHorizontal: 10,
    fontSize: 16,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  actionButtonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  quickAddButton: {
    minHeight: 50,
    minWidth: 104,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.separator,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
  },
  quickAddButtonActive: {
    borderColor: palette.badgeSelectedBorder,
    backgroundColor: palette.badgeSelectedBackground,
  },
  quickAddButtonText: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "700",
    color: palette.label,
  },
  quickAddButtonTextActive: {
    color: palette.tint,
  },
  actionButton: {
    flex: 1,
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

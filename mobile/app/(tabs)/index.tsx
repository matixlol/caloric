import { useAuth } from "../../src/auth/auth-client";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { FriendDailySummary } from "@caloric/data-model";
import * as Sentry from "@sentry/react-native";
import Animated, { useAnimatedRef } from "react-native-reanimated";
import Sortable from "react-native-sortables";
import PagerView, { type PagerViewOnPageSelectedEvent } from "react-native-pager-view";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  buildDayViewData,
  DaySummaryCard,
  formatCalories,
  ReadOnlyDayView,
  type DayMealEntry,
  type DayViewData,
} from "../../src/components/DayReadOnlyView";
import { AIConversationPanel } from "../../src/ai/AIConversationPanel";
import { COMPOSER_BAR_HEIGHT, FloatingComposer } from "../../src/ai/FloatingComposer";
import { useAllFoodEntries, useDataStoreActions, useDataStoreReady, useUserSettings } from "../../src/data/DataProvider";
import {
  getTodayLocalDateKey,
  parseLocalDateKey,
  shiftLocalDateKey,
} from "../../src/date";
import { MEAL_TIMES, type MealKey, normalizeMeal } from "../../src/meals";
import { formatRelativeTimestamp } from "../../src/time";
import { macroColors } from "../../src/theme/macroColors";
import { finishStartupBreakdownTrace, logStartupMilestone } from "../../src/performance/startup";
import { CalorieMismatchBadge } from "../../src/components/CalorieMismatchBadge";

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
  destructive: iosColor("systemRed", "#DC2626"),
  destructiveText: "#FFFFFF",
};

const HEADER_HEIGHT_ESTIMATE = 74;
const ENTRY_HEIGHT_ESTIMATE = 54;
const EMPTY_HEIGHT_ESTIMATE = 60;

const DATE_TITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const DATE_SUBTITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

type MealEntry = DayMealEntry;

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

function estimateItemHeight(item: MealListItem) {
  if (item.type === "header") return HEADER_HEIGHT_ESTIMATE;
  if (item.type === "entry") return ENTRY_HEIGHT_ESTIMATE;
  return EMPTY_HEIGHT_ESTIMATE;
}

function formatDayTitle(dayOffset: number, selectedDate: Date | null): string {
  if (dayOffset === 0) {
    return "Today";
  }

  if (dayOffset === -1) {
    return "Yesterday";
  }

  if (!selectedDate) {
    return "Log";
  }

  return DATE_TITLE_FORMATTER.format(selectedDate);
}

function MealRow({
  id,
  name,
  meta,
  calories,
  hasCalorieMacroMismatch,
  isLast,
  onDelete,
  onPress,
}: {
  id: string;
  name: string;
  meta?: string;
  calories: number;
  hasCalorieMacroMismatch: boolean;
  isLast: boolean;
  onDelete: (id: string) => void;
  onPress: (id: string) => void;
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
        onPress={() => onPress(id)}
        style={[styles.rowPressable, !isLast && styles.rowWithDivider]}
      >
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>{name}</Text>
            {meta ? <Text style={styles.rowSubtitle}>{meta}</Text> : null}
            {hasCalorieMacroMismatch ? <CalorieMismatchBadge /> : null}
          </View>
          <Text style={styles.rowValue}>{formatCalories(calories)}</Text>
        </View>
      </Pressable>
    </Swipeable>
  );
}

function FriendSummaryRow({
  friend,
  index,
  onPress,
}: {
  friend: FriendDailySummary;
  index: number;
  onPress: (friend: FriendDailySummary) => void;
}) {
  const progress = friend.calorieGoal
    ? clampPercent((friend.calories / Math.max(friend.calorieGoal, 1)) * 100)
    : 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${friend.displayName}'s day`}
      onPress={() => onPress(friend)}
      style={({ pressed }) => [
        styles.friendRow,
        index > 0 && styles.friendRowDivider,
        pressed && styles.friendRowPressed,
      ]}
    >
      <View style={styles.friendMain}>
        <View style={styles.friendTopRow}>
          <Text numberOfLines={1} style={styles.friendName}>{friend.displayName}</Text>
          <View style={styles.friendCaloriesRow}>
            <Text style={styles.friendCalories}>{formatCalories(friend.calories)}</Text>
            <Ionicons color={palette.secondaryLabel} name="chevron-forward" size={16} />
          </View>
        </View>
        <View style={styles.friendProgressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
        <Text numberOfLines={1} style={styles.friendMeta}>
          {friend.lastUpdatedAt ? `Updated ${formatRelativeTimestamp(friend.lastUpdatedAt).toLowerCase()}` : "No logs yet"}
        </Text>
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { userId } = useAuth();
  const isDataReady = useDataStoreReady();
  const { deleteFoodEntry, getFriendDailySummaries, reorderFoodEntriesForDate } = useDataStoreActions();
  const { data: allLogs, isLoading: isLoadingEntries } = useAllFoodEntries("home");
  const { data: settings, isLoading: isLoadingSettings } = useUserSettings("home");
  const hasLoggedFullDisplayRef = useRef(false);

  const [dayOffset, setDayOffset] = useState(0);
  const [todayDateKey, setTodayDateKey] = useState(() => getTodayLocalDateKey());

  useEffect(() => {
    const interval = setInterval(() => {
      setTodayDateKey((current) => {
        const next = getTodayLocalDateKey();
        return next === current ? current : next;
      });
    }, 60_000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const selectedDateKey = useMemo(
    () => shiftLocalDateKey(todayDateKey, dayOffset),
    [dayOffset, todayDateKey],
  );
  const selectedDate = useMemo(() => parseLocalDateKey(selectedDateKey), [selectedDateKey]);
  const dayTitle = useMemo(() => formatDayTitle(dayOffset, selectedDate), [dayOffset, selectedDate]);
  const daySubtitle = useMemo(
    () => (selectedDate ? DATE_SUBTITLE_FORMATTER.format(selectedDate) : selectedDateKey),
    [selectedDate, selectedDateKey],
  );

  const logs = useMemo(
    () => allLogs.filter((entry) => entry.dateKey === selectedDateKey),
    [allLogs, selectedDateKey],
  );

  const dayView = useMemo(
    () =>
      settings
        ? buildDayViewData({
            entries: logs,
            selectedDateKey,
            dayOffset,
            dayTitle,
            daySubtitle,
            settings,
          })
        : null,
    [dayOffset, daySubtitle, dayTitle, logs, selectedDateKey, settings],
  );

  const friendSummariesQuery = useQuery({
    queryKey: ["friendDailySummaries", userId ?? null, selectedDateKey],
    queryFn: () => getFriendDailySummaries(selectedDateKey),
    enabled: isDataReady && Boolean(userId),
    refetchInterval: 45_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const friendSummaries = friendSummariesQuery.data ?? [];

  const mealListItems = useMemo<MealListItem[]>(() => {
    const items: MealListItem[] = [];

    MEAL_TIMES.forEach((meal, mealIndex) => {
      const entries = dayView?.logsByMeal[meal.key] ?? [];
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
  }, [dayView]);

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

  const goToOlderDay = useCallback(() => {
    setDayOffset((current) => current - 1);
  }, []);

  const goToNewerDay = useCallback(() => {
    setDayOffset((current) => Math.min(current + 1, 0));
  }, []);

  const pagerRef = useRef<PagerView>(null);
  const scrollableRef = useAnimatedRef<Animated.ScrollView>();

  const handlePagerPageSelected = useCallback(
    (event: PagerViewOnPageSelectedEvent) => {
      const nextPage = event.nativeEvent.position;
      if (nextPage === 1) {
        return;
      }

      if (nextPage === 0) {
        goToOlderDay();
      } else {
        goToNewerDay();
      }

      requestAnimationFrame(() => {
        pagerRef.current?.setPageWithoutAnimation(1);
      });
    },
    [goToNewerDay, goToOlderDay],
  );

  const olderPreview = useMemo<DayViewData | null>(() => {
    if (!settings) {
      return null;
    }

    const targetDayOffset = dayOffset - 1;
    const targetDateKey = shiftLocalDateKey(todayDateKey, targetDayOffset);
    const targetDate = parseLocalDateKey(targetDateKey);
    const targetTitle = formatDayTitle(targetDayOffset, targetDate);
    const targetSubtitle = targetDate ? DATE_SUBTITLE_FORMATTER.format(targetDate) : targetDateKey;
    const targetLogs = allLogs.filter((entry) => entry.dateKey === targetDateKey);

    return buildDayViewData({
      entries: targetLogs,
      selectedDateKey: targetDateKey,
      dayOffset: targetDayOffset,
      dayTitle: targetTitle,
      daySubtitle: targetSubtitle,
      settings,
    });
  }, [allLogs, dayOffset, settings, todayDateKey]);

  const newerPreview = useMemo<DayViewData | null>(() => {
    if (!settings) {
      return null;
    }

    const targetDayOffset = Math.min(dayOffset + 1, 0);
    const targetDateKey = shiftLocalDateKey(todayDateKey, targetDayOffset);
    const targetDate = parseLocalDateKey(targetDateKey);
    const targetTitle = formatDayTitle(targetDayOffset, targetDate);
    const targetSubtitle = targetDate ? DATE_SUBTITLE_FORMATTER.format(targetDate) : targetDateKey;
    const targetLogs = allLogs.filter((entry) => entry.dateKey === targetDateKey);

    return buildDayViewData({
      entries: targetLogs,
      selectedDateKey: targetDateKey,
      dayOffset: targetDayOffset,
      dayTitle: targetTitle,
      daySubtitle: targetSubtitle,
      settings,
    });
  }, [allLogs, dayOffset, settings, todayDateKey]);

  const isFullyDisplayed = Boolean(
    isDataReady &&
    !isLoadingEntries &&
    !isLoadingSettings &&
    settings &&
    dayView &&
    olderPreview &&
    newerPreview,
  );

  useEffect(() => {
    if (!isFullyDisplayed || hasLoggedFullDisplayRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (hasLoggedFullDisplayRef.current) {
        return;
      }

      hasLoggedFullDisplayRef.current = true;
      logStartupMilestone("home.full_display", {
        "startup.food_entry_count": allLogs.length,
      });
      finishStartupBreakdownTrace({
        "startup.food_entry_count": allLogs.length,
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [allLogs.length, isFullyDisplayed]);

  if (!isFullyDisplayed || !settings || !dayView || !olderPreview || !newerPreview) {
    return (
      <View style={styles.loadingContainer}>
        <Sentry.TimeToFullDisplay record={false} />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

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
    void deleteFoodEntry(entryId);
  };

  const handleOpenEntry = (entryId: string) => {
    router.push({
      pathname: "/entry-details",
      params: { entryId },
    });
  };

  const handleOpenFriendDay = (friend: FriendDailySummary) => {
    router.push({
      pathname: "/friend-day",
      params: {
        friendUserId: friend.userId,
        dateKey: selectedDateKey,
        displayName: friend.displayName,
        sheetInstance: String(Date.now()),
      },
    });
  };

  const persistDraggedOrder = (orderedItems: MealListItem[]) => {
    if (logs.length === 0) {
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
      if (seenEntryIds.has(entry.id)) {
        return;
      }

      const normalizedMeal = normalizeMeal(entry.meal) ?? "lunch";
      entryIdsByMeal[normalizedMeal].push(entry.id);
    });

    const orderedEntries: { id: string; meal: MealKey }[] = [];
    const logsById = new Map(logs.map((entry) => [entry.id, entry] as const));

    MEAL_TIMES.forEach((mealTime) => {
      entryIdsByMeal[mealTime.key].forEach((entryId) => {
        const entry = logsById.get(entryId);
        if (!entry) {
          return;
        }

        orderedEntries.push({
          id: entry.id,
          meal: mealTime.key,
        });
      });
    });

    if (orderedEntries.length !== logs.length) {
      return;
    }

    void reorderFoodEntriesForDate(selectedDateKey, orderedEntries);
  };

  const listHeader = (
    <View
      accessibilityLabel="Swipe horizontally to move between days"
      style={styles.listHeaderOuter}
    >
      <View style={styles.listHeader}>
        <View style={styles.dayTitleRow}>
          <View style={styles.dayTitleMain}>
            <Text style={styles.largeTitle}>{dayTitle}</Text>
            <Text style={styles.daySubtitle}>{daySubtitle}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => router.push("/settings")}
            hitSlop={8}
            style={styles.settingsButton}
          >
            <Ionicons name="settings-outline" size={20} color={palette.secondaryLabel} />
          </Pressable>
        </View>

        {dayOffset !== 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to today"
            onPress={() => setDayOffset(0)}
            style={styles.backToTodayButton}
          >
            <Text style={styles.backToTodayText}>Back to today</Text>
          </Pressable>
        ) : null}

        <DaySummaryCard view={dayView} />

        <View style={[styles.summaryCard, styles.friendsCard]}>
          <View style={[styles.friendTopRow, styles.friendsHeader]}>
            <Text style={styles.friendsTitle}>{dayOffset === 0 ? "Friends Today" : "Friends"}</Text>
            <Text style={styles.friendsSubtitle}>
              {friendSummariesQuery.isLoading && friendSummaries.length === 0 ? "Loading..." : `${friendSummaries.length}`}
            </Text>
          </View>

          {friendSummariesQuery.isError ? (
            <Text style={styles.friendsEmptyText}>Could not load friends.</Text>
          ) : friendSummaries.length === 0 ? (
            <Text style={styles.friendsEmptyText}>Add friends in Settings.</Text>
          ) : (
            friendSummaries.map((friend, index) => (
              <FriendSummaryRow
                key={friend.userId}
                friend={friend}
                index={index}
                onPress={handleOpenFriendDay}
              />
            ))
          )}
        </View>
      </View>
    </View>
  );

  const renderItem = ({ item }: { item: MealListItem }) => {
    if (item.type === "header") {
      // Headers can't be grabbed. The first header is fixed-order so it acts as
      // a hard top boundary (entries can't be dragged above it); the rest are
      // non-draggable so they still reorder and entries can cross them into the
      // next meal (fixed-order headers would block crossing).
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

          <Sortable.Handle
            mode={item.isFirst ? "fixed-order" : "non-draggable"}
            style={[styles.mealHeaderCard, !item.isFirst && styles.mealHeaderCardSpaced]}
          >
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
                    params: { meal: item.meal, day: selectedDateKey },
                  })
                }
                style={styles.addIconButton}
              >
                <Text style={styles.addIconButtonText}>+</Text>
              </Pressable>
            </View>
          </Sortable.Handle>
        </View>
      );
    }

    if (item.type === "empty") {
      return (
        <View
          onLayout={(event) => recordItemHeight(item.key, event)}
          style={[styles.mealBodyCard, styles.mealBodyCardLast]}
        >
          <Sortable.Handle mode="non-draggable">
            <Text style={styles.emptyText}>{item.copy}</Text>
          </Sortable.Handle>
        </View>
      );
    }

    const isLast = entryIsLastByKey[item.key] ?? true;

    return (
      <View
        onLayout={(event) => recordItemHeight(item.key, event)}
        style={[styles.mealBodyCard, isLast && styles.mealBodyCardLast]}
      >
        <Sortable.Handle>
          <MealRow
            id={item.entry.id}
            name={item.entry.name}
            meta={item.entry.meta}
            calories={item.entry.calories}
            hasCalorieMacroMismatch={item.entry.hasCalorieMacroMismatch}
            isLast={isLast}
            onDelete={handleDeleteEntry}
            onPress={handleOpenEntry}
          />
        </Sortable.Handle>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <Sentry.TimeToFullDisplay record={isFullyDisplayed} />
      <PagerView
        initialPage={1}
        onPageSelected={handlePagerPageSelected}
        ref={pagerRef}
        style={styles.pager}
      >
        <View key="older" style={styles.pagerPage}>
          <ReadOnlyDayView
            view={olderPreview}
            topInset={insets.top}
            bottomInset={insets.bottom + 24 + COMPOSER_BAR_HEIGHT}
          />
        </View>

        <View key="current" style={styles.pagerPage}>
          <Animated.ScrollView
            ref={scrollableRef}
            contentInsetAdjustmentBehavior="automatic"
            style={styles.listContainer}
            contentContainerStyle={[
              styles.contentContainer,
              {
                paddingTop: insets.top,
                paddingBottom: insets.bottom + 24 + COMPOSER_BAR_HEIGHT,
              },
            ]}
          >
            {listHeader}

            <Sortable.Grid
              customHandle
              columns={1}
              rowGap={0}
              data={dragItems}
              keyExtractor={(item) => item.key}
              renderItem={renderItem}
              dragActivationDelay={170}
              scrollableRef={scrollableRef}
              onDragEnd={({ data }) => {
                setDragItems(data);
                persistDraggedOrder(data);
              }}
            />
          </Animated.ScrollView>
        </View>

        <View key="newer" style={styles.pagerPage}>
          <ReadOnlyDayView
            view={newerPreview}
            topInset={insets.top}
            bottomInset={insets.bottom + 24 + COMPOSER_BAR_HEIGHT}
          />
        </View>
      </PagerView>

      <AIConversationPanel />
      <FloatingComposer />
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
  pager: {
    flex: 1,
  },
  pagerPage: {
    flex: 1,
  },
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
  previewMealSection: {
    marginBottom: 2,
  },
  previewMealTitle: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    fontWeight: "700",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  dayTitleRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dayTitleMain: {
    flex: 1,
    alignItems: "flex-start",
  },
  settingsButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.separator,
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
  friendsCard: {
    paddingVertical: 12,
  },
  friendsHeader: {
    gap: 12,
    marginBottom: 4,
  },
  friendsTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
    color: palette.label,
  },
  friendsSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
  },
  friendsEmptyText: {
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  friendRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
  },
  friendRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.separator,
  },
  friendRowPressed: {
    opacity: 0.58,
  },
  friendMain: {
    flex: 1,
    gap: 5,
  },
  friendTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  friendName: {
    flex: 1,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "600",
    color: palette.label,
  },
  friendCalories: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  friendCaloriesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  friendProgressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.tertiaryLabel,
    overflow: "hidden",
  },
  friendMeta: {
    fontSize: 12,
    lineHeight: 15,
    color: palette.secondaryLabel,
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

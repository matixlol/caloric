import { ExtensionStorage } from "@bacons/apple-targets";
import Constants from "expo-constants";
import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { buildDayViewData } from "../components/DayReadOnlyView";
import { useAllFoodEntries, useDataStoreReady, useUserSettings } from "../data/DataProvider";
import { getTodayLocalDateKey } from "../date";

const SUMMARY_KEY = "todaySummary";

const APP_GROUP =
  (Constants.expoConfig?.extra?.appGroup as string | undefined) ?? null;

const storage = APP_GROUP ? new ExtensionStorage(APP_GROUP) : null;

type TodaySummary = {
  dateKey: string;
  calories: number;
  calorieGoal: number;
  calorieProgress: number;
  proteinProgress: number;
  carbsProgress: number;
  fatProgress: number;
};

/**
 * Mirrors the AutoBackupCoordinator pattern: whenever the day's data or goals
 * change, recompute today's totals (via the shared buildDayViewData helper) and
 * push a small snapshot into the App Group so the lock-screen / home-screen
 * widget can render it. Also reruns on foreground and at local midnight so
 * "today" rolls over while the app is open.
 */
export function WidgetSyncCoordinator() {
  const isReady = useDataStoreReady();
  const { data: logs } = useAllFoodEntries();
  const { data: settings } = useUserSettings();
  const lastPayloadRef = useRef<string | null>(null);

  const syncWidget = useCallback(() => {
    if (Platform.OS !== "ios" || !storage || !isReady || !settings) {
      return;
    }

    const dateKey = getTodayLocalDateKey();
    const todaysEntries = logs.filter((entry) => entry.dateKey === dateKey);
    const view = buildDayViewData({
      entries: todaysEntries,
      selectedDateKey: dateKey,
      dayTitle: "",
      daySubtitle: "",
      settings,
    });

    const summary: TodaySummary = {
      dateKey,
      calories: Math.round(view.calories),
      calorieGoal: view.calorieGoal,
      calorieProgress: view.calorieProgress,
      proteinProgress: view.proteinProgress,
      carbsProgress: view.carbsProgress,
      fatProgress: view.fatProgress,
    };

    const payload = JSON.stringify(summary);
    if (payload === lastPayloadRef.current) {
      return;
    }
    lastPayloadRef.current = payload;

    storage.set(SUMMARY_KEY, summary);
    ExtensionStorage.reloadWidget();
  }, [isReady, logs, settings]);

  // React to data / goal changes.
  useEffect(() => {
    syncWidget();
  }, [syncWidget]);

  // Re-sync on foreground (covers edits made from other surfaces and day change).
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        syncWidget();
      }
    });

    return () => subscription.remove();
  }, [syncWidget]);

  // Roll over to the new day while the app stays open.
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const timer = setTimeout(syncWidget, nextMidnight.getTime() - now.getTime());

    return () => clearTimeout(timer);
  }, [syncWidget]);

  return null;
}

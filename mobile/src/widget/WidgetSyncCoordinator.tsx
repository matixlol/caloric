import { ExtensionStorage } from "@bacons/apple-targets";
import Constants from "expo-constants";
import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { buildDayViewData } from "../components/DayReadOnlyView";
import { useAllFoodEntries, useDataStoreReady, useUserSettings } from "../data/DataProvider";
import { getTodayLocalDateKey } from "../date";
import { traceStartupOperation } from "../performance/startup";

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
  const { data: logs } = useAllFoodEntries("widget_sync");
  const { data: settings } = useUserSettings("widget_sync");
  const hasMeasuredInitialSyncRef = useRef(false);
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

    // Uncapped percentages so the widget can show >100% when past a goal.
    // (view.*Progress is clamped to 0-100 for the in-app fill widths.)
    const uncappedPct = (value: number, goal: number) =>
      Math.round((value / Math.max(goal, 1)) * 100);

    const summary: TodaySummary = {
      dateKey,
      calories: Math.round(view.calories),
      calorieGoal: view.calorieGoal,
      calorieProgress: uncappedPct(view.calories, view.calorieGoal),
      proteinProgress: uncappedPct(view.protein, view.proteinGoal),
      carbsProgress: uncappedPct(view.carbs, view.carbsGoal),
      fatProgress: uncappedPct(view.fat, view.fatGoal),
    };

    const payload = JSON.stringify(summary);
    if (payload === lastPayloadRef.current) {
      return;
    }
    lastPayloadRef.current = payload;

    const writeWidget = () => {
      storage.set(SUMMARY_KEY, summary);
      ExtensionStorage.reloadWidget();
    };

    if (!hasMeasuredInitialSyncRef.current) {
      hasMeasuredInitialSyncRef.current = true;
      void traceStartupOperation(
        {
          name: "widget.sync",
          op: "ui.widget.update",
          attributes: {
            "startup.payload_bytes": payload.length,
          },
        },
        async () => writeWidget(),
      );
    } else {
      writeWidget();
    }
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

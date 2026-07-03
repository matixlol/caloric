import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useAllFoodEntries, useDataStoreReady, useUserSettings } from "../data/DataProvider";
import { ensureICloudBackup } from "./iCloudBackup";
import { traceStartupOperation } from "../performance/startup";

function serializeNutrition(nutrition?: {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugars?: number;
  sodiumMg?: number;
  potassiumMg?: number;
} | null) {
  if (!nutrition) {
    return undefined;
  }

  return {
    calories: nutrition.calories,
    protein: nutrition.protein,
    carbs: nutrition.carbs,
    fat: nutrition.fat,
    fiber: nutrition.fiber,
    sugars: nutrition.sugars,
    sodiumMg: nutrition.sodiumMg,
    potassiumMg: nutrition.potassiumMg,
  };
}

function serializeAccountSnapshot(logs: ReturnType<typeof useAllFoodEntries>["data"], settings: NonNullable<ReturnType<typeof useUserSettings>["data"]>) {
  return {
    version: 1,
    exportedAt: Date.now(),
    account: {
      root: {
        calorieGoal: settings.calorieGoal,
        macroProteinPct: settings.macroProteinPct,
        macroCarbsPct: settings.macroCarbsPct,
        macroFatPct: settings.macroFatPct,
        logs: logs.map((entry) => ({
          meal: entry.meal,
          foodName: entry.foodName,
          brand: entry.brand,
          serving: entry.serving,
          portion: entry.portion,
          nutrition: serializeNutrition(entry.nutrition),
          createdAt: entry.createdAt,
          dateKey: entry.dateKey,
          sortIndex: entry.sortIndex,
        })),
      },
    },
  };
}

export function AutoBackupCoordinator() {
  const isReady = useDataStoreReady();
  const { data: logs } = useAllFoodEntries("icloud_backup");
  const { data: settings } = useUserSettings("icloud_backup");
  const isEnsuringBackupRef = useRef(false);
  const hasMeasuredInitialBackupRef = useRef(false);
  const wasBackupSourceReadyRef = useRef(false);

  const createSnapshotJson = useCallback(() => {
    if (Platform.OS !== "ios" || !isReady || !settings) {
      return null;
    }

    return JSON.stringify(serializeAccountSnapshot(logs, settings));
  }, [isReady, logs, settings]);

  const ensureBackup = useCallback(async () => {
    if (isEnsuringBackupRef.current) {
      return;
    }

    isEnsuringBackupRef.current = true;
    const runBackup = async () => {
      const json = createSnapshotJson();
      if (!json) {
        return;
      }

      await ensureICloudBackup(json);
    };

    try {
      if (!hasMeasuredInitialBackupRef.current) {
        await traceStartupOperation(
          {
            name: "icloud_backup.ensure",
            op: "file.write",
          },
          runBackup,
        );
        hasMeasuredInitialBackupRef.current = true;
      } else {
        await runBackup();
      }
    } finally {
      isEnsuringBackupRef.current = false;
    }
  }, [createSnapshotJson]);

  useEffect(() => {
    const isBackupSourceReady = Platform.OS === "ios" && isReady && Boolean(settings);

    if (isBackupSourceReady && !wasBackupSourceReadyRef.current) {
      void ensureBackup();
    }

    wasBackupSourceReadyRef.current = isBackupSourceReady;
  }, [ensureBackup, isReady, settings]);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void ensureBackup();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [ensureBackup]);

  return null;
}

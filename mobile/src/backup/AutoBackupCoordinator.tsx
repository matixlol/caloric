import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useAccount } from "jazz-tools/expo";
import { CaloricAccount } from "../jazz/schema";
import { ensureICloudBackup } from "./iCloudBackup";

type SnapshotNutrition = {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugars?: number;
  sodiumMg?: number;
  potassiumMg?: number;
};

type SnapshotFood = {
  $isLoaded: boolean;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: SnapshotNutrition | null;
};

type SnapshotLog = {
  $isLoaded: boolean;
  meal: string;
  foodName: string;
  brand?: string;
  serving?: string;
  portion: number;
  nutrition?: SnapshotNutrition | null;
  createdAt: number;
  dateKey?: string;
};

type LoadedAccountSnapshotSource = {
  profile: {
    name: string;
    email: string;
  };
  root: {
    calorieGoal?: number;
    macroProteinPct?: number;
    macroCarbsPct?: number;
    macroFatPct?: number;
    foods?: SnapshotFood[];
    logs?: SnapshotLog[];
  };
};

function serializeNutrition(nutrition?: SnapshotNutrition | null) {
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

function serializeAccountSnapshot(account: LoadedAccountSnapshotSource) {
  const foods = account.root.foods
    ? account.root.foods.filter((item) => item.$isLoaded).map((item) => ({
        name: item.name,
        brand: item.brand,
        serving: item.serving,
        nutrition: serializeNutrition(item.nutrition),
      }))
    : [];

  const logs = account.root.logs
    ? account.root.logs.filter((entry) => entry.$isLoaded).map((entry) => ({
        meal: entry.meal,
        foodName: entry.foodName,
        brand: entry.brand,
        serving: entry.serving,
        portion: entry.portion,
        nutrition: serializeNutrition(entry.nutrition),
        createdAt: entry.createdAt,
        dateKey: entry.dateKey,
      }))
    : [];

  return {
    version: 1,
    exportedAt: Date.now(),
    account: {
      profile: {
        name: account.profile.name,
        email: account.profile.email,
      },
      root: {
        calorieGoal: account.root.calorieGoal,
        macroProteinPct: account.root.macroProteinPct,
        macroCarbsPct: account.root.macroCarbsPct,
        macroFatPct: account.root.macroFatPct,
        foods,
        logs,
      },
    },
  };
}

export function AutoBackupCoordinator() {
  const account = useAccount(CaloricAccount, {
    resolve: {
      profile: true,
      root: {
        foods: { $each: { nutrition: true } },
        logs: { $each: { nutrition: true } },
      },
    },
  });
  const isEnsuringBackupRef = useRef(false);
  const wasBackupSourceReadyRef = useRef(false);

  const createSnapshotJson = useCallback(() => {
    if (Platform.OS !== "ios" || !account.$isLoaded) {
      return null;
    }

    return JSON.stringify(
      serializeAccountSnapshot(account as unknown as LoadedAccountSnapshotSource),
    );
  }, [account]);

  const ensureBackup = useCallback(async () => {
    const json = createSnapshotJson();
    if (!json || isEnsuringBackupRef.current) {
      return;
    }

    isEnsuringBackupRef.current = true;

    try {
      await ensureICloudBackup(json);
    } finally {
      isEnsuringBackupRef.current = false;
    }
  }, [createSnapshotJson]);

  useEffect(() => {
    const isBackupSourceReady = Platform.OS === "ios" && account.$isLoaded;

    if (isBackupSourceReady && !wasBackupSourceReadyRef.current) {
      void ensureBackup();
    }

    wasBackupSourceReadyRef.current = isBackupSourceReady;
  }, [account.$isLoaded, ensureBackup]);

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

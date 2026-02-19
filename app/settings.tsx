import { useRouter } from "expo-router";
import { useUser } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAccount } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../src/jazz/schema";

const DEFAULT_CALORIE_GOAL = 2500;
const DEFAULT_PROTEIN_PCT = 30;
const DEFAULT_CARBS_PCT = 50;
const DEFAULT_FAT_PCT = 20;
const MIN_CALORIE_GOAL = 100;
const MAX_CALORIE_GOAL = 10000;

function SectionTitle({ title }: { title: string }) {
  return <Text className="mb-6 mt-8 text-xs font-bold uppercase tracking-wide text-ink/40">{title}</Text>;
}

function parseWholeNumber(value: string) {
  const normalized = value.replace(/[^0-9]/g, "");
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useUser();
  const me = useAccount(CaloricAccount, { resolve: { profile: true, root: true } });
  const [goalInput, setGoalInput] = useState("");
  const [proteinInput, setProteinInput] = useState("");
  const [carbsInput, setCarbsInput] = useState("");
  const [fatInput, setFatInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const fallbackEmail =
    user?.primaryEmailAddress?.emailAddress ||
    user?.emailAddresses?.[0]?.emailAddress ||
    "No email found";
  const syncedGoal = me.$isLoaded ? me.root.calorieGoal : undefined;
  const syncedProtein = me.$isLoaded ? me.root.macroProteinPct : undefined;
  const syncedCarbs = me.$isLoaded ? me.root.macroCarbsPct : undefined;
  const syncedFat = me.$isLoaded ? me.root.macroFatPct : undefined;

  useEffect(() => {
    if (!me.$isLoaded) return;

    setGoalInput(String(me.root.calorieGoal ?? DEFAULT_CALORIE_GOAL));
    setProteinInput(String(me.root.macroProteinPct ?? DEFAULT_PROTEIN_PCT));
    setCarbsInput(String(me.root.macroCarbsPct ?? DEFAULT_CARBS_PCT));
    setFatInput(String(me.root.macroFatPct ?? DEFAULT_FAT_PCT));
  }, [
    me.$isLoaded,
    syncedGoal,
    syncedProtein,
    syncedCarbs,
    syncedFat,
  ]);

  useEffect(() => {
    setSaveError(null);
    setSaveSuccess(null);
  }, [goalInput, proteinInput, carbsInput, fatInput]);

  if (!me.$isLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <Text className="text-sm font-semibold uppercase text-ink/40">Loading settings…</Text>
      </View>
    );
  }

  const loadedGoal = me.root.calorieGoal ?? DEFAULT_CALORIE_GOAL;
  const loadedProtein = me.root.macroProteinPct ?? DEFAULT_PROTEIN_PCT;
  const loadedCarbs = me.root.macroCarbsPct ?? DEFAULT_CARBS_PCT;
  const loadedFat = me.root.macroFatPct ?? DEFAULT_FAT_PCT;

  const parsedGoal = parseWholeNumber(goalInput);
  const parsedProtein = parseWholeNumber(proteinInput);
  const parsedCarbs = parseWholeNumber(carbsInput);
  const parsedFat = parseWholeNumber(fatInput);
  const macroTotal = (parsedProtein ?? 0) + (parsedCarbs ?? 0) + (parsedFat ?? 0);

  let validationError: string | null = null;

  if (!parsedGoal || parsedGoal < MIN_CALORIE_GOAL || parsedGoal > MAX_CALORIE_GOAL) {
    validationError = `Daily calorie goal must be between ${MIN_CALORIE_GOAL} and ${MAX_CALORIE_GOAL}.`;
  } else if (parsedProtein === null || parsedCarbs === null || parsedFat === null) {
    validationError = "Macro ratios must be whole numbers.";
  } else if (parsedProtein > 100 || parsedCarbs > 100 || parsedFat > 100) {
    validationError = "Each macro ratio must be between 0 and 100.";
  } else if (macroTotal !== 100) {
    validationError = "Macro ratios must add up to 100%.";
  }

  const hasChanges =
    parsedGoal !== loadedGoal ||
    parsedProtein !== loadedProtein ||
    parsedCarbs !== loadedCarbs ||
    parsedFat !== loadedFat;

  const profileEmail = me.profile.email || fallbackEmail;
  const previewGoal = parsedGoal ?? loadedGoal;
  const sliderProgress = clamp(((previewGoal - 1200) / (4000 - 1200)) * 100, 0, 100);

  const handleSave = () => {
    setSaveError(null);
    setSaveSuccess(null);

    if (validationError || parsedGoal === null || parsedProtein === null || parsedCarbs === null || parsedFat === null) {
      setSaveError(validationError || "Enter valid values before saving.");
      return;
    }

    me.root.$jazz.set("calorieGoal", parsedGoal);
    me.root.$jazz.set("macroProteinPct", parsedProtein);
    me.root.$jazz.set("macroCarbsPct", parsedCarbs);
    me.root.$jazz.set("macroFatPct", parsedFat);
    setSaveSuccess("Saved successfully.");
  };

  return (
    <View className="flex-1 bg-cream" style={{ paddingTop: insets.top + 20 }}>
      <View className="mb-8 flex-row items-center justify-between px-6">
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text className="border-b-2 border-ink pb-0.5 text-sm font-bold uppercase text-ink">BACK</Text>
        </Pressable>
        <Text className="text-sm font-bold uppercase text-ink">SETTINGS</Text>
      </View>

      <ScrollView className="flex-1 px-6" showsVerticalScrollIndicator={false}>
        <SectionTitle title="Account" />
        <View className="mb-8 border-b border-ink/10 py-3">
          <Text className="mb-1 text-sm font-medium text-ink/40">Signed in as</Text>
          <Text className="text-base font-semibold text-ink">{profileEmail}</Text>
        </View>

        <SectionTitle title="Goals" />
        <View className="mb-10">
          <View className="mb-3 flex-row items-end justify-between">
            <Text className="text-base font-semibold text-ink">Daily Calorie Goal</Text>
            <TextInput
              className="min-w-[130px] border-b border-ink/20 pb-1 text-right text-[32px] font-extrabold text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
              value={goalInput}
              onChangeText={setGoalInput}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={5}
              accessibilityLabel="Daily calorie goal"
            />
          </View>
          <View className="relative my-5 h-1 bg-ink/10">
            <View className="absolute h-5 w-5 rounded-full bg-ink" style={{ left: `${sliderProgress}%`, top: -8, marginLeft: -10 }} />
          </View>
        </View>

        <SectionTitle title="Macro Ratios" />
        <View className="mb-4 flex-row gap-3">
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Protein</Text>
            <View className="flex-row items-center">
              <TextInput
                className="text-xl font-bold text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
                value={proteinInput}
                onChangeText={setProteinInput}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={3}
                accessibilityLabel="Protein macro ratio"
              />
              <Text className="text-xl font-bold text-ink">%</Text>
            </View>
          </View>
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Carbs</Text>
            <View className="flex-row items-center">
              <TextInput
                className="text-xl font-bold text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
                value={carbsInput}
                onChangeText={setCarbsInput}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={3}
                accessibilityLabel="Carbs macro ratio"
              />
              <Text className="text-xl font-bold text-ink">%</Text>
            </View>
          </View>
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Fat</Text>
            <View className="flex-row items-center">
              <TextInput
                className="text-xl font-bold text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
                value={fatInput}
                onChangeText={setFatInput}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={3}
                accessibilityLabel="Fat macro ratio"
              />
              <Text className="text-xl font-bold text-ink">%</Text>
            </View>
          </View>
        </View>
        <Text className="mb-8 text-xs font-semibold uppercase text-ink/40">Total: {macroTotal}%</Text>
      </ScrollView>

      <View className="bg-cream px-6 pb-6 pt-6" style={{ paddingBottom: insets.bottom + 20 }}>
        {saveError ? <Text className="mb-3 text-xs font-semibold uppercase text-red-600">{saveError}</Text> : null}
        {saveSuccess ? <Text className="mb-3 text-xs font-semibold uppercase text-emerald-700">{saveSuccess}</Text> : null}
        <Pressable
          className={`rounded-xl px-4 py-[18px] ${hasChanges ? "bg-ink" : "bg-ink/35"}`}
          accessibilityRole="button"
          onPress={handleSave}
          disabled={!hasChanges}
        >
          <Text className="text-center text-base font-bold uppercase tracking-wide text-cream">Save Changes</Text>
        </Pressable>
      </View>
    </View>
  );
}

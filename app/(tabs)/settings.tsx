import { useClerk, useUser } from "@clerk/clerk-expo";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { useAccount } from "jazz-tools/expo";
import {
  Alert,
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
import { CaloricAccount } from "../../src/jazz/schema";

const DEFAULT_CALORIE_GOAL = 2500;
const DEFAULT_PROTEIN_PCT = 30;
const DEFAULT_CARBS_PCT = 50;
const DEFAULT_FAT_PCT = 20;
const MIN_CALORIE_GOAL = 100;
const MAX_CALORIE_GOAL = 10000;

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  tertiaryLabel: iosColor("tertiaryLabel", "#9CA3AF"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: iosColor("systemBlue", "#2563EB"),
  tintDisabled: iosColor("systemGray3", "#D1D5DB"),
  success: iosColor("systemGreen", "#16A34A"),
  error: iosColor("systemRed", "#DC2626"),
  white: iosColor("white", "#FFFFFF"),
};

function parseWholeNumber(value: string) {
  const normalized = value.replace(/[^0-9]/g, "");
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function FormRow({
  label,
  value,
  onChange,
  suffix,
  accessibilityLabel,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  suffix?: string;
  accessibilityLabel: string;
  maxLength: number;
}) {
  return (
    <View style={styles.formRow}>
      <Text style={styles.formRowLabel}>{label}</Text>
      <View style={styles.formValueWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={maxLength}
          accessibilityLabel={accessibilityLabel}
          style={styles.formInput}
        />
        {suffix ? <Text style={styles.formSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const clerk = useClerk();
  const { user } = useUser();
  const me = useAccount(CaloricAccount, { resolve: { profile: true, root: true } });
  const [goalInput, setGoalInput] = useState("");
  const [proteinInput, setProteinInput] = useState("");
  const [carbsInput, setCarbsInput] = useState("");
  const [fatInput, setFatInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  const clerkEmail =
    user?.primaryEmailAddress?.emailAddress ||
    user?.emailAddresses?.[0]?.emailAddress ||
    "No email found";
  const syncedGoal = me.$isLoaded ? me.root.calorieGoal : undefined;
  const syncedProtein = me.$isLoaded ? me.root.macroProteinPct : undefined;
  const syncedCarbs = me.$isLoaded ? me.root.macroCarbsPct : undefined;
  const syncedFat = me.$isLoaded ? me.root.macroFatPct : undefined;

  useEffect(() => {
    if (!me.$isLoaded) return;

    setGoalInput(String(syncedGoal ?? DEFAULT_CALORIE_GOAL));
    setProteinInput(String(syncedProtein ?? DEFAULT_PROTEIN_PCT));
    setCarbsInput(String(syncedCarbs ?? DEFAULT_CARBS_PCT));
    setFatInput(String(syncedFat ?? DEFAULT_FAT_PCT));
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
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings…</Text>
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

  let goalValidationError: string | null = null;
  let macroValidationError: string | null = null;

  if (!parsedGoal || parsedGoal < MIN_CALORIE_GOAL || parsedGoal > MAX_CALORIE_GOAL) {
    goalValidationError = `Daily calorie goal must be between ${MIN_CALORIE_GOAL} and ${MAX_CALORIE_GOAL}.`;
  }

  if (parsedProtein === null || parsedCarbs === null || parsedFat === null) {
    macroValidationError = "Macro ratios must be whole numbers.";
  } else if (parsedProtein > 100 || parsedCarbs > 100 || parsedFat > 100) {
    macroValidationError = "Each macro ratio must be between 0 and 100.";
  } else if (macroTotal !== 100) {
    macroValidationError = "Macro ratios must add up to 100%.";
  }

  const validationError = goalValidationError || macroValidationError;

  const hasChanges =
    parsedGoal !== loadedGoal ||
    parsedProtein !== loadedProtein ||
    parsedCarbs !== loadedCarbs ||
    parsedFat !== loadedFat;

  const profileEmail = clerkEmail;

  const handleSave = () => {
    setSaveError(null);
    setSaveSuccess(null);

    if (
      validationError ||
      parsedGoal === null ||
      parsedProtein === null ||
      parsedCarbs === null ||
      parsedFat === null
    ) {
      setSaveError(goalValidationError);
      return;
    }

    me.root.$jazz.set("calorieGoal", parsedGoal);
    me.root.$jazz.set("macroProteinPct", parsedProtein);
    me.root.$jazz.set("macroCarbsPct", parsedCarbs);
    me.root.$jazz.set("macroFatPct", parsedFat);
    setSaveSuccess("Saved successfully.");
  };

  const handleSignOut = async () => {
    if (isSigningOut) {
      return;
    }

    setSignOutError(null);
    setIsSigningOut(true);

    try {
      await clerk.signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Try again.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const confirmSignOut = () => {
    if (isSigningOut) {
      return;
    }

    Alert.alert("Sign out?", "You will need to sign in again to access your account.", [
      {
        text: "Cancel",
        style: "cancel",
      },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => {
          void handleSignOut();
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: insets.bottom + 116,
          },
        ]}
      >
        <Text style={styles.largeTitle}>Settings</Text>

        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Signed in as</Text>
            <Text style={styles.accountValue}>{profileEmail}</Text>
          </View>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={confirmSignOut}
            disabled={isSigningOut}
            style={[styles.signOutButton, isSigningOut && styles.signOutButtonDisabled]}
          >
            <Text style={[styles.signOutButtonText, isSigningOut && styles.signOutButtonTextDisabled]}>
              {isSigningOut ? "Signing Out..." : "Sign Out"}
            </Text>
          </Pressable>
        </View>
        {signOutError ? <Text style={styles.sectionErrorText}>{signOutError}</Text> : null}

        <Text style={styles.sectionTitle}>Goals</Text>
        <View style={styles.card}>
          <FormRow
            label="Daily Calories"
            value={goalInput}
            onChange={setGoalInput}
            accessibilityLabel="Daily calorie goal"
            maxLength={5}
          />
        </View>

        <Text style={styles.sectionTitle}>Macro Ratios</Text>
        <View style={styles.card}>
          <FormRow
            label="Protein"
            value={proteinInput}
            onChange={setProteinInput}
            suffix="%"
            accessibilityLabel="Protein macro ratio"
            maxLength={3}
          />
          <View style={styles.divider} />
          <FormRow
            label="Carbs"
            value={carbsInput}
            onChange={setCarbsInput}
            suffix="%"
            accessibilityLabel="Carbs macro ratio"
            maxLength={3}
          />
          <View style={styles.divider} />
          <FormRow
            label="Fat"
            value={fatInput}
            onChange={setFatInput}
            suffix="%"
            accessibilityLabel="Fat macro ratio"
            maxLength={3}
          />
          <View style={styles.divider} />
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Total</Text>
            <Text style={[styles.totalValue, macroTotal !== 100 && styles.errorText]}>
              {macroTotal}%
            </Text>
          </View>
        </View>
        {macroValidationError ? <Text style={styles.sectionErrorText}>{macroValidationError}</Text> : null}
      </ScrollView>

      <View style={[styles.actionBarContainer, { paddingBottom: insets.bottom + 12 }]}>
        {canUseGlass ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor="rgba(255,255,255,0.2)"
            style={StyleSheet.absoluteFillObject}
          />
        ) : null}

        {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        {saveSuccess ? <Text style={styles.successText}>{saveSuccess}</Text> : null}

        <Pressable
          accessibilityRole="button"
          onPress={handleSave}
          disabled={!hasChanges}
          style={[styles.saveButton, !hasChanges && styles.saveButtonDisabled]}
        >
          <Text style={[styles.saveButtonText, !hasChanges && styles.saveButtonTextDisabled]}>
            Save Changes
          </Text>
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
    gap: 12,
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
  sectionTitle: {
    marginTop: 8,
    paddingHorizontal: 4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  formRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  formRowLabel: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  accountValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  signOutButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  signOutButtonDisabled: {
    opacity: 0.5,
  },
  signOutButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.error,
  },
  signOutButtonTextDisabled: {
    color: palette.secondaryLabel,
  },
  formValueWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    minWidth: 92,
  },
  formInput: {
    minWidth: 52,
    textAlign: "right",
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.tint,
    fontVariant: ["tabular-nums"],
  },
  formSuffix: {
    marginLeft: 2,
    fontSize: 17,
    lineHeight: 22,
    color: palette.tint,
    fontWeight: "600",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.separator,
  },
  totalValue: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
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
  saveButton: {
    marginTop: 2,
    borderRadius: 12,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  saveButtonDisabled: {
    backgroundColor: palette.tintDisabled,
  },
  saveButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.white,
  },
  saveButtonTextDisabled: {
    color: palette.secondaryLabel,
  },
  sectionErrorText: {
    paddingHorizontal: 4,
    marginTop: -4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.error,
  },
  errorText: {
    marginBottom: 6,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.error,
  },
  successText: {
    marginBottom: 6,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.success,
  },
});

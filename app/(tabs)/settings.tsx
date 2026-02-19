import { useClerk, useUser } from "@clerk/clerk-expo";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "jazz-tools/expo";
import {
  Alert,
  PanResponder,
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
  tint: "#2563EB",
  tintDisabled: "#D1D5DB",
  success: iosColor("systemGreen", "#16A34A"),
  error: iosColor("systemRed", "#DC2626"),
  white: "#FFFFFF",
  macroProtein: "#2563EB",
  macroCarbs: "#F59E0B",
  macroFat: "#14B8A6",
};

const MACRO_DIVISIONS = 10;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function parseWholeNumber(value: string) {
  const normalized = value.replace(/[^0-9]/g, "");
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMacroRatios(
  proteinRaw?: number,
  carbsRaw?: number,
  fatRaw?: number,
) {
  const protein = clamp(Math.round(proteinRaw ?? DEFAULT_PROTEIN_PCT), 0, 100);
  const carbs = clamp(Math.round(carbsRaw ?? DEFAULT_CARBS_PCT), 0, 100);
  const fat = clamp(Math.round(fatRaw ?? DEFAULT_FAT_PCT), 0, 100);

  if (protein + carbs + fat !== 100) {
    return {
      protein: DEFAULT_PROTEIN_PCT,
      carbs: DEFAULT_CARBS_PCT,
      fat: DEFAULT_FAT_PCT,
    };
  }

  return { protein, carbs, fat };
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
  const [macroSplitA, setMacroSplitA] = useState(DEFAULT_PROTEIN_PCT);
  const [macroSplitB, setMacroSplitB] = useState(DEFAULT_PROTEIN_PCT + DEFAULT_CARBS_PCT);
  const [macroTrackWidth, setMacroTrackWidth] = useState(0);
  const [activeHandle, setActiveHandle] = useState<"first" | "second" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  const macroTrackWidthRef = useRef(macroTrackWidth);
  const macroSplitARef = useRef(macroSplitA);
  const macroSplitBRef = useRef(macroSplitB);
  const dragStartRef = useRef({ splitA: macroSplitA, splitB: macroSplitB });

  useEffect(() => {
    macroTrackWidthRef.current = macroTrackWidth;
  }, [macroTrackWidth]);

  useEffect(() => {
    macroSplitARef.current = macroSplitA;
  }, [macroSplitA]);

  useEffect(() => {
    macroSplitBRef.current = macroSplitB;
  }, [macroSplitB]);

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

    const normalizedMacros = normalizeMacroRatios(syncedProtein, syncedCarbs, syncedFat);

    setGoalInput(String(syncedGoal ?? DEFAULT_CALORIE_GOAL));
    setMacroSplitA(normalizedMacros.protein);
    setMacroSplitB(normalizedMacros.protein + normalizedMacros.carbs);
  }, [me.$isLoaded, syncedGoal, syncedProtein, syncedCarbs, syncedFat]);

  useEffect(() => {
    setSaveError(null);
    setSaveSuccess(null);
  }, [goalInput, macroSplitA, macroSplitB]);

  const firstHandleResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        dragStartRef.current = {
          splitA: macroSplitARef.current,
          splitB: macroSplitBRef.current,
        };
        setActiveHandle("first");
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (macroTrackWidthRef.current <= 0) {
          return;
        }

        const deltaPct = (gestureState.dx / macroTrackWidthRef.current) * 100;
        const nextSplitA = clamp(
          Math.round(dragStartRef.current.splitA + deltaPct),
          0,
          dragStartRef.current.splitB,
        );

        setMacroSplitA(nextSplitA);
      },
      onPanResponderRelease: () => {
        setActiveHandle(null);
      },
      onPanResponderTerminate: () => {
        setActiveHandle(null);
      },
    }),
  ).current;

  const secondHandleResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        dragStartRef.current = {
          splitA: macroSplitARef.current,
          splitB: macroSplitBRef.current,
        };
        setActiveHandle("second");
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (macroTrackWidthRef.current <= 0) {
          return;
        }

        const deltaPct = (gestureState.dx / macroTrackWidthRef.current) * 100;
        const nextSplitB = clamp(
          Math.round(dragStartRef.current.splitB + deltaPct),
          dragStartRef.current.splitA,
          100,
        );

        setMacroSplitB(nextSplitB);
      },
      onPanResponderRelease: () => {
        setActiveHandle(null);
      },
      onPanResponderTerminate: () => {
        setActiveHandle(null);
      },
    }),
  ).current;

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings…</Text>
      </View>
    );
  }

  const loadedGoal = me.root.calorieGoal ?? DEFAULT_CALORIE_GOAL;
  const loadedMacros = normalizeMacroRatios(
    me.root.macroProteinPct,
    me.root.macroCarbsPct,
    me.root.macroFatPct,
  );

  const proteinPct = macroSplitA;
  const carbsPct = macroSplitB - macroSplitA;
  const fatPct = 100 - macroSplitB;

  const parsedGoal = parseWholeNumber(goalInput);

  let goalValidationError: string | null = null;

  if (!parsedGoal || parsedGoal < MIN_CALORIE_GOAL || parsedGoal > MAX_CALORIE_GOAL) {
    goalValidationError = `Daily calorie goal must be between ${MIN_CALORIE_GOAL} and ${MAX_CALORIE_GOAL}.`;
  }

  const validationError = goalValidationError;

  const hasChanges =
    parsedGoal !== loadedGoal ||
    proteinPct !== loadedMacros.protein ||
    carbsPct !== loadedMacros.carbs ||
    fatPct !== loadedMacros.fat;

  const profileEmail = clerkEmail;

  const handleSave = () => {
    setSaveError(null);
    setSaveSuccess(null);

    if (validationError || parsedGoal === null) {
      setSaveError(validationError);
      return;
    }

    me.root.$jazz.set("calorieGoal", parsedGoal);
    me.root.$jazz.set("macroProteinPct", proteinPct);
    me.root.$jazz.set("macroCarbsPct", carbsPct);
    me.root.$jazz.set("macroFatPct", fatPct);
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

  const firstDividerLeft = (macroTrackWidth * proteinPct) / 100;
  const secondDividerLeft = (macroTrackWidth * (proteinPct + carbsPct)) / 100;

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
          <View style={styles.macroLegendRow}>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroProtein }]} />
              <Text style={styles.macroLegendText}>Protein {proteinPct}%</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroCarbs }]} />
              <Text style={styles.macroLegendText}>Carbs {carbsPct}%</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroFat }]} />
              <Text style={styles.macroLegendText}>Fat {fatPct}%</Text>
            </View>
          </View>

          <View
            style={styles.macroSliderWrap}
            onLayout={(event) => {
              setMacroTrackWidth(event.nativeEvent.layout.width);
            }}
          >
            <View style={styles.macroSliderTrack}>
              <View style={[styles.macroSection, styles.macroProteinSection, { width: `${proteinPct}%` }]} />
              <View
                style={[
                  styles.macroSection,
                  styles.macroCarbsSection,
                  { left: `${proteinPct}%`, width: `${carbsPct}%` },
                ]}
              />
              <View
                style={[
                  styles.macroSection,
                  styles.macroFatSection,
                  { left: `${proteinPct + carbsPct}%`, width: `${fatPct}%` },
                ]}
              />

              <View pointerEvents="none" style={styles.macroDivisionOverlay}>
                {Array.from({ length: MACRO_DIVISIONS - 1 }).map((_, index) => (
                  <View
                    key={index}
                    style={[
                      styles.macroDivision,
                      {
                        left: `${((index + 1) / MACRO_DIVISIONS) * 100}%`,
                      },
                    ]}
                  />
                ))}
              </View>

              <View style={[styles.macroHandleContainer, { left: firstDividerLeft }]}>
                <View
                  {...firstHandleResponder.panHandlers}
                  accessibilityLabel="Adjust protein and carbs split"
                  style={[styles.macroHandle, activeHandle === "first" && styles.macroHandleActive]}
                >
                  <View style={styles.macroHandleGrip} />
                </View>
              </View>

              <View style={[styles.macroHandleContainer, { left: secondDividerLeft }]}>
                <View
                  {...secondHandleResponder.panHandlers}
                  accessibilityLabel="Adjust carbs and fat split"
                  style={[styles.macroHandle, activeHandle === "second" && styles.macroHandleActive]}
                >
                  <View style={styles.macroHandleGrip} />
                </View>
              </View>
            </View>
          </View>

          <Text style={styles.macroHelpText}>Drag the two dividers to resize each macro section.</Text>
        </View>
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
    paddingVertical: 10,
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
  macroLegendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 12,
  },
  macroLegendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  macroLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  macroLegendText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
  },
  macroSliderWrap: {
    marginVertical: 8,
  },
  macroSliderTrack: {
    height: 44,
    borderRadius: 14,
    backgroundColor: iosColor("quaternarySystemFill", "#E5E7EB"),
    overflow: "visible",
    position: "relative",
  },
  macroSection: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  macroProteinSection: {
    left: 0,
    backgroundColor: palette.macroProtein,
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
  },
  macroCarbsSection: {
    backgroundColor: palette.macroCarbs,
  },
  macroFatSection: {
    backgroundColor: palette.macroFat,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
  },
  macroDivisionOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  macroDivision: {
    position: "absolute",
    top: 7,
    bottom: 7,
    width: StyleSheet.hairlineWidth,
    marginLeft: -0.5,
    backgroundColor: "rgba(255,255,255,0.8)",
  },
  macroHandleContainer: {
    position: "absolute",
    top: -8,
    bottom: -8,
    width: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  macroHandle: {
    width: 26,
    height: 60,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "rgba(17,24,39,0.16)",
    backgroundColor: "rgba(255,255,255,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  macroHandleActive: {
    borderColor: palette.tint,
  },
  macroHandleGrip: {
    width: 3,
    height: 24,
    borderRadius: 2,
    backgroundColor: "rgba(17,24,39,0.35)",
  },
  macroHelpText: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: palette.tertiaryLabel,
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

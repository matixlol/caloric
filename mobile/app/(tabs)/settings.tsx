import { useClerk, useUser } from "@clerk/expo";
import * as Updates from "expo-updates";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useDataStoreActions,
  useDataStoreReady,
  useSyncStatus,
  useUserSettings,
} from "../../src/data/DataProvider";
import { formatRelativeTimestamp } from "../../src/time";
import { macroColors } from "../../src/theme/macroColors";

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
  buttonText: "#FFFFFF",
  buttonDisabledBackground: iosColor("tertiarySystemFill", "#D1D5DB"),
  buttonDisabledText: iosColor("secondaryLabel", "#6B7280"),
  success: iosColor("systemGreen", "#16A34A"),
  error: iosColor("systemRed", "#DC2626"),
  macroProtein: macroColors.protein.background,
  macroCarbs: macroColors.carbs.background,
  macroFat: macroColors.fat.background,
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

function formatUpdateTimestamp(value: Date | null | undefined): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "Never";
  }

  return value.toLocaleString();
}

function getUpdatesStatusLabel(options: {
  isEnabled: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  isRestarting: boolean;
  isUpdatePending: boolean;
  isUpdateAvailable: boolean;
  error: string | null;
}): string {
  if (!options.isEnabled) {
    return "Updates unavailable";
  }

  if (options.error) {
    return options.error;
  }

  if (options.isRestarting) {
    return "Applying update...";
  }

  if (options.isDownloading) {
    return "Downloading update...";
  }

  if (options.isUpdatePending) {
    return "Update ready to apply";
  }

  if (options.isChecking) {
    return "Checking updates...";
  }

  if (options.isUpdateAvailable) {
    return "Update available";
  }

  return "Up to date";
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

type SmallButtonProps = {
  label: string; accessibilityLabel: string; disabled?: boolean; onPress: () => void; secondary?: boolean; showDisabledState?: boolean;
};

function SmallButton(props: SmallButtonProps) {
  const disabledStyle = props.showDisabledState && props.disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.smallButton,
        props.secondary ? styles.smallSecondaryButton : styles.smallPrimaryButton,
        disabledStyle && styles.smallPrimaryButtonDisabled,
      ]}
    >
      <Text
        style={[
          styles.smallButtonText,
          props.secondary ? styles.smallSecondaryButtonText : styles.smallPrimaryButtonText,
          disabledStyle && styles.smallPrimaryButtonTextDisabled,
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function SocialRow({ name, meta, index, children }: { name: string; meta: string; index: number; children?: ReactNode }) {
  return (
    <View style={[styles.socialRow, index > 0 && styles.socialRowDivider]}>
      <View style={styles.socialRowMain}>
        <Text numberOfLines={1} style={styles.socialName}>{name}</Text>
        <Text style={styles.socialMeta}>{meta}</Text>
      </View>
      {children}
    </View>
  );
}

function SocialSection<T>(props: { items: readonly T[] | undefined; renderItem: (item: T, index: number) => ReactNode }) {
  const { items, renderItem } = props;
  return items?.length ? <><View style={styles.divider} />{items.map(renderItem)}</> : null;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const clerk = useClerk();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const isDataReady = useDataStoreReady();
  const {
    acceptFriendRequest,
    getSocialOverview,
    ignoreFriendRequest,
    removeFriend,
    sendFriendRequest,
    updateSocialProfile,
    upsertUserSettings,
  } = useDataStoreActions();
  const { data: syncedSettings, isLoading: isLoadingSettings } = useUserSettings();
  const { data: syncStatus, isLoading: isLoadingSyncStatus } = useSyncStatus();
  const {
    currentlyRunning,
    isChecking,
    isDownloading,
    isRestarting,
    isUpdateAvailable,
    isUpdatePending,
    checkError,
    downloadError,
    lastCheckForUpdateTimeSinceRestart,
  } = Updates.useUpdates();
  const [goalInput, setGoalInput] = useState("");
  const [macroSplitA, setMacroSplitA] = useState(DEFAULT_PROTEIN_PCT);
  const [macroSplitB, setMacroSplitB] = useState(DEFAULT_PROTEIN_PCT + DEFAULT_CARBS_PCT);
  const [macroTrackWidth, setMacroTrackWidth] = useState(0);
  const [activeHandle, setActiveHandle] = useState<"first" | "second" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [updatesActionError, setUpdatesActionError] = useState<string | null>(null);
  const [friendCodeInput, setFriendCodeInput] = useState("");
  const [socialNameInput, setSocialNameInput] = useState("");
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
  const syncedGoal = syncedSettings?.calorieGoal;
  const syncedProtein = syncedSettings?.macroProteinPct;
  const syncedCarbs = syncedSettings?.macroCarbsPct;
  const syncedFat = syncedSettings?.macroFatPct;

  useEffect(() => {
    if (!syncedSettings) return;

    const normalizedMacros = normalizeMacroRatios(syncedProtein, syncedCarbs, syncedFat);

    setGoalInput(String(syncedGoal ?? DEFAULT_CALORIE_GOAL));
    setMacroSplitA(normalizedMacros.protein);
    setMacroSplitB(normalizedMacros.protein + normalizedMacros.carbs);
  }, [syncedCarbs, syncedFat, syncedGoal, syncedProtein, syncedSettings]);

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

  const loadedGoal = syncedSettings?.calorieGoal ?? DEFAULT_CALORIE_GOAL;
  const loadedMacros = normalizeMacroRatios(
    syncedSettings?.macroProteinPct,
    syncedSettings?.macroCarbsPct,
    syncedSettings?.macroFatPct,
  );

  const proteinPct = macroSplitA;
  const carbsPct = macroSplitB - macroSplitA;
  const fatPct = 100 - macroSplitB;

  const parsedGoal = parseWholeNumber(goalInput);
  const macroGoalBase = parsedGoal ?? loadedGoal;
  const proteinGoal = Math.round((macroGoalBase * (proteinPct / 100)) / 4);
  const carbsGoal = Math.round((macroGoalBase * (carbsPct / 100)) / 4);
  const fatGoal = Math.round((macroGoalBase * (fatPct / 100)) / 9);

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
  const socialOverviewQueryKey = ["socialOverview", user?.id ?? null] as const;
  const updatesErrorMessage = updatesActionError ?? (checkError || downloadError ? "Unknown error." : null);
  const updatesStatusLabel = getUpdatesStatusLabel({
    isEnabled: Updates.isEnabled,
    isChecking,
    isDownloading,
    isRestarting,
    isUpdatePending,
    isUpdateAvailable,
    error: updatesErrorMessage,
  });
  const lastCheckedLabel = formatUpdateTimestamp(lastCheckForUpdateTimeSinceRestart);
  const currentUpdateCreatedAtLabel = formatUpdateTimestamp(currentlyRunning.createdAt);
  const canCheckForUpdates = Updates.isEnabled && !isChecking && !isDownloading && !isRestarting;
  const updateButtonLabel = isUpdatePending
    ? "Apply Update"
    : isUpdateAvailable || isDownloading
      ? "Download Update"
      : "Force Check";

  useEffect(() => {
    if (!syncedSettings) {
      return;
    }

    if (validationError || parsedGoal === null) {
      setSaveError(validationError);
      return;
    }

    setSaveError(null);

    if (!hasChanges) {
      return;
    }

    const timeoutId = setTimeout(() => {
      void upsertUserSettings({
        calorieGoal: parsedGoal,
        macroProteinPct: proteinPct,
        macroCarbsPct: carbsPct,
        macroFatPct: fatPct,
      });
    }, 200);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [
    carbsPct,
    fatPct,
    hasChanges,
    parsedGoal,
    proteinPct,
    syncedSettings,
    upsertUserSettings,
    validationError,
  ]);

  const socialOverviewQuery = useQuery({
    queryKey: socialOverviewQueryKey,
    queryFn: getSocialOverview,
    enabled: isDataReady && Boolean(user?.id),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const socialOverview = socialOverviewQuery.data ?? null;

  const setSocialOverview = (overview: NonNullable<typeof socialOverview>) =>
    queryClient.setQueryData(socialOverviewQueryKey, overview);
  const handleSocialMutationSuccess = (overview: NonNullable<typeof socialOverview>) => {
    setSocialOverview(overview);
    void queryClient.invalidateQueries({ queryKey: ["friendDailySummaries"] });
  };

  const sendFriendRequestMutation = useMutation({
    mutationFn: sendFriendRequest,
    onSuccess: (overview) => {
      handleSocialMutationSuccess(overview);
      setFriendCodeInput("");
    },
  });
  const updateSocialProfileMutation = useMutation({
    mutationFn: updateSocialProfile,
    onSuccess: (overview) => {
      handleSocialMutationSuccess(overview);
      setSocialNameInput("");
    },
  });
  const acceptFriendRequestMutation = useMutation({
    mutationFn: acceptFriendRequest,
    onSuccess: handleSocialMutationSuccess,
  });
  const ignoreFriendRequestMutation = useMutation({
    mutationFn: ignoreFriendRequest,
    onSuccess: setSocialOverview,
  });
  const removeFriendMutation = useMutation({
    mutationFn: removeFriend,
    onSuccess: handleSocialMutationSuccess,
  });
  const socialMutations = [
    sendFriendRequestMutation,
    updateSocialProfileMutation,
    acceptFriendRequestMutation,
    ignoreFriendRequestMutation,
    removeFriendMutation,
  ] as const;
  const socialActionPending = socialMutations.some((mutation) => mutation.isPending);
  const socialActionError = socialMutations.find((mutation) => mutation.error)?.error ?? socialOverviewQuery.error;
  const trimmedSocialName = socialNameInput.replace(/\s+/g, " ").trim();
  const socialDisplayName = socialOverview?.profile.displayName ?? null;
  const socialNameChanged = Boolean(socialDisplayName && trimmedSocialName && trimmedSocialName !== socialDisplayName);
  const trimmedFriendCode = friendCodeInput.trim();

  if (!isDataReady || isLoadingSettings || isLoadingSyncStatus || !syncedSettings) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings…</Text>
      </View>
    );
  }

  const lastSyncedValue = syncStatus.dirty
    ? "Pending"
    : formatRelativeTimestamp(syncStatus.updatedAt);

  const handleSignOut = async () => {
    if (isSigningOut) {
      return;
    }

    setSignOutError(null);
    setIsSigningOut(true);

    try {
      await clerk.signOut();
    } catch {
      setSignOutError("Could not sign out. Try again.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleCheckForUpdates = async () => {
    if (!canCheckForUpdates) {
      return;
    }

    setUpdatesActionError(null);

    try {
      if (isUpdatePending) {
        await Updates.reloadAsync();
        return;
      }

      if (!isUpdateAvailable) {
        await Updates.checkForUpdateAsync();
        return;
      }

      await Updates.fetchUpdateAsync();
    } catch {
      setUpdatesActionError("Unknown error.");
    }
  };

  const confirmRemoveFriend = (friendUserId: string, displayName: string) => {
    Alert.alert("Remove friend?", `Stop sharing daily calories with ${displayName}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeFriendMutation.mutate(friendUserId),
      },
    ]);
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
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View style={styles.titleRow}>
          <Text style={styles.largeTitle}>Settings</Text>
          <View
            style={[
              styles.syncBadge,
              syncStatus.dirty ? styles.syncBadgePending : styles.syncBadgeReady,
            ]}
          >
            <View
              style={[
                styles.syncBadgeDot,
                syncStatus.dirty ? styles.syncBadgeDotPending : styles.syncBadgeDotReady,
              ]}
            />
            <Text style={styles.syncBadgeLabel}>Last synced</Text>
            <Text style={styles.syncBadgeValue}>{lastSyncedValue}</Text>
          </View>
        </View>

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
        {saveError ? <Text style={styles.sectionErrorText}>{saveError}</Text> : null}

        <Text style={styles.sectionTitle}>Macro Ratios</Text>
        <View style={styles.card}>
          <View style={styles.macroLegendRow}>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroProtein }]} />
              <Text style={styles.macroLegendText}>Protein {proteinGoal}g</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroCarbs }]} />
              <Text style={styles.macroLegendText}>Carbs {carbsGoal}g</Text>
            </View>
            <View style={styles.macroLegendItem}>
              <View style={[styles.macroLegendDot, { backgroundColor: palette.macroFat }]} />
              <Text style={styles.macroLegendText}>Fat {fatGoal}g</Text>
            </View>
          </View>

          <View
            style={styles.macroSliderWrap}
            onLayout={(event) => {
              setMacroTrackWidth(event.nativeEvent.layout.width);
            }}
          >
            <View style={styles.macroSliderTrack}>
              <View style={[styles.macroSection, styles.macroProteinSection, { width: `${proteinPct}%` }]}>
                <Text style={[styles.macroSectionPctText, styles.macroSectionPctTextLight]}>
                  {proteinPct}%
                </Text>
              </View>
              <View
                style={[
                  styles.macroSection,
                  styles.macroCarbsSection,
                  { left: `${proteinPct}%`, width: `${carbsPct}%` },
                ]}
              >
                <Text style={[styles.macroSectionPctText, styles.macroSectionPctTextDark]}>
                  {carbsPct}%
                </Text>
              </View>
              <View
                style={[
                  styles.macroSection,
                  styles.macroFatSection,
                  { left: `${proteinPct + carbsPct}%`, width: `${fatPct}%` },
                ]}
              >
                <Text style={[styles.macroSectionPctText, styles.macroSectionPctTextLight]}>
                  {fatPct}%
                </Text>
              </View>

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

        <Text style={styles.sectionTitle}>Friends</Text>
        <View style={styles.card}>
          {socialDisplayName ? (
            <>
              <View style={styles.socialNameRow}>
                <Text style={styles.formRowLabel}>Name</Text>
                <View style={styles.socialNameControls}>
                  <TextInput
                    key={socialDisplayName}
                    defaultValue={socialDisplayName}
                    onChangeText={setSocialNameInput}
                    autoCapitalize="words"
                    autoCorrect={false}
                    accessibilityLabel="Social name"
                    placeholder="Name"
                    placeholderTextColor={palette.tertiaryLabel}
                    maxLength={80}
                    style={styles.socialNameInput}
                  />
                  <SmallButton
                    label={updateSocialProfileMutation.isPending ? "Saving" : "Save"}
                    accessibilityLabel="Save social name"
                    disabled={!socialNameChanged || socialActionPending}
                    showDisabledState
                    onPress={() => {
                      if (!socialNameChanged) {
                        return;
                      }

                      updateSocialProfileMutation.mutate(trimmedSocialName);
                    }}
                  />
                </View>
              </View>
              <View style={styles.divider} />
            </>
          ) : null}
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Your Code</Text>
            <Text selectable style={styles.friendCodeValue}>
              {socialOverview?.profile.friendCode ?? (socialOverviewQuery.isLoading ? "Loading..." : "Unavailable")}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.friendCodeRow}>
            <TextInput
              value={friendCodeInput}
              onChangeText={(next) => setFriendCodeInput(next.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Friend code"
              placeholder="Friend code"
              placeholderTextColor={palette.tertiaryLabel}
              maxLength={12}
              style={styles.friendCodeInput}
            />
            <SmallButton
              label="Add"
              accessibilityLabel="Add friend"
              disabled={!trimmedFriendCode || socialActionPending}
              showDisabledState
              onPress={() => {
                sendFriendRequestMutation.mutate(trimmedFriendCode);
              }}
            />
          </View>

          <SocialSection
            items={socialOverview?.incomingRequests}
            renderItem={(request, index) => (
              <SocialRow key={request.id} name={request.requester.displayName} meta="Request" index={index}>
                <View style={styles.socialActions}>
                  <SmallButton
                    label="Ignore"
                    secondary
                    accessibilityLabel={`Ignore ${request.requester.displayName}`}
                    disabled={socialActionPending}
                    onPress={() => ignoreFriendRequestMutation.mutate(request.id)}
                  />
                  <SmallButton
                    label="Accept"
                    accessibilityLabel={`Accept ${request.requester.displayName}`}
                    disabled={socialActionPending}
                    onPress={() => acceptFriendRequestMutation.mutate(request.id)}
                  />
                </View>
              </SocialRow>
            )}
          />

          <SocialSection
            items={socialOverview?.friends}
            renderItem={(friend, index) => (
              <SocialRow key={friend.userId} name={friend.displayName} meta="Friend" index={index}>
                <SmallButton
                  label="Remove"
                  secondary
                  accessibilityLabel={`Remove ${friend.displayName}`}
                  disabled={socialActionPending}
                  onPress={() => confirmRemoveFriend(friend.userId, friend.displayName)}
                />
              </SocialRow>
            )}
          />

          <SocialSection
            items={socialOverview?.outgoingRequests}
            renderItem={(request, index) => (
              <SocialRow key={request.id} name={request.recipient.displayName} meta="Pending" index={index} />
            )}
          />

          {!socialOverviewQuery.isLoading && socialOverview ? null : (
            <>
              <View style={styles.divider} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh friends"
                onPress={() => {
                  void socialOverviewQuery.refetch();
                }}
                style={styles.updatesButton}
              >
                <Text style={styles.updatesButtonText}>Refresh</Text>
              </Pressable>
            </>
          )}
        </View>
        {socialActionError ? (
          <Text style={styles.sectionErrorText}>
            {errorMessage(socialActionError, "Could not update friends.")}
          </Text>
        ) : null}

        <Text style={styles.sectionTitle}>Updates</Text>
        <View style={styles.card}>
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Status</Text>
            <Text style={styles.accountValue}>{updatesStatusLabel}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Last checked</Text>
            <Text style={styles.accountValue}>{lastCheckedLabel}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.formRow}>
            <Text style={styles.formRowLabel}>Current update</Text>
            <Text style={styles.accountValue}>{currentUpdateCreatedAtLabel}</Text>
          </View>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={updateButtonLabel}
            onPress={() => {
              void handleCheckForUpdates();
            }}
            disabled={!canCheckForUpdates}
            style={[styles.updatesButton, !canCheckForUpdates && styles.updatesButtonDisabled]}
          >
            <Text style={[styles.updatesButtonText, !canCheckForUpdates && styles.updatesButtonTextDisabled]}>
              {updateButtonLabel}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
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
  titleRow: {
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  largeTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: palette.label,
  },
  syncBadge: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  syncBadgeReady: {
    backgroundColor: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
    borderColor: iosColor("separator", "#E5E7EB"),
  },
  syncBadgePending: {
    backgroundColor: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
    borderColor: iosColor("systemOrangeColor", "#F59E0B"),
  },
  syncBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    flexShrink: 0,
  },
  syncBadgeDotReady: {
    backgroundColor: palette.success,
  },
  syncBadgeDotPending: {
    backgroundColor: iosColor("systemOrangeColor", "#F59E0B"),
  },
  syncBadgeLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: palette.secondaryLabel,
  },
  syncBadgeValue: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
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
  friendCodeValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "700",
    color: palette.tint,
    letterSpacing: 1.2,
  },
  socialNameRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  socialNameControls: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
  },
  socialNameInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
    color: palette.label,
    fontSize: 16,
    lineHeight: 20,
  },
  friendCodeRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  friendCodeInput: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
    color: palette.label,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  socialRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 8,
  },
  socialRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.separator,
  },
  socialRowMain: {
    flex: 1,
  },
  socialName: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "600",
    color: palette.label,
  },
  socialMeta: {
    marginTop: 1,
    fontSize: 13,
    lineHeight: 17,
    color: palette.secondaryLabel,
  },
  socialActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  smallButton: {
    minHeight: 34,
    minWidth: 64,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  smallPrimaryButton: {
    backgroundColor: palette.tint,
  },
  smallPrimaryButtonDisabled: {
    backgroundColor: palette.buttonDisabledBackground,
  },
  smallButtonText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "700",
  },
  smallPrimaryButtonText: {
    color: palette.buttonText,
  },
  smallPrimaryButtonTextDisabled: {
    color: palette.buttonDisabledText,
  },
  smallSecondaryButton: {
    backgroundColor: iosColor("tertiarySystemGroupedBackground", "#F3F4F6"),
  },
  smallSecondaryButtonText: {
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
  updatesButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  updatesButtonDisabled: {
    opacity: 0.5,
  },
  updatesButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.tint,
  },
  updatesButtonTextDisabled: {
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
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
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
  macroSectionPctText: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  macroSectionPctTextLight: {
    color: "rgba(255,255,255,0.96)",
  },
  macroSectionPctTextDark: {
    color: "rgba(17,24,39,0.9)",
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
  sectionErrorText: {
    paddingHorizontal: 4,
    marginTop: -4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.error,
  },
});

import { useClerk, useUser } from "@clerk/expo";
import {
  Button,
  Column,
  FieldGroup,
  Host,
  RNHostView,
  Row,
  Spacer,
  Text as ExpoText,
  TextInput as ExpoTextInput,
  useNativeState,
} from "@expo/ui";
import {
  controlSize,
  listRowInsets,
  listSectionMargins,
  listSectionSpacing,
  textFieldStyle,
} from "@expo/ui/swift-ui/modifiers";
import * as Updates from "expo-updates";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Alert,
  PanResponder,
  Platform,
  PlatformColor,
  StyleSheet,
  Text as RNText,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  tertiaryLabel: iosColor("tertiaryLabel", "#9CA3AF"),
  tint: "#2563EB",
  error: iosColor("systemRed", "#DC2626"),
  macroProtein: macroColors.protein.background,
  macroCarbs: macroColors.carbs.background,
  macroFat: macroColors.fat.background,
};

const uiColor = (color: string | ReturnType<typeof PlatformColor>) => color as string;

const uiPalette = {
  label: uiColor(palette.label),
  secondaryLabel: uiColor(palette.secondaryLabel),
  tertiaryLabel: uiColor(palette.tertiaryLabel),
  tint: uiColor(palette.tint),
  error: uiColor(palette.error),
};

const MACRO_DIVISIONS = 10;
const compactFormModifiers = [listSectionSpacing("compact"), listSectionMargins({ length: 16, edges: "horizontal" })];
const compactRowModifiers = [listRowInsets({ top: 4, leading: 14, bottom: 4, trailing: 14 })];
const compactControlModifiers = [controlSize("small")];
const compactInputModifiers = [controlSize("small"), textFieldStyle("plain")];

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

function SectionTitle({ children }: { children: string }) {
  return (
    <ExpoText
      textStyle={{
        fontSize: 13,
        lineHeight: 18,
        fontWeight: "600",
        color: uiPalette.secondaryLabel,
        letterSpacing: 0.5,
      }}
    >
      {children.toUpperCase()}
    </ExpoText>
  );
}

function FormRow({
  label,
  value,
  onChange,
  suffix,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  suffix?: string;
  maxLength: number;
}) {
  const inputValue = useNativeState(value);

  useEffect(() => {
    inputValue.value = value;
  }, [inputValue, value]);

  return (
    <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
      <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>{label}</ExpoText>
      <Spacer flexible />
      <ExpoTextInput
        value={inputValue}
        onChangeText={onChange}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={maxLength}
        modifiers={compactInputModifiers}
        style={{ width: 74, height: 32 }}
        textStyle={{ textAlign: "right", fontSize: 17, fontWeight: "600", color: uiPalette.tint }}
      />
      {suffix ? (
        <ExpoText
          textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.tint, fontWeight: "600" }}
        >
          {suffix}
        </ExpoText>
      ) : null}
    </Row>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

type SmallButtonProps = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  secondary?: boolean;
};

function SmallButton(props: SmallButtonProps) {
  return (
    <Button
      label={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      variant={props.secondary ? "outlined" : "filled"}
      style={{ width: 82, height: 32 }}
      modifiers={compactControlModifiers}
    />
  );
}

function SettingsTextActionRow({
  defaultValue,
  placeholder,
  maxLength,
  autoCapitalize,
  autoCorrect,
  keyboardType,
  normalizeText,
  onChangeText,
  actionLabel,
  actionDisabled,
  onActionPress,
  inputWidth = 150,
}: {
  defaultValue: string;
  placeholder: string;
  maxLength?: number;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  autoCorrect?: boolean;
  keyboardType?: "default" | "numeric";
  normalizeText?: (value: string) => string;
  onChangeText: (value: string) => void;
  actionLabel: string;
  actionDisabled?: boolean;
  onActionPress: () => void;
  inputWidth?: number;
}) {
  const inputValue = useNativeState(defaultValue);

  useEffect(() => {
    inputValue.value = defaultValue;
  }, [defaultValue, inputValue]);

  return (
    <Row alignment="center" spacing={8} modifiers={compactRowModifiers} style={{ height: 44 }}>
      <ExpoTextInput
        value={inputValue}
        onChangeText={(value) => {
          const normalized = (normalizeText?.(value) ?? value).slice(0, maxLength);
          if (normalized !== value) {
            inputValue.value = normalized;
          }
          onChangeText(normalized);
        }}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        inputMode={keyboardType === "numeric" ? "numeric" : "text"}
        keyboardType={keyboardType === "numeric" ? "number-pad" : "default"}
        placeholder={placeholder}
        maxLength={maxLength}
        modifiers={compactInputModifiers}
        style={{ width: inputWidth, height: 32 }}
        textStyle={{ fontSize: 16 }}
      />
      <Button
        label={actionLabel}
        disabled={actionDisabled}
        onPress={onActionPress}
        variant="outlined"
        style={{ width: 74, height: 32 }}
        modifiers={compactControlModifiers}
      />
    </Row>
  );
}

function SocialRow({ name, meta, children }: { name: string; meta: string; children?: ReactNode }) {
  return (
    <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 50 }}>
      <Column spacing={1}>
        <ExpoText
          numberOfLines={1}
          textStyle={{ fontSize: 16, lineHeight: 21, fontWeight: "600", color: uiPalette.label }}
        >
          {name}
        </ExpoText>
        <ExpoText textStyle={{ fontSize: 13, lineHeight: 17, color: uiPalette.secondaryLabel }}>
          {meta}
        </ExpoText>
      </Column>
      <Spacer flexible />
      {children}
    </Row>
  );
}

function SocialSection<T>(props: { items: readonly T[] | undefined; renderItem: (item: T, index: number) => ReactNode }) {
  const { items, renderItem } = props;
  return items?.length ? <>{items.map(renderItem)}</> : null;
}

function MacroRatioEditor({
  proteinGoal,
  carbsGoal,
  fatGoal,
  proteinPct,
  carbsPct,
  fatPct,
  firstDividerLeft,
  secondDividerLeft,
  activeHandle,
  firstHandleResponder,
  secondHandleResponder,
  onTrackLayout,
}: {
  proteinGoal: number;
  carbsGoal: number;
  fatGoal: number;
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
  firstDividerLeft: number;
  secondDividerLeft: number;
  activeHandle: "first" | "second" | null;
  firstHandleResponder: ReturnType<typeof PanResponder.create>;
  secondHandleResponder: ReturnType<typeof PanResponder.create>;
  onTrackLayout: (width: number) => void;
}) {
  return (
    <View style={styles.macroNativeContent}>
      <View style={styles.macroLegendRow}>
        <View style={styles.macroLegendItem}>
          <View style={[styles.macroLegendDot, { backgroundColor: palette.macroProtein }]} />
          <RNText style={styles.macroLegendText}>Protein {proteinGoal}g</RNText>
        </View>
        <View style={styles.macroLegendItem}>
          <View style={[styles.macroLegendDot, { backgroundColor: palette.macroCarbs }]} />
          <RNText style={styles.macroLegendText}>Carbs {carbsGoal}g</RNText>
        </View>
        <View style={styles.macroLegendItem}>
          <View style={[styles.macroLegendDot, { backgroundColor: palette.macroFat }]} />
          <RNText style={styles.macroLegendText}>Fat {fatGoal}g</RNText>
        </View>
      </View>

      <View
        style={styles.macroSliderWrap}
        onLayout={(event) => {
          onTrackLayout(event.nativeEvent.layout.width);
        }}
      >
        <View style={styles.macroSliderTrack}>
          <View style={[styles.macroSection, styles.macroProteinSection, { width: `${proteinPct}%` }]}>
            <RNText style={[styles.macroSectionPctText, styles.macroSectionPctTextLight]}>
              {proteinPct}%
            </RNText>
          </View>
          <View
            style={[
              styles.macroSection,
              styles.macroCarbsSection,
              { left: `${proteinPct}%`, width: `${carbsPct}%` },
            ]}
          >
            <RNText style={[styles.macroSectionPctText, styles.macroSectionPctTextDark]}>
              {carbsPct}%
            </RNText>
          </View>
          <View
            style={[
              styles.macroSection,
              styles.macroFatSection,
              { left: `${proteinPct + carbsPct}%`, width: `${fatPct}%` },
            ]}
          >
            <RNText style={[styles.macroSectionPctText, styles.macroSectionPctTextLight]}>
              {fatPct}%
            </RNText>
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

      <RNText style={styles.macroHelpText}>Drag the two dividers to resize each macro section.</RNText>
    </View>
  );
}

export default function SettingsScreen() {
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
      <Host style={styles.screen}>
        <Column alignment="center" style={{ height: 640 }}>
          <Spacer flexible />
          <ExpoText textStyle={{ fontSize: 16, color: uiPalette.secondaryLabel }}>Loading settings...</ExpoText>
          <Spacer flexible />
        </Column>
      </Host>
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
    <Host style={styles.screen} useViewportSizeMeasurement>
      <FieldGroup modifiers={compactFormModifiers}>
          <FieldGroup.Section>
            <FieldGroup.SectionHeader>
              <Column spacing={12}>
                <Row alignment="center" spacing={12}>
                  <ExpoText textStyle={{ fontSize: 34, lineHeight: 41, fontWeight: "700", color: uiPalette.label }}>
                    Settings
                  </ExpoText>
                  <Spacer flexible />
                  <Row alignment="center" spacing={6}>
                    <ExpoText textStyle={{ fontSize: 12, lineHeight: 16, color: uiPalette.secondaryLabel }}>
                      Last synced
                    </ExpoText>
                    <ExpoText textStyle={{ fontSize: 12, lineHeight: 16, fontWeight: "700", color: uiPalette.label }}>
                      {lastSyncedValue}
                    </ExpoText>
                  </Row>
                </Row>
                <SectionTitle>Goals</SectionTitle>
              </Column>
            </FieldGroup.SectionHeader>
            <FormRow label="Daily Calories" value={goalInput} onChange={setGoalInput} maxLength={5} />
          </FieldGroup.Section>
          {saveError ? (
            <FieldGroup.Section>
              <ExpoText textStyle={{ fontSize: 13, lineHeight: 18, fontWeight: "600", color: uiPalette.error }}>
                {saveError}
              </ExpoText>
            </FieldGroup.Section>
          ) : null}

          <FieldGroup.Section title="Macro Ratios" titleUppercase>
            <Column modifiers={compactRowModifiers} style={{ height: 132 }}>
              <RNHostView>
                <MacroRatioEditor
                  proteinGoal={proteinGoal}
                  carbsGoal={carbsGoal}
                  fatGoal={fatGoal}
                  proteinPct={proteinPct}
                  carbsPct={carbsPct}
                  fatPct={fatPct}
                  firstDividerLeft={firstDividerLeft}
                  secondDividerLeft={secondDividerLeft}
                  activeHandle={activeHandle}
                  firstHandleResponder={firstHandleResponder}
                  secondHandleResponder={secondHandleResponder}
                  onTrackLayout={setMacroTrackWidth}
                />
              </RNHostView>
            </Column>
          </FieldGroup.Section>

          <FieldGroup.Section title="Account" titleUppercase>
            <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
              <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>
                Signed in as
              </ExpoText>
              <Spacer flexible />
              <ExpoText
                numberOfLines={1}
                textStyle={{ textAlign: "right", fontSize: 15, lineHeight: 20, color: uiPalette.secondaryLabel }}
              >
                {profileEmail}
              </ExpoText>
            </Row>
            <Row alignment="center" modifiers={compactRowModifiers} style={{ height: 44 }}>
              <Spacer flexible />
              <Button
                label={isSigningOut ? "Signing Out..." : "Sign Out"}
                onPress={confirmSignOut}
                disabled={isSigningOut}
                variant="text"
                style={{ width: 132, height: 32 }}
                modifiers={compactControlModifiers}
              />
              <Spacer flexible />
            </Row>
          </FieldGroup.Section>
          {signOutError ? (
            <FieldGroup.Section>
              <ExpoText textStyle={{ fontSize: 13, lineHeight: 18, fontWeight: "600", color: uiPalette.error }}>
                {signOutError}
              </ExpoText>
            </FieldGroup.Section>
          ) : null}

          <FieldGroup.Section title="Friends" titleUppercase>
            {socialDisplayName ? (
              <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 50 }}>
                <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>Name</ExpoText>
                <Spacer flexible />
                <SettingsTextActionRow
                  key={socialDisplayName}
                  defaultValue={socialDisplayName}
                  onChangeText={setSocialNameInput}
                  autoCapitalize="words"
                  autoCorrect={false}
                  placeholder="Name"
                  maxLength={80}
                  actionLabel={updateSocialProfileMutation.isPending ? "Saving" : "Save"}
                  actionDisabled={!socialNameChanged || socialActionPending}
                  onActionPress={() => {
                    if (!socialNameChanged) {
                      return;
                    }

                    updateSocialProfileMutation.mutate(trimmedSocialName);
                  }}
                />
              </Row>
            ) : null}
            <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
              <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>Your Code</ExpoText>
              <Spacer flexible />
              <ExpoText
                textStyle={{ textAlign: "right", fontSize: 17, lineHeight: 22, fontWeight: "700", color: uiPalette.tint, letterSpacing: 1.2 }}
              >
                {socialOverview?.profile.friendCode ?? (socialOverviewQuery.isLoading ? "Loading..." : "Unavailable")}
              </ExpoText>
            </Row>
            <Row alignment="center" modifiers={compactRowModifiers} style={{ height: 50 }}>
              <Spacer flexible />
              <SettingsTextActionRow
                defaultValue={friendCodeInput}
                onChangeText={setFriendCodeInput}
                normalizeText={(next) => next.toUpperCase()}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="Friend code"
                maxLength={12}
                actionLabel="Add"
                actionDisabled={!trimmedFriendCode || socialActionPending}
                inputWidth={160}
                onActionPress={() => {
                  sendFriendRequestMutation.mutate(trimmedFriendCode);
                }}
              />
              <Spacer flexible />
            </Row>

            <SocialSection
              items={socialOverview?.incomingRequests}
              renderItem={(request) => (
                <SocialRow key={request.id} name={request.requester.displayName} meta="Request">
                  <Row alignment="center" spacing={8}>
                    <SmallButton
                      label="Ignore"
                      secondary
                      disabled={socialActionPending}
                      onPress={() => ignoreFriendRequestMutation.mutate(request.id)}
                    />
                    <SmallButton
                      label="Accept"
                      disabled={socialActionPending}
                      onPress={() => acceptFriendRequestMutation.mutate(request.id)}
                    />
                  </Row>
                </SocialRow>
              )}
            />

            <SocialSection
              items={socialOverview?.friends}
              renderItem={(friend) => (
                <SocialRow key={friend.userId} name={friend.displayName} meta="Friend">
                  <SmallButton
                    label="Remove"
                    secondary
                    disabled={socialActionPending}
                    onPress={() => confirmRemoveFriend(friend.userId, friend.displayName)}
                  />
                </SocialRow>
              )}
            />

            <SocialSection
              items={socialOverview?.outgoingRequests}
              renderItem={(request) => (
                <SocialRow key={request.id} name={request.recipient.displayName} meta="Pending" />
              )}
            />

            {!socialOverviewQuery.isLoading && socialOverview ? null : (
              <Row alignment="center" modifiers={compactRowModifiers} style={{ height: 44 }}>
                <Spacer flexible />
                <Button
                  label="Refresh"
                  onPress={() => {
                    void socialOverviewQuery.refetch();
                  }}
                  variant="text"
                  style={{ width: 132, height: 32 }}
                  modifiers={compactControlModifiers}
                />
                <Spacer flexible />
              </Row>
            )}
          </FieldGroup.Section>
          {socialActionError ? (
            <FieldGroup.Section>
              <ExpoText textStyle={{ fontSize: 13, lineHeight: 18, fontWeight: "600", color: uiPalette.error }}>
                {errorMessage(socialActionError, "Could not update friends.")}
              </ExpoText>
            </FieldGroup.Section>
          ) : null}

          <FieldGroup.Section title="Updates" titleUppercase>
            <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
              <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>Status</ExpoText>
              <Spacer flexible />
              <ExpoText textStyle={{ textAlign: "right", fontSize: 15, lineHeight: 20, color: uiPalette.secondaryLabel }}>
                {updatesStatusLabel}
              </ExpoText>
            </Row>
            <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
              <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>Last checked</ExpoText>
              <Spacer flexible />
              <ExpoText textStyle={{ textAlign: "right", fontSize: 15, lineHeight: 20, color: uiPalette.secondaryLabel }}>
                {lastCheckedLabel}
              </ExpoText>
            </Row>
            <Row alignment="center" spacing={10} modifiers={compactRowModifiers} style={{ height: 44 }}>
              <ExpoText textStyle={{ fontSize: 17, lineHeight: 22, color: uiPalette.label }}>Current update</ExpoText>
              <Spacer flexible />
              <ExpoText textStyle={{ textAlign: "right", fontSize: 15, lineHeight: 20, color: uiPalette.secondaryLabel }}>
                {currentUpdateCreatedAtLabel}
              </ExpoText>
            </Row>
            <Row alignment="center" modifiers={compactRowModifiers} style={{ height: 44 }}>
              <Spacer flexible />
              <Button
                label={updateButtonLabel}
                onPress={() => {
                  void handleCheckForUpdates();
                }}
                disabled={!canCheckForUpdates}
                variant="text"
                style={{ width: 150, height: 32 }}
                modifiers={compactControlModifiers}
              />
              <Spacer flexible />
            </Row>
          </FieldGroup.Section>
      </FieldGroup>
    </Host>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  macroNativeContent: {
    flex: 1,
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
    color: uiPalette.secondaryLabel,
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
    ...StyleSheet.absoluteFill,
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
    borderColor: uiPalette.tint,
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
    color: uiPalette.tertiaryLabel,
  },
});

import { fetch as expoFetch } from "expo/fetch";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Sentry from "@sentry/react-native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File as ExpoFile } from "expo-file-system";
import {
  AppState,
  type ColorValue,
  type GestureResponderEvent,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
  type NativeSyntheticEvent,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  LinearTransition,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StreamdownRN } from "streamdown-rn";
import { MacroBadges } from "../../src/components/MacroBadges";
import { localDateKeyFromTimestamp } from "../../src/date";
import { useAllFoodEntries, useDataStoreActions, useDataStoreReady } from "../../src/data/DataProvider";
import { type SearchFood as SharedSearchFood } from "../../src/food-search";
import { createAiMessageId } from "../../src/id";
import { mealLabelFor, normalizeMeal } from "../../src/meals";
import { formatPortionLabel } from "../../src/portion";
import { type AppTheme, useThemedStyles } from "../../src/theme/useAppTheme";

const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

type Meal = "breakfast" | "lunch" | "dinner" | "snacks";

type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

type ChatStatus = "ready" | "streaming";

type SearchResultFood = SharedSearchFood & {
  resultId: string;
};

type ResolvedApprovalSuggestion = {
  suggestionId: string;
  resultId: string;
  meal: Meal;
  portion: number;
  reason: string;
  food: SearchResultFood;
  output?: ApprovalOutput;
};

type TextUIMessage = {
  id: string;
  kind: "text";
  role: "user" | "assistant";
  text: string;
};

type AudioUIMessage = {
  id: string;
  kind: "audio";
  role: "user";
  label: string;
  durationLabel: string;
};

type SearchUIMessage = {
  id: string;
  kind: "search";
  query?: string;
  foods: SearchResultFood[];
};

type ApprovalUIMessage = {
  id: string;
  kind: "approval";
  toolCallId: string;
  suggestions: ResolvedApprovalSuggestion[];
};

type UIMessage = TextUIMessage | AudioUIMessage | SearchUIMessage | ApprovalUIMessage;

type AgentEvent =
  | {
      kind: "assistant";
      text: string;
    }
  | {
      kind: "assistant-delta";
      text: string;
    }
  | {
      kind: "search";
      query?: string;
      foods: SearchResultFood[];
    }
  | {
      kind: "approval";
      toolCallId: string;
      suggestions: ResolvedApprovalSuggestion[];
    };

type AgentAction =
  | {
      type: "user-message";
      message?: string;
    };

type AudioUpload = {
  uri: string;
  mimeType: string;
  fileName: string;
};

type TurnStreamOutcome = {
  // "ready"/"error" mean the server finished the turn; null means the stream ended
  // without a terminal message (e.g. the request was cancelled / app backgrounded)
  // and the turn is still running server-side, ready to be resumed.
  terminal: ChatStatus | "error" | null;
  errorMessage?: string;
};

type ActiveTurn = {
  turnId: string;
  // Highest durable event sequence number applied so far; the resume cursor.
  appliedSeq: number;
  // Whether the server-resolved user message (e.g. an audio transcription) should
  // be rendered. False for typed messages, which are shown optimistically already.
  appendResolvedUserMessage: boolean;
};

type RecentLogHintPayload = {
  foodName: string;
  meal?: string;
  brand?: string;
  serving?: string;
  createdAt?: number;
  dateKey?: string;
};

type MaybeLoadedLogEntry = {
  $isLoaded?: boolean;
  foodName?: string;
  meal?: string;
  brand?: string;
  serving?: string;
  createdAt?: number;
  dateKey?: string;
};

type StreamingPayload = {
  type?: unknown;
  status?: unknown;
  event?: unknown;
  resolvedUserMessage?: unknown;
  error?: unknown;
  message?: unknown;
  turnId?: unknown;
  seq?: unknown;
};

const recentLogWindowMs = 3 * 24 * 60 * 60 * 1000;
const maxRecentLogHints = 80;
// How long to wait before re-attaching to a turn whose stream was interrupted,
// and after a failed resume attempt, plus how many consecutive failures to
// tolerate before giving up on the turn.
const interruptResumeDelayMs = 800;
const resumeRetryDelayMs = 2000;
const maxResumeRetries = 5;
const recordingLockDistance = 54;
const recordingCancelDistance = 82;
const recordingWaveHeights = [10, 18, 12, 24, 15, 28, 12, 22, 16, 26, 13, 19, 11, 21];
const audioBubbleWaveHeights = [8, 14, 10, 18, 12, 20, 9, 16, 11, 15];

const createMessageId = () => createAiMessageId();
const composerLayoutTransition = LinearTransition.springify()
  .mass(0.85)
  .damping(22)
  .stiffness(260);
const composerEnterTransition = FadeIn.duration(130);
const composerExitTransition = FadeOut.duration(90);
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
const searchLayoutTransition = LinearTransition.springify()
  .mass(0.8)
  .damping(24)
  .stiffness(280);

function formatRecordingDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function cloneNutrition(nutrition: SearchResultFood["nutrition"]) {
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

function formatCalories(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }

  return Math.round(value).toLocaleString();
}

function inferSearchQueryFromFoods(foods: SearchResultFood[]): string {
  const ignoredTokens = new Set([
    "and",
    "con",
    "de",
    "del",
    "deshidratada",
    "food",
    "foods",
    "fresh",
    "la",
    "las",
    "los",
    "the",
    "with",
  ]);
  const counts = new Map<string, number>();

  for (const food of foods.slice(0, 6)) {
    const seenInFood = new Set<string>();
    const rawText = `${food.name} ${food.brand ?? ""}`.toLowerCase();
    const tokens = rawText.match(/[\p{L}\p{N}]{3,}/gu) ?? [];

    for (const token of tokens) {
      if (ignoredTokens.has(token) || seenInFood.has(token)) {
        continue;
      }

      seenInFood.add(token);
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const [topToken, topCount] =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];

  if (topToken && topCount >= 2) {
    return topToken;
  }

  return foods[0]?.name.trim() || "search results";
}

function isErrorLike(value: unknown): value is { message?: unknown; stack?: unknown; name?: unknown } {
  return Boolean(value && typeof value === "object");
}

function getErrorMessage(error: unknown): string {
  if (
    isErrorLike(error) &&
    typeof error.name === "string" &&
    error.name === "UIError" &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message.trim();
  }

  return "Unknown error.";
}

class UIError extends Error {
  details?: string;

  constructor(message: string, details?: string) {
    super(message);
    this.name = "UIError";
    this.details = details?.trim() || undefined;
  }
}

function getErrorDetails(error: unknown): string | null {
  if (isErrorLike(error) && typeof error.name === "string" && error.name === "UIError") {
    const details = (error as UIError).details;
    if (typeof details === "string" && details.trim()) {
      return details.trim();
    }
  }

  return null;
}

function isStreamingPayload(value: unknown): value is StreamingPayload {
  return Boolean(value && typeof value === "object");
}

function normalizeStreamingPayloadEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as AgentEvent;
}

function parseSseEventsFromChunk(chunk: string): StreamingPayload[] {
  const normalized = chunk.replace(/\r\n/g, "\n");
  const segments = normalized.split("\n\n");
  const payloads: StreamingPayload[] = [];

  for (const segment of segments) {
    const dataLines = segment
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (isStreamingPayload(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      // Ignore malformed SSE chunks.
    }
  }

  return payloads;
}

function buildErrorDetails(options: {
  method: string;
  url: string;
  status?: number;
  payload?: unknown;
  underlyingError?: unknown;
}): string {
  const lines = [`${options.method} ${options.url}`];

  if (typeof options.status === "number") {
    lines.push(`status: ${options.status}`);
  }

  if (options.payload !== undefined) {
    if (typeof options.payload === "string") {
      lines.push(`payload: ${options.payload}`);
    } else {
      try {
        lines.push(`payload: ${JSON.stringify(options.payload)}`);
      } catch {
        lines.push("payload: [unserializable]");
      }
    }
  }

  if (isErrorLike(options.underlyingError) && typeof options.underlyingError.message === "string") {
    const cause = options.underlyingError.message.trim();
    if (cause) {
      lines.push(`cause: ${cause}`);
    }
  }

  return lines.join("\n");
}

function inferAudioMeta(uri: string): Pick<AudioUpload, "mimeType" | "fileName"> {
  const extension = uri.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase();

  const mimeType =
    extension === "m4a"
      ? "audio/m4a"
      : extension === "caf"
        ? "audio/x-caf"
        : extension === "wav"
          ? "audio/wav"
          : extension === "mp3"
            ? "audio/mpeg"
            : "audio/m4a";

  const fileExtension = extension && extension.length > 0 ? extension : "m4a";

  return {
    mimeType,
    fileName: `voice-${Date.now()}.${fileExtension}`,
  };
}

function createAudioUploadPart(audio: AudioUpload): Blob {
  const file = new ExpoFile(audio.uri);
  return {
    name: audio.fileName,
    type: audio.mimeType,
    bytes: () => file.bytes(),
  } as unknown as Blob;
}

function buildRecentLogHints(logs: unknown, now = Date.now()): RecentLogHintPayload[] {
  if (!logs || typeof (logs as { forEach?: unknown }).forEach !== "function") {
    return [];
  }

  const cutoff = now - recentLogWindowMs;
  const output: RecentLogHintPayload[] = [];
  const rows = logs as { forEach: (callback: (entry: MaybeLoadedLogEntry) => void) => void };

  rows.forEach((entry) => {
    if (output.length >= maxRecentLogHints) {
      return;
    }

    if (!entry || entry.$isLoaded === false) {
      return;
    }

    const foodName = typeof entry.foodName === "string" ? entry.foodName.trim() : "";
    if (!foodName) {
      return;
    }

    const createdAt = Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : undefined;
    if (createdAt !== undefined && createdAt < cutoff) {
      return;
    }

    output.push({
      foodName,
      meal: typeof entry.meal === "string" ? entry.meal.trim() : undefined,
      brand: typeof entry.brand === "string" ? entry.brand.trim() : undefined,
      serving: typeof entry.serving === "string" ? entry.serving.trim() : undefined,
      createdAt,
      dateKey: typeof entry.dateKey === "string" ? entry.dateKey.trim() : undefined,
    });
  });

  output.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return output;
}

function TypingDot({ delay, color }: { delay: number; color: ColorValue }) {
  const opacity = useSharedValue(0.3);
  const scale = useSharedValue(0.8);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 400, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );
    scale.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.8, { duration: 400, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );
  }, [delay, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

function TypingIndicator({ color }: { color: ColorValue }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4 }}>
      <TypingDot delay={0} color={color} />
      <TypingDot delay={160} color={color} />
      <TypingDot delay={320} color={color} />
    </View>
  );
}

function RecordingWaveBar({ delay, height, color }: { delay: number; height: number; color: ColorValue }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 420, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );

    return () => {
      cancelAnimation(progress);
    };
  }, [delay, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.42 + progress.value * 0.42,
    transform: [{ scaleY: 0.72 + progress.value * 0.46 }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: 3,
          height,
          borderRadius: 2,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

function RecordingWaveform({ color }: { color: ColorValue }) {
  return (
    <View
      style={{
        height: 30,
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
      }}
    >
      {recordingWaveHeights.map((height, index) => (
        <RecordingWaveBar
          key={`${height}-${index}`}
          delay={index * 55}
          height={height}
          color={color}
        />
      ))}
    </View>
  );
}

function AudioBubbleWaveform({ color }: { color: ColorValue }) {
  return (
    <View style={{ height: 22, flexDirection: "row", alignItems: "center", gap: 3 }}>
      {audioBubbleWaveHeights.map((height, index) => (
        <View
          key={`${height}-${index}`}
          style={{
            width: 3,
            height,
            borderRadius: 2,
            backgroundColor: color,
            opacity: index % 3 === 0 ? 0.54 : 0.82,
          }}
        />
      ))}
    </View>
  );
}

function RecordingCardView({
  children,
  style,
  progress,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  progress: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.88 + progress.value * 0.12,
    transform: [{ translateY: (1 - progress.value) * 8 }],
  }));

  return (
    <Animated.View
      entering={composerEnterTransition}
      exiting={composerExitTransition}
      layout={composerLayoutTransition}
      style={[style, animatedStyle]}
    >
      {children}
    </Animated.View>
  );
}

function RecordingLockTarget({
  progress,
  locked,
  palette,
  styles,
}: {
  progress: SharedValue<number>;
  locked: boolean;
  palette: AppTheme["palette"];
  styles: ReturnType<typeof createStyles>;
}) {
  const targetStyle = useAnimatedStyle(() => ({
    opacity: 0.72 + progress.value * 0.28,
    transform: [
      { translateY: (1 - progress.value) * 10 },
      { scale: 0.94 + progress.value * 0.06 },
    ],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    height: 42 * Math.max(0.06, progress.value),
  }));

  const hintStyle = useAnimatedStyle(() => ({
    opacity: progress.value < 0.18 ? 0.8 : 1,
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.recordingLockTarget, targetStyle]}>
      <View style={[styles.recordingLockBubble, locked && styles.recordingLockBubbleActive]}>
        <Ionicons
          name={locked ? "lock-closed" : "lock-open"}
          size={18}
          color={locked ? palette.buttonText : palette.error}
        />
      </View>
      <View style={styles.recordingLockRail}>
        <Animated.View style={[styles.recordingLockRailFill, fillStyle]} />
      </View>
      <Ionicons name="chevron-up" size={16} color={palette.error} />
      <Animated.Text style={[styles.recordingLockHint, hintStyle]}>
        {locked ? "Locked" : "Slide up"}
      </Animated.Text>
    </Animated.View>
  );
}

function RecordingCancelHint({
  progress,
  palette,
  styles,
}: {
  progress: SharedValue<number>;
  palette: AppTheme["palette"];
  styles: ReturnType<typeof createStyles>;
}) {
  const hintStyle = useAnimatedStyle(() => ({
    opacity: 0.68 + progress.value * 0.32,
    transform: [{ translateX: -progress.value * 10 }],
  }));

  return (
    <Animated.View style={[styles.recordingCancelHint, hintStyle]}>
      <Ionicons name="chevron-back" size={13} color={palette.error} />
      <Text style={styles.recordingCancelHintText}>Slide left to cancel</Text>
    </Animated.View>
  );
}

function SearchResultsDisclosure({
  expanded,
  foods,
  styles,
}: {
  expanded: boolean;
  foods: SearchResultFood[];
  styles: ReturnType<typeof createStyles>;
}) {
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [expanded, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: (contentHeight + 10) * progress.value,
    opacity: progress.value,
  }));

  return (
    <Animated.View pointerEvents={expanded ? "auto" : "none"} style={[styles.searchResultsClip, animatedStyle]}>
      <View
        style={styles.searchResults}
        onLayout={(event) => {
          setContentHeight(event.nativeEvent.layout.height);
        }}
      >
        {foods.slice(0, 6).map((food) => (
          <View key={food.resultId} style={styles.searchResultRow}>
            <Text style={styles.searchResultName}>
              {food.name}
              {food.brand ? ` • ${food.brand}` : ""}
            </Text>
            <View style={styles.searchResultMetaRow}>
              <Text style={styles.sourceBadge}>{food.sourceLabel}</Text>
              <Text style={styles.searchResultMeta}>{food.resultId}</Text>
              {food.nutrition?.calories !== undefined ? (
                <Text style={styles.searchResultMeta}>{formatCalories(food.nutrition.calories)} kcal</Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

export default function AILogScreen() {
  const { palette, markdownTheme, isDark, styles } = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { userId, getToken } = useAuth();
  const isDataReady = useDataStoreReady();
  const { createFoodEntry } = useDataStoreActions();
  const { data: recentEntries, isLoading: isLoadingEntries } = useAllFoodEntries();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [expandedSearchIds, setExpandedSearchIds] = useState<Set<string>>(new Set());
  const scrollViewRef = useRef<ScrollView | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingLocked, setIsRecordingLocked] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const isStreaming = status === "streaming";
  const sessionIdRef = useRef<string | null>(null);
  const pendingApprovalsRef = useRef(new Map<string, ResolvedApprovalSuggestion[]>());
  const loopRunningRef = useRef(false);
  // The turn currently running server-side, kept while it streams and across any
  // interruption (e.g. backgrounding) so it can be resumed.
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const resumingRef = useRef(false);
  // True while a stream reader is actively being consumed, so we never run two
  // overlapping consumers for the same turn.
  const streamConsumerActiveRef = useRef(false);
  // Id of the assistant bubble currently being streamed (built from deltas, or the
  // buffered partial replayed on resume) but not yet committed. Lets us update that
  // exact bubble instead of "the last assistant message", so a committed message is
  // never overwritten by a later one when no event separates them.
  const openAssistantIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Consecutive failed resume attempts; once this exceeds the cap we give up and
  // finish the turn instead of retrying forever (which would wedge the chat).
  const resumeRetriesRef = useRef(0);
  // Pending scheduled resume, tracked so it can be cancelled on unmount.
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingLockedRef = useRef(false);
  const recordingCancelledRef = useRef(false);
  const voicePressingRef = useRef(false);
  const voicePressStartXRef = useRef<number | null>(null);
  const voicePressStartYRef = useRef<number | null>(null);
  const recordingUiProgress = useSharedValue(0);
  const recordingDragProgress = useSharedValue(0);
  const recordingCancelProgress = useSharedValue(0);
  const inputHeight = useSharedValue(36);

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, status]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, () => {
      setIsKeyboardVisible(true);
    });

    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!isRecording) {
      recordingUiProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.cubic) });
      recordingDragProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.cubic) });
      recordingCancelProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.cubic) });
      setRecordingSeconds(0);
      recordingStartedAtRef.current = null;
      return;
    }

    recordingUiProgress.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });

    if (!recordingStartedAtRef.current) {
      recordingStartedAtRef.current = Date.now();
    }

    const updateRecordingSeconds = () => {
      const startedAt = recordingStartedAtRef.current ?? Date.now();
      setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };

    updateRecordingSeconds();
    const interval = setInterval(updateRecordingSeconds, 250);

    return () => {
      clearInterval(interval);
    };
  }, [isRecording, recordingCancelProgress, recordingDragProgress, recordingUiProgress]);

  const voiceButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -recordingDragProgress.value * 8 },
      { scale: 1 + recordingUiProgress.value * 0.05 + recordingDragProgress.value * 0.05 },
    ],
  }));

  const inputHeightAnimatedStyle = useAnimatedStyle(() => ({
    height: inputHeight.value,
  }));

  const handleInputContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const nextHeight = Math.min(140, Math.max(36, Math.ceil(event.nativeEvent.contentSize.height)));
    inputHeight.value = withTiming(nextHeight, {
      duration: 130,
      easing: Easing.out(Easing.cubic),
    });
  };

  const toggleSearchExpanded = (messageId: string) => {
    setExpandedSearchIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const appendApprovedFoodToLog = (suggestion: ResolvedApprovalSuggestion) => {
    const meal = normalizeMeal(suggestion.meal) ?? "lunch";
    const createdAt = Date.now();

    void createFoodEntry({
      meal,
      foodName: suggestion.food.name,
      brand: suggestion.food.brand,
      serving: suggestion.food.serving,
      portion: suggestion.portion,
      nutrition: cloneNutrition(suggestion.food.nutrition),
      createdAt,
      dateKey: localDateKeyFromTimestamp(createdAt),
    });
  };

  const clearError = () => {
    setError(null);
    setErrorDetails(null);
  };

  const showError = (nextError: unknown) => {
    Sentry.captureException(nextError);
    setError(getErrorMessage(nextError));
    setErrorDetails(getErrorDetails(nextError));
  };

  const ensureSessionId = async (): Promise<string> => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    const token = await getToken();
    if (!token) {
      throw new UIError("Missing authentication token. Sign in again and retry.");
    }

    const sessionUrl = `${BACKEND_BASE_URL}/ai/session`;
    let response: Response;
    try {
      response = await fetch(sessionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recentLogs: buildRecentLogHints(recentEntries),
        }),
      });
    } catch (networkError) {
      console.error("AI session request failed", {
        url: sessionUrl,
        error: networkError,
      });
      throw new UIError(
        "Could not reach backend to start AI session.",
        buildErrorDetails({
          method: "POST",
          url: sessionUrl,
          underlyingError: networkError,
        }),
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | {
          sessionId?: unknown;
          error?: unknown;
        }
      | null;

    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : "Unknown error.";
      throw new UIError(
        message,
        buildErrorDetails({
          method: "POST",
          url: sessionUrl,
          status: response.status,
          payload,
        }),
      );
    }

    const sessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : "";

    if (!sessionId) {
      throw new UIError(
        "Backend did not return a valid AI session id.",
        buildErrorDetails({
          method: "POST",
          url: sessionUrl,
          status: response.status,
          payload,
        }),
      );
    }

    sessionIdRef.current = sessionId;
    return sessionId;
  };

  // Starts a turn on the server and returns the streaming response. The turn keeps
  // running server-side even if we stop reading this response.
  const startTurnRequest = async (
    action: AgentAction,
    options: { audio?: AudioUpload; signal?: AbortSignal },
    retry = true,
  ): Promise<Response> => {
    const sessionId = await ensureSessionId();
    const token = await getToken();
    if (!token) {
      throw new UIError("Missing authentication token. Sign in again and retry.");
    }

    const usingAudio = Boolean(options.audio && action.type === "user-message");
    const userMessage = action.type === "user-message" ? action.message?.trim() : undefined;

    const body = usingAudio
      ? await (async () => {
          const formData = new FormData();
          formData.append("sessionId", sessionId);
          formData.append("actionType", action.type);
          if (userMessage) {
            formData.append("message", userMessage);
          }

          const audio = options.audio;
          if (audio) {
            formData.append("audio", createAudioUploadPart(audio));
          }

          return formData;
        })()
      : JSON.stringify({
          sessionId,
          action,
        });

    const turnUrl = `${BACKEND_BASE_URL}/ai/turn`;
    let response: Response;
    try {
      response = await expoFetch(turnUrl, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          ...(usingAudio
            ? {}
            : {
                "Content-Type": "application/json",
              }),
        },
        body,
        signal: options.signal,
      });
    } catch (networkError) {
      console.error("AI turn request failed", {
        url: turnUrl,
        usingAudio,
        actionType: action.type,
        error: networkError,
      });
      throw new UIError(
        "Could not reach backend AI endpoint.",
        buildErrorDetails({
          method: "POST",
          url: turnUrl,
          underlyingError: networkError,
        }),
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: unknown;
            message?: unknown;
          }
        | null;

      if (response.status === 403 && retry) {
        sessionIdRef.current = null;
        return startTurnRequest(action, options, false);
      }

      const backendMessage =
        typeof payload?.message === "string"
          ? payload.message
          : typeof payload?.error === "string"
            ? payload.error
            : "Unknown error.";
      throw new UIError(
        backendMessage,
        buildErrorDetails({
          method: "POST",
          url: turnUrl,
          status: response.status,
          payload,
        }),
      );
    }

    return response;
  };

  // Reads an SSE turn stream (from the initial POST or a resume GET), applying
  // events live. Resolves with how the stream ended: a terminal status means the
  // server finished the turn; null means the stream was cut before completion.
  const consumeTurnStream = async (
    response: Response,
    handlers: {
      onTurnId?: (turnId: string) => void;
      onSeq?: (seq: number) => void;
      onResolvedUserMessage?: (message: string) => void;
      // `committed` is true for durable events (they carry a seq); false for the
      // seqless partial assistant snapshot replayed on resume.
      onEvent?: (event: AgentEvent, committed: boolean) => void;
    },
  ): Promise<TurnStreamOutcome> => {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new UIError("Backend AI response was not streamable.");
    }

    let terminal: TurnStreamOutcome["terminal"] = null;
    let errorMessage: string | undefined;

    const handlePayload = (payload: StreamingPayload) => {
      if (payload.type === "turn") {
        if (typeof payload.turnId === "string" && payload.turnId) {
          handlers.onTurnId?.(payload.turnId);
        }
        return;
      }

      if (payload.type === "status") {
        if (payload.status === "ready") {
          terminal = "ready";
        }
        return;
      }

      if (payload.type === "error") {
        terminal = "error";
        errorMessage =
          typeof payload.message === "string"
            ? payload.message
            : typeof payload.error === "string"
              ? payload.error
              : "Unknown error.";
        return;
      }

      if (payload.type === "resolved-user-message") {
        // Apply the seq before surfacing the message so the resume cursor only
        // advances past it once it has actually been handled.
        if (typeof payload.seq === "number") {
          handlers.onSeq?.(payload.seq);
        }
        if (typeof payload.resolvedUserMessage === "string") {
          handlers.onResolvedUserMessage?.(payload.resolvedUserMessage);
        }
        return;
      }

      if (payload.type === "event") {
        const committed = typeof payload.seq === "number";
        if (committed && typeof payload.seq === "number") {
          handlers.onSeq?.(payload.seq);
        }
        const event = normalizeStreamingPayloadEvent(payload.event);
        if (event) {
          handlers.onEvent?.(event, committed);
        }
      }
    };

    const decoder = new TextDecoder();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const chunks = pending.split("\n\n");
      pending = chunks.pop() ?? "";

      for (const chunk of chunks) {
        for (const payload of parseSseEventsFromChunk(`${chunk}\n\n`)) {
          handlePayload(payload);
        }
      }
    }

    const flushed = decoder.decode();
    if (pending.trim() || flushed) {
      for (const payload of parseSseEventsFromChunk(`${pending}${flushed}`)) {
        handlePayload(payload);
      }
    }

    return { terminal, errorMessage };
  };

  // Updates the assistant bubble with `id` (appending or replacing its text), or
  // pushes it if it is not present yet.
  const upsertAssistantText = (
    current: UIMessage[],
    id: string,
    text: string,
    mode: "append" | "set",
  ): UIMessage[] => {
    let found = false;
    const next = current.map((message) => {
      if (message.id === id && message.kind === "text" && message.role === "assistant") {
        found = true;
        return { ...message, text: mode === "append" ? message.text + text : text };
      }
      return message;
    });

    if (!found) {
      next.push({ id, kind: "text", role: "assistant", text });
    }

    return next;
  };

  // Applies a single streamed agent event. `committed` is true for durable events
  // (which carry a seq); the seqless partial assistant snapshot replayed on resume
  // is not committed, so it keeps the streaming bubble open for the real commit.
  const applyAgentEvent = (event: AgentEvent, committed: boolean) => {
    if (event.kind === "assistant-delta") {
      if (!event.text) {
        return;
      }

      const openId = openAssistantIdRef.current;
      if (openId) {
        setMessages((current) => upsertAssistantText(current, openId, event.text, "append"));
      } else {
        const id = createMessageId();
        openAssistantIdRef.current = id;
        setMessages((current) => upsertAssistantText(current, id, event.text, "append"));
      }
      return;
    }

    if (event.kind === "assistant") {
      const text = event.text;
      if (!text.trim()) {
        // A committed (but empty) message still ends the streaming bubble.
        if (committed) {
          openAssistantIdRef.current = null;
        }
        return;
      }

      const openId = openAssistantIdRef.current;
      const id = openId ?? createMessageId();
      // A committed snapshot is final and closes the bubble; a partial snapshot
      // (replayed buffer) stays open so the eventual commit updates it in place.
      openAssistantIdRef.current = committed ? null : id;
      setMessages((current) => upsertAssistantText(current, id, text, "set"));
      return;
    }

    if (event.kind === "search") {
      if (event.foods.length === 0) {
        return;
      }

      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "search",
          query: event.query,
          foods: event.foods,
        },
      ]);
      return;
    }

    pendingApprovalsRef.current.set(event.toolCallId, event.suggestions);
    setMessages((current) => [
      ...current,
      {
        id: createMessageId(),
        kind: "approval",
        toolCallId: event.toolCallId,
        suggestions: event.suggestions,
      },
    ]);
  };

  // The turn reached a terminal state (completed or hard error): release the lock
  // and let the user start a new turn.
  const finishTurn = (errorMessage?: string) => {
    activeTurnRef.current = null;
    loopRunningRef.current = false;
    streamConsumerActiveRef.current = false;
    abortControllerRef.current = null;
    resumeRetriesRef.current = 0;
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    setStatus("ready");
    if (errorMessage) {
      showError(new UIError(errorMessage));
    }
  };

  // Schedules a single resume attempt, replacing any already-pending one. Tracked in
  // a ref so it can be cancelled when the screen unmounts.
  const scheduleResume = (delayMs: number) => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      void resumeActiveTurn();
    }, delayMs);
  };

  // The stream was cut but the turn is still running server-side. Keep the lock and
  // the "streaming" status, then try to re-attach (immediately if we're still in the
  // foreground; otherwise the AppState listener will resume us on the next foreground).
  const handleInterruptedTurn = () => {
    abortControllerRef.current = null;
    if (AppState.currentState === "active") {
      scheduleResume(interruptResumeDelayMs);
    }
  };

  // Drives a single SSE response to completion, routing events into the UI and
  // tracking the resume cursor. Decides whether the turn finished or was interrupted.
  const driveTurnStream = async (response: Response, appendResolvedUserMessage: boolean) => {
    streamConsumerActiveRef.current = true;

    let outcome: TurnStreamOutcome;
    try {
      outcome = await consumeTurnStream(response, {
        onTurnId: (turnId) => {
          const previous = activeTurnRef.current;
          activeTurnRef.current = {
            turnId,
            appliedSeq: previous?.turnId === turnId ? previous.appliedSeq : -1,
            appendResolvedUserMessage,
          };
        },
        onSeq: (seq) => {
          const active = activeTurnRef.current;
          if (active && seq > active.appliedSeq) {
            active.appliedSeq = seq;
          }
        },
        // Append the resolved user message (e.g. an audio transcription) the moment
        // it arrives rather than at stream end, so it survives an interruption. The
        // resume cursor only advances past it once handled, so it is never lost nor
        // duplicated. Typed messages pass appendResolvedUserMessage=false because
        // they were already shown optimistically.
        onResolvedUserMessage: appendResolvedUserMessage
          ? (message) => {
              const trimmed = message.trim();
              if (!trimmed) {
                return;
              }
              setMessages((current) => [
                ...current,
                {
                  id: createMessageId(),
                  kind: "text",
                  role: "user",
                  text: trimmed,
                },
              ]);
            }
          : undefined,
        onEvent: (event, committed) => {
          applyAgentEvent(event, committed);
        },
      });
    } catch (streamError) {
      streamConsumerActiveRef.current = false;
      // If the turn already started, a read failure just means the connection
      // dropped; keep it resumable. Otherwise there's nothing to resume.
      if (activeTurnRef.current) {
        resumeRetriesRef.current += 1;
        if (resumeRetriesRef.current > maxResumeRetries) {
          finishTurn("AI turn could not be resumed.");
          return;
        }
        handleInterruptedTurn();
        return;
      }
      throw streamError;
    }

    streamConsumerActiveRef.current = false;

    if (outcome.terminal === "error") {
      finishTurn(outcome.errorMessage ?? "Unknown error.");
      return;
    }

    if (outcome.terminal) {
      finishTurn();
      return;
    }

    handleInterruptedTurn();
  };

  // Re-attaches to a turn that is still running server-side after an interruption,
  // replaying anything missed since `appliedSeq`.
  const resumeActiveTurn = async () => {
    const active = activeTurnRef.current;
    if (!active || resumingRef.current) {
      return;
    }

    if (streamConsumerActiveRef.current) {
      // A previous consumer is still settling (e.g. a frozen read after returning
      // to the foreground). Nudge it to fail fast; its interrupt path will retry.
      abortControllerRef.current?.abort();
      return;
    }

    if (AppState.currentState !== "active") {
      return;
    }

    resumingRef.current = true;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const token = await getToken();
      if (!token) {
        throw new UIError("Missing authentication token. Sign in again and retry.");
      }

      const resumeUrl = `${BACKEND_BASE_URL}/ai/turn/${encodeURIComponent(active.turnId)}/stream?cursor=${active.appliedSeq}`;
      const response = await expoFetch(resumeUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const message =
          payload?.error === "turn_unauthorized"
            ? "This AI turn is not available."
            : "The AI response expired before it could be restored. Please try again.";
        finishTurn(message);
        return;
      }

      if (!response.ok) {
        finishTurn("AI turn could not be resumed.");
        return;
      }

      // Reaching the server counts as progress; reset the failure budget.
      resumeRetriesRef.current = 0;
      await driveTurnStream(response, active.appendResolvedUserMessage);
    } catch {
      // Network failure while resuming. Retry with a bounded budget so a persistent
      // failure ends the turn instead of wedging the chat in "streaming" forever.
      resumeRetriesRef.current += 1;
      if (resumeRetriesRef.current > maxResumeRetries) {
        finishTurn("AI turn could not be resumed.");
        return;
      }
      if (activeTurnRef.current && AppState.currentState === "active") {
        scheduleResume(resumeRetryDelayMs);
      }
    } finally {
      resumingRef.current = false;
    }
  };

  const runAssistantAction = async (
    action: AgentAction,
    options?: {
      audio?: AudioUpload;
      appendResolvedUserMessage?: boolean;
    },
  ) => {
    if (loopRunningRef.current) {
      return;
    }

    if (!userId) {
      setError("Missing authenticated user id. Sign in again and retry.");
      setErrorDetails(null);
      return;
    }

    loopRunningRef.current = true;
    activeTurnRef.current = null;
    openAssistantIdRef.current = null;
    setStatus("streaming");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await startTurnRequest(action, {
        audio: options?.audio,
        signal: controller.signal,
      });
      await driveTurnStream(response, Boolean(options?.appendResolvedUserMessage));
    } catch (loopError) {
      showError(loopError);
      finishTurn();
    }
  };

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void resumeActiveTurn();
      } else if (state === "background") {
        // Cut the in-flight stream deterministically so its read settles; the turn
        // keeps running server-side and we re-attach when we return to foreground.
        // Only abort once we know the turn id: aborting before the initial POST has
        // returned it would orphan a turn that already started server-side and
        // surface a spurious network error.
        if (activeTurnRef.current) {
          abortControllerRef.current?.abort();
        }
      }
    });

    return () => {
      subscription.remove();
      abortControllerRef.current?.abort();
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
  }, []);

  const submitMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || !userId || status !== "ready") {
      return;
    }

    clearError();
    setInput("");

    setMessages((current) => [
      ...current,
      {
        id: createMessageId(),
        kind: "text",
        role: "user",
        text: trimmed,
      },
    ]);

    await runAssistantAction({
      type: "user-message",
      message: trimmed,
    });
  };

  const startVoiceRecording = async () => {
    if (!userId || status !== "ready" || isRecording || loopRunningRef.current) {
      return;
    }

    voicePressingRef.current = true;
    clearError();

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        voicePressingRef.current = false;
        setError("Microphone permission is required for voice input.");
        setErrorDetails(null);
        return;
      }

      if (!voicePressingRef.current) {
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      if (!voicePressingRef.current) {
        await setAudioModeAsync({
          allowsRecording: false,
        }).catch(() => {
          // Ignore cleanup errors when the press was released during setup.
        });
        return;
      }

      await audioRecorder.prepareToRecordAsync();
      if (!voicePressingRef.current) {
        await setAudioModeAsync({
          allowsRecording: false,
        }).catch(() => {
          // Ignore cleanup errors when the press was released during setup.
        });
        return;
      }

      audioRecorder.record();
      recordingStartedAtRef.current = Date.now();
      recordingLockedRef.current = false;
      recordingCancelledRef.current = false;
      recordingDragProgress.value = 0;
      recordingCancelProgress.value = 0;
      setRecordingSeconds(0);
      setIsRecordingLocked(false);
      setIsRecording(true);
    } catch (recordingError) {
      voicePressingRef.current = false;
      voicePressStartXRef.current = null;
      voicePressStartYRef.current = null;
      recordingStartedAtRef.current = null;
      recordingLockedRef.current = false;
      recordingCancelledRef.current = false;
      recordingDragProgress.value = withTiming(0, { duration: 120, easing: Easing.out(Easing.ease) });
      recordingCancelProgress.value = withTiming(0, { duration: 120, easing: Easing.out(Easing.ease) });
      setIsRecordingLocked(false);
      setIsRecording(false);
      showError(recordingError);
    }
  };

  const handleVoiceRecordingMove = (event: GestureResponderEvent) => {
    if (!isRecording || recordingLockedRef.current) {
      return;
    }

    const startX = voicePressStartXRef.current;
    const startY = voicePressStartYRef.current;
    if (startX === null || startY === null) {
      return;
    }

    const lockDistance = Math.max(0, startY - event.nativeEvent.pageY);
    const cancelDistance = Math.max(0, startX - event.nativeEvent.pageX);
    const nextLockProgress = Math.min(1, lockDistance / recordingLockDistance);
    const nextCancelProgress = Math.min(1, cancelDistance / recordingCancelDistance);
    recordingDragProgress.value = nextLockProgress;
    recordingCancelProgress.value = nextCancelProgress;

    if (nextCancelProgress >= 1) {
      recordingCancelledRef.current = true;
      recordingCancelProgress.value = withTiming(1, { duration: 100, easing: Easing.out(Easing.ease) });
      void cancelVoiceRecording();
      return;
    }

    if (nextLockProgress >= 1) {
      recordingLockedRef.current = true;
      recordingDragProgress.value = withTiming(1, { duration: 120, easing: Easing.out(Easing.ease) });
      setIsRecordingLocked(true);
    }
  };

  const handleVoicePressIn = (event: GestureResponderEvent) => {
    recordingCancelledRef.current = false;
    voicePressStartXRef.current = event.nativeEvent.pageX;
    voicePressStartYRef.current = event.nativeEvent.pageY;
    recordingDragProgress.value = 0;
    recordingCancelProgress.value = 0;
    void startVoiceRecording();
  };

  const handleVoicePressOut = () => {
    voicePressStartXRef.current = null;
    voicePressStartYRef.current = null;
    voicePressingRef.current = false;

    if (recordingCancelledRef.current) {
      recordingCancelledRef.current = false;
      return;
    }

    if (recordingLockedRef.current) {
      return;
    }

    recordingDragProgress.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.ease) });
    recordingCancelProgress.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.ease) });
    void sendVoiceRecording();
  };

  const cancelVoiceRecording = async () => {
    voicePressingRef.current = false;
    voicePressStartXRef.current = null;
    voicePressStartYRef.current = null;
    recordingLockedRef.current = false;
    recordingDragProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.ease) });
    recordingCancelProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.ease) });
    setIsRecordingLocked(false);

    if (!isRecording) {
      return;
    }

    setIsRecording(false);

    try {
      await audioRecorder.stop();
    } catch (recordingError) {
      showError(recordingError);
    } finally {
      await setAudioModeAsync({
        allowsRecording: false,
      }).catch(() => {
        // Ignore cleanup errors after cancelling.
      });
    }
  };

  const sendVoiceRecording = async () => {
    voicePressingRef.current = false;
    voicePressStartXRef.current = null;
    voicePressStartYRef.current = null;
    recordingLockedRef.current = false;
    recordingDragProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.ease) });
    recordingCancelProgress.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.ease) });

    if (!isRecording) {
      return;
    }

    const elapsedSeconds = recordingStartedAtRef.current
      ? Math.max(1, Math.ceil((Date.now() - recordingStartedAtRef.current) / 1000))
      : Math.max(1, recordingSeconds);

    setIsRecording(false);
    setIsRecordingLocked(false);

    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) {
        throw new Error("Could not read recorded audio.");
      }

      const audioMeta = inferAudioMeta(uri);

      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "audio",
          role: "user",
          label: "Voice note",
          durationLabel: formatRecordingDuration(elapsedSeconds),
        },
      ]);

      await runAssistantAction(
        {
          type: "user-message",
        },
        {
          audio: {
            uri,
            mimeType: audioMeta.mimeType,
            fileName: audioMeta.fileName,
          },
          appendResolvedUserMessage: true,
        },
      );
    } catch (recordingError) {
      showError(recordingError);
    } finally {
      await setAudioModeAsync({
        allowsRecording: false,
      }).catch(() => {
        // Ignore cleanup errors after recording.
      });
    }
  };

  const respondToApproval = (toolCallId: string, suggestionId: string, approved: boolean) => {
    if (status === "streaming") {
      return;
    }

    const pendingSuggestions = pendingApprovalsRef.current.get(toolCallId);
    if (!pendingSuggestions) {
      return;
    }

    const targetIndex = pendingSuggestions.findIndex(
      (suggestion) => suggestion.suggestionId === suggestionId,
    );
    if (targetIndex === -1) {
      return;
    }

    if (pendingSuggestions[targetIndex]?.output) {
      return;
    }

    if (approved) {
      appendApprovedFoodToLog(pendingSuggestions[targetIndex]);
    }

    const itemOutput: ApprovalOutput = {
      approved,
      reason: approved ? undefined : "User rejected this suggestion.",
    };

    const nextSuggestions = pendingSuggestions.map((suggestion, index) =>
      index === targetIndex
        ? {
            ...suggestion,
            output: itemOutput,
          }
        : suggestion,
    );

    setMessages((current) =>
      current.map((message) =>
        message.kind === "approval" && message.toolCallId === toolCallId
          ? {
              ...message,
              suggestions: nextSuggestions,
            }
          : message,
      ),
    );

    if (nextSuggestions.every((suggestion) => Boolean(suggestion.output))) {
      pendingApprovalsRef.current.delete(toolCallId);
    } else {
      pendingApprovalsRef.current.set(toolCallId, nextSuggestions);
    }

    clearError();
  };

  if (!isDataReady || isLoadingEntries) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading data…</Text>
      </View>
    );
  }

  const hasInputText = input.trim().length > 0;
  const canUseComposerActions = Boolean(userId) && !isStreaming;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: 24,
          },
        ]}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }}
      >
        <Text style={styles.largeTitle}>AI Log</Text>
        <Text style={styles.subtitle}>
          Ask for foods, review suggestions, then approve each one to add to your log.
        </Text>

        {!userId ? (
          <View style={styles.warningCard}>
            <Text style={styles.warningText}>
              Sign in to enable AI logging.
            </Text>
          </View>
        ) : null}

        {messages.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="chatbubbles-outline" size={28} color={palette.tertiaryLabel} style={{ marginBottom: 8 }} />
            <Text style={styles.emptyText}>
              {"\"I had a protein bar for breakfast\"\n\"Find grilled chicken for lunch\""}
            </Text>
          </View>
        ) : null}

        {messages.map((message) => {
          const isLastMessage = messages[messages.length - 1]?.id === message.id;
          const isActiveAssistantStream =
            message.kind === "text" && message.role === "assistant" && isStreaming && isLastMessage;

          if (message.kind === "text") {
            const isUser = message.role === "user";
            const text = message.text.trim();

            return (
              <View
                key={message.id}
                style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}
              >
                {text ? (
                  isUser ? (
                    <Text style={[styles.messageText, styles.userMessageText]}>{message.text}</Text>
                  ) : (
                    <StreamdownRN
                      theme={markdownTheme}
                      isComplete={!isActiveAssistantStream}
                      style={styles.assistantMarkdown}
                    >
                      {message.text}
                    </StreamdownRN>
                  )
                ) : (
                  <TypingIndicator color={palette.secondaryLabel} />
                )}
              </View>
            );
          }

          if (message.kind === "audio") {
            return (
              <View
                key={message.id}
                style={[styles.messageBubble, styles.userBubble, styles.audioBubble]}
              >
                <View style={styles.audioIconCircle}>
                  <Ionicons name="mic" size={15} color={palette.userBubble} />
                </View>
                <AudioBubbleWaveform color={palette.buttonText} />
                <View style={styles.audioMetaColumn}>
                  <Text style={[styles.audioLabel, styles.userMessageText]}>{message.label}</Text>
                  <Text style={styles.audioDuration}>{message.durationLabel}</Text>
                </View>
              </View>
            );
          }

          if (message.kind === "search") {
            if (message.foods.length === 0) {
              return null;
            }

            const isExpanded = expandedSearchIds.has(message.id);
            const query = message.query?.trim() || inferSearchQueryFromFoods(message.foods);

            return (
              <Animated.View
                key={message.id}
                layout={searchLayoutTransition}
                style={[styles.messageBubble, styles.assistantBubble, styles.searchBubble]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isExpanded ? "Hide search results" : "Show search results"}
                  onPress={() => {
                    toggleSearchExpanded(message.id);
                  }}
                  style={styles.searchSummaryRow}
                >
                  <Ionicons name="search" size={15} color={palette.secondaryLabel} />
                  <Text style={styles.searchSummaryText}>
                    Searched for <Text style={styles.searchSummaryQuery}>{query}</Text>
                  </Text>
                  <Ionicons
                    name={isExpanded ? "chevron-up" : "chevron-down"}
                    size={15}
                    color={palette.secondaryLabel}
                  />
                </Pressable>

                <SearchResultsDisclosure expanded={isExpanded} foods={message.foods} styles={styles} />
              </Animated.View>
            );
          }

          return (
            <View key={message.id} style={[styles.messageBubble, styles.assistantBubble, styles.approvalBubble]}>
              <View style={styles.toolCard}>
                <Text style={styles.toolHeading}>Review suggestions</Text>
                {message.suggestions.map((suggestion) => {
                  const mealLabel = mealLabelFor(suggestion.meal);

                  return (
                    <View key={suggestion.suggestionId} style={styles.suggestionCard}>
                      <View style={styles.toolTitleRow}>
                        <Text style={styles.sourceBadge}>{suggestion.food.sourceLabel}</Text>
                        <Text style={styles.toolText}>
                          {suggestion.food.name}
                          {suggestion.food.brand ? ` • ${suggestion.food.brand}` : ""}
                        </Text>
                      </View>
                      {suggestion.food.serving ? (
                        <Text style={styles.toolMeta}>{suggestion.food.serving}</Text>
                      ) : null}
                      <Text style={styles.toolMeta}>
                        {suggestion.resultId} • {formatPortionLabel(suggestion.portion)} to {mealLabel}
                      </Text>
                      <MacroBadges
                        nutrition={suggestion.food.nutrition}
                        multiplier={suggestion.portion}
                        containerStyle={styles.toolMacroBadges}
                      />
                      <Text style={styles.toolReason}>{suggestion.reason}</Text>

                      {suggestion.output ? (
                        <Text
                          style={[
                            styles.toolMeta,
                            suggestion.output.approved ? styles.approvedText : styles.rejectedText,
                          ]}
                        >
                          {suggestion.output.approved
                            ? "Approved and logged."
                            : suggestion.output.reason ?? "Rejected. Ask for another option."}
                        </Text>
                      ) : (
                        <View style={styles.approvalRow}>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isStreaming}
                            onPress={() => {
                              void respondToApproval(message.toolCallId, suggestion.suggestionId, true);
                            }}
                            style={[styles.approveButton, isStreaming && styles.buttonDisabled]}
                          >
                            <Text style={styles.approveButtonText}>Approve</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isStreaming}
                            onPress={() => {
                              void respondToApproval(message.toolCallId, suggestion.suggestionId, false);
                            }}
                            style={[styles.denyButton, isStreaming && styles.buttonDisabled]}
                          >
                            <Text style={styles.denyButtonText}>Reject</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}

        {isStreaming && (messages.length === 0 || (() => { const last = messages[messages.length - 1]; return !last || last.kind !== "text" || last.role !== "assistant"; })()) ? (
          <View style={[styles.messageBubble, styles.assistantBubble]}>
            <TypingIndicator color={palette.secondaryLabel} />
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            {errorDetails ? (
              <Text selectable style={styles.errorDetailsText}>
                {errorDetails}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <Animated.View
        layout={composerLayoutTransition}
        style={[
          styles.composerContainer,
          { paddingBottom: isKeyboardVisible ? 10 : insets.bottom + 10 },
        ]}
      >
        <Animated.View layout={composerLayoutTransition} style={styles.composerRow}>
          {isRecording ? (
            <RecordingCardView
              progress={recordingUiProgress}
              style={[styles.recordingCard, isRecordingLocked && styles.recordingCardLocked]}
            >
              <View style={styles.recordingStatusRow}>
                <View style={styles.recordingLiveDot} />
                <Text style={styles.recordingTimer}>{formatRecordingDuration(recordingSeconds)}</Text>
              </View>
              <RecordingWaveform color={palette.error} />
              {isRecordingLocked ? null : (
                <RecordingCancelHint
                  progress={recordingCancelProgress}
                  palette={palette}
                  styles={styles}
                />
              )}
            </RecordingCardView>
          ) : (
            <Animated.View
              entering={composerEnterTransition}
              exiting={composerExitTransition}
              layout={composerLayoutTransition}
              style={styles.inputBox}
            >
              <AnimatedTextInput
                value={input}
                onChangeText={setInput}
                onContentSizeChange={handleInputContentSizeChange}
                onFocus={() => {
                  requestAnimationFrame(() => {
                    scrollViewRef.current?.scrollToEnd({ animated: true });
                  });
                }}
                placeholder="Message the food assistant"
                placeholderTextColor={palette.secondaryLabel}
                style={[styles.input, inputHeightAnimatedStyle]}
                multiline
                maxLength={600}
                editable={Boolean(userId) && !isStreaming}
                keyboardAppearance={isDark ? "dark" : "light"}
                selectionColor={palette.tint}
              />
            </Animated.View>
          )}

          {hasInputText && !isRecording ? (
            <Animated.View
              key="send"
              entering={composerEnterTransition}
              exiting={composerExitTransition}
              layout={composerLayoutTransition}
            >
              <Pressable
                accessibilityRole="button"
                disabled={!canUseComposerActions || !hasInputText}
                onPress={() => {
                  void submitMessage();
                }}
                style={[
                  styles.sendButton,
                  (!canUseComposerActions || !hasInputText) && styles.buttonDisabled,
                ]}
              >
                <Ionicons name="send" size={20} color={palette.buttonText} />
              </Pressable>
            </Animated.View>
          ) : null}

          {isRecordingLocked ? (
            <Animated.View
              entering={composerEnterTransition}
              exiting={composerExitTransition}
              layout={composerLayoutTransition}
            >
              <Pressable
                accessibilityLabel="Cancel voice note"
                accessibilityRole="button"
                onPress={() => {
                  void cancelVoiceRecording();
                }}
                style={styles.cancelRecordingButton}
              >
                <Ionicons name="trash" size={20} color={palette.secondaryLabel} />
              </Pressable>
            </Animated.View>
          ) : null}

          {isRecordingLocked ? (
            <Animated.View
              entering={composerEnterTransition}
              exiting={composerExitTransition}
              layout={composerLayoutTransition}
            >
              <Pressable
                accessibilityLabel="Send voice note"
                accessibilityRole="button"
                onPress={() => {
                  void sendVoiceRecording();
                }}
                style={[styles.sendButton, styles.voiceSendButton]}
              >
                <Ionicons name="send" size={20} color={palette.buttonText} />
              </Pressable>
            </Animated.View>
          ) : null}

          {!hasInputText && !isRecordingLocked ? (
            <Animated.View
              entering={composerEnterTransition}
              exiting={composerExitTransition}
              layout={composerLayoutTransition}
              style={styles.voiceActionWrap}
            >
              {isRecording ? (
                <RecordingLockTarget
                  progress={recordingDragProgress}
                  locked={isRecordingLocked}
                  palette={palette}
                  styles={styles}
                />
              ) : null}
              <Animated.View
                key="voice"
                accessible
                accessibilityLabel={isRecording ? "Drag up to hold recording" : "Hold to record voice note"}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canUseComposerActions }}
                onResponderGrant={handleVoicePressIn}
                onResponderMove={handleVoiceRecordingMove}
                onResponderRelease={handleVoicePressOut}
                onResponderTerminate={handleVoicePressOut}
                onStartShouldSetResponder={() => canUseComposerActions}
                style={[
                  styles.voiceButton,
                  isRecording && styles.voiceButtonRecording,
                  !canUseComposerActions && styles.buttonDisabled,
                  voiceButtonAnimatedStyle,
                ]}
              >
                <Ionicons
                  name={isRecording ? "lock-open" : "mic"}
                  size={isRecording ? 20 : 22}
                  color={palette.buttonText}
                />
              </Animated.View>
            </Animated.View>
          ) : null}
        </Animated.View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

function createStyles({ palette }: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.background,
    },
    contentContainer: {
      paddingHorizontal: 16,
    },
    scrollView: {
      flex: 1,
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
    subtitle: {
      marginTop: 2,
      marginBottom: 14,
      paddingHorizontal: 4,
      fontSize: 15,
      lineHeight: 20,
      color: palette.secondaryLabel,
    },
    warningCard: {
      backgroundColor: palette.card,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    warningText: {
      color: palette.error,
      fontSize: 14,
      lineHeight: 19,
      fontWeight: "500",
    },
    emptyCard: {
      backgroundColor: palette.card,
      borderRadius: 16,
      padding: 20,
      marginTop: 8,
      marginBottom: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
      alignItems: "center",
    },
    emptyText: {
      fontSize: 15,
      lineHeight: 21,
      color: palette.secondaryLabel,
      textAlign: "center",
    },
    messageBubble: {
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 6,
      maxWidth: "85%",
    },
    userBubble: {
      alignSelf: "flex-end",
      backgroundColor: palette.userBubble,
      borderBottomRightRadius: 6,
    },
    assistantBubble: {
      alignSelf: "flex-start",
      backgroundColor: palette.assistantBubble,
      borderBottomLeftRadius: 6,
    },
    searchBubble: {
      paddingHorizontal: 12,
      paddingVertical: 9,
      maxWidth: "92%",
      minWidth: 260,
    },
    searchSummaryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    searchSummaryText: {
      flex: 1,
      fontSize: 14,
      lineHeight: 19,
      color: palette.secondaryLabel,
    },
    searchSummaryQuery: {
      color: palette.label,
      fontWeight: "600",
    },
    searchResultsClip: {
      overflow: "hidden",
    },
    searchResults: {
      marginTop: 9,
      paddingTop: 9,
      paddingBottom: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.separator,
      gap: 8,
    },
    searchResultRow: {
      gap: 4,
    },
    searchResultName: {
      fontSize: 14,
      lineHeight: 19,
      color: palette.label,
    },
    searchResultMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      flexWrap: "wrap",
    },
    searchResultMeta: {
      fontSize: 12,
      lineHeight: 16,
      color: palette.secondaryLabel,
    },
    audioBubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingVertical: 8,
      minWidth: 206,
    },
    audioIconCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.buttonText,
    },
    audioMetaColumn: {
      gap: 1,
    },
    audioLabel: {
      fontSize: 13,
      lineHeight: 16,
      fontWeight: "600",
    },
    audioDuration: {
      fontSize: 11,
      lineHeight: 14,
      fontVariant: ["tabular-nums"],
      color: "rgba(255,255,255,0.74)",
    },
    messageText: {
      fontSize: 16,
      lineHeight: 22,
      color: palette.label,
    },
    userMessageText: {
      color: palette.buttonText,
    },
    assistantMarkdown: {
      flex: 0,
      width: "100%",
      marginBottom: -12,
    },
    approvalBubble: {
      maxWidth: "92%",
      width: "92%",
      paddingHorizontal: 10,
      paddingVertical: 10,
    },
    toolCard: {
      borderRadius: 10,
      backgroundColor: palette.cardElevated,
      padding: 12,
      gap: 2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    suggestionCard: {
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.separator,
    },
    toolTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    toolHeading: {
      fontSize: 13,
      lineHeight: 17,
      fontWeight: "700",
      color: palette.label,
    },
    toolText: {
      flex: 1,
      marginTop: 2,
      fontSize: 14,
      lineHeight: 19,
      color: palette.label,
    },
    toolMeta: {
      marginTop: 1,
      fontSize: 12,
      lineHeight: 17,
      color: palette.secondaryLabel,
    },
    toolMacroBadges: {
      marginTop: 6,
    },
    sourceBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      overflow: "hidden",
      fontSize: 11,
      lineHeight: 14,
      fontWeight: "700",
      color: palette.tint,
      backgroundColor: "rgba(37,99,235,0.12)",
    },
    toolReason: {
      marginTop: 8,
      fontSize: 13,
      lineHeight: 18,
      color: palette.secondaryLabel,
    },
    approvalRow: {
      marginTop: 12,
      flexDirection: "row",
      gap: 8,
      alignSelf: "stretch",
    },
    approveButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      borderRadius: 10,
      backgroundColor: palette.success,
      alignItems: "center",
      justifyContent: "center",
    },
    approveButtonText: {
      color: palette.buttonText,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: "600",
    },
    denyButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      borderRadius: 10,
      backgroundColor: palette.error,
      alignItems: "center",
      justifyContent: "center",
    },
    denyButtonText: {
      color: palette.buttonText,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: "600",
    },
    approvedText: {
      color: palette.success,
      fontWeight: "600",
    },
    rejectedText: {
      color: palette.error,
      fontWeight: "600",
    },
    errorText: {
      marginTop: 6,
      paddingHorizontal: 4,
      fontSize: 13,
      lineHeight: 18,
      color: palette.error,
    },
    errorCard: {
      marginBottom: 8,
    },
    errorDetailsText: {
      marginTop: 4,
      paddingHorizontal: 4,
      fontSize: 12,
      lineHeight: 17,
      color: palette.secondaryLabel,
      fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    },
    composerContainer: {
      paddingHorizontal: 12,
      paddingTop: 8,
      backgroundColor: palette.overlay,
      overflow: "visible",
    },
    composerRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      overflow: "visible",
    },
    inputBox: {
      flex: 1,
      backgroundColor: palette.card,
      borderRadius: 22,
      paddingVertical: 6,
      paddingLeft: 16,
      paddingRight: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    recordingCard: {
      flex: 1,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: palette.cardElevated,
      borderRadius: 22,
      paddingVertical: 7,
      paddingLeft: 12,
      paddingRight: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.error,
    },
    recordingCardLocked: {
      paddingLeft: 10,
      backgroundColor: palette.cardElevated,
      borderColor: palette.error,
    },
    input: {
      minHeight: 36,
      maxHeight: 140,
      color: palette.label,
      paddingHorizontal: 0,
      paddingVertical: 8,
      fontSize: 16,
      lineHeight: 20,
    },
    sendButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.tint,
    },
    voiceSendButton: {
      backgroundColor: palette.error,
    },
    recordingStatusRow: {
      minWidth: 54,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    recordingLiveDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: palette.error,
    },
    recordingTimer: {
      color: palette.label,
      fontSize: 15,
      lineHeight: 20,
      fontVariant: ["tabular-nums"],
      fontWeight: "600",
    },
    recordingCancelHint: {
      width: 128,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 1,
    },
    recordingCancelHintText: {
      color: palette.secondaryLabel,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: "500",
    },
    cancelRecordingButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    voiceActionWrap: {
      width: 44,
      height: 44,
      position: "relative",
      overflow: "visible",
      zIndex: 3,
    },
    voiceButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.tint,
    },
    voiceButtonRecording: {
      backgroundColor: palette.error,
    },
    recordingLockTarget: {
      position: "absolute",
      right: -10,
      bottom: 54,
      width: 64,
      height: 132,
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 5,
      paddingBottom: 2,
      zIndex: 4,
    },
    recordingLockBubble: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.cardElevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.error,
    },
    recordingLockBubbleActive: {
      backgroundColor: palette.error,
    },
    recordingLockRail: {
      width: 4,
      height: 42,
      borderRadius: 2,
      backgroundColor: "rgba(127,127,127,0.20)",
      overflow: "hidden",
      justifyContent: "flex-end",
    },
    recordingLockRailFill: {
      width: 4,
      borderRadius: 2,
      backgroundColor: palette.error,
    },
    recordingLockHint: {
      color: palette.secondaryLabel,
      fontSize: 11,
      lineHeight: 13,
      fontWeight: "600",
      textAlign: "center",
    },
    buttonDisabled: {
      backgroundColor: palette.tintDisabled,
    },
  });
}

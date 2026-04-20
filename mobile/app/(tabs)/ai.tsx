import { fetch as expoFetch } from "expo/fetch";
import { useEffect, useRef, useState } from "react";
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
  type ColorValue,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
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
};

type SearchUIMessage = {
  id: string;
  kind: "search";
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

type StreamingTurnResult = {
  status: ChatStatus;
  events: AgentEvent[];
  resolvedUserMessage?: string;
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
};

const recentLogWindowMs = 3 * 24 * 60 * 60 * 1000;
const maxRecentLogHints = 80;

const createMessageId = () => createAiMessageId();

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

function buildStreamingResult(payloads: StreamingPayload[]): StreamingTurnResult {
  let status: ChatStatus = "ready";
  let resolvedUserMessage: string | undefined;
  const events: AgentEvent[] = [];

  for (const payload of payloads) {
    if (payload.type === "status") {
      if (payload.status === "ready") {
        status = payload.status;
      }
      continue;
    }

    if (payload.type === "resolved-user-message") {
      if (typeof payload.resolvedUserMessage === "string") {
        resolvedUserMessage = payload.resolvedUserMessage;
      }
      continue;
    }

    if (payload.type === "event") {
      const event = normalizeStreamingPayloadEvent(payload.event);
      if (event) {
        events.push(event);
      }
      continue;
    }

    if (payload.type === "error") {
      const backendMessage =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : "Unknown error.";
      throw new UIError(backendMessage);
    }
  }

  return {
    status,
    events,
    resolvedUserMessage,
  };
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
  const scrollViewRef = useRef<ScrollView | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);

  const isStreaming = status === "streaming";
  const sessionIdRef = useRef<string | null>(null);
  const pendingApprovalsRef = useRef(new Map<string, ResolvedApprovalSuggestion[]>());
  const loopRunningRef = useRef(false);

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

  const requestTurn = async (
    action: AgentAction,
    options?: {
      audio?: AudioUpload;
      onEvent?: (event: AgentEvent) => void;
    },
    retry = true,
  ): Promise<StreamingTurnResult> => {
    const sessionId = await ensureSessionId();
    const token = await getToken();
    if (!token) {
      throw new UIError("Missing authentication token. Sign in again and retry.");
    }

    const usingAudio = Boolean(options?.audio && action.type === "user-message");
    const userMessage = action.type === "user-message" ? action.message?.trim() : undefined;

    const body = usingAudio
      ? await (async () => {
          const formData = new FormData();
          formData.append("sessionId", sessionId);
          formData.append("actionType", action.type);
          if (userMessage) {
            formData.append("message", userMessage);
          }

          const audio = options?.audio;
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
        return requestTurn(action, options, false);
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

    const reader = response.body?.getReader();
    if (!reader) {
      throw new UIError(
        "Backend AI response was not streamable.",
        buildErrorDetails({
          method: "POST",
          url: turnUrl,
          status: response.status,
        }),
      );
    }

    const decoder = new TextDecoder();
    let pending = "";
    const payloads: StreamingPayload[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const chunks = pending.split("\n\n");
      pending = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const nextPayloads = parseSseEventsFromChunk(`${chunk}\n\n`);
        for (const payload of nextPayloads) {
          payloads.push(payload);
          if (payload.type === "event") {
            const event = normalizeStreamingPayloadEvent(payload.event);
            if (event) {
              options?.onEvent?.(event);
            }
          }
        }
      }
    }

    if (pending.trim()) {
      const finalPayloads = parseSseEventsFromChunk(pending);
      for (const payload of finalPayloads) {
        payloads.push(payload);
        if (payload.type === "event") {
          const event = normalizeStreamingPayloadEvent(payload.event);
          if (event) {
            options?.onEvent?.(event);
          }
        }
      }
    }

    return buildStreamingResult(payloads);
  };

  const applyAgentEvents = (events: AgentEvent[]) => {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      if (event.kind === "approval") {
        pendingApprovalsRef.current.set(event.toolCallId, event.suggestions);
      }
    }

    setMessages((current) => {
      const next = [...current];

      for (const event of events) {
        if (event.kind === "assistant-delta") {
          if (!event.text) {
            continue;
          }

          const lastMessage = next[next.length - 1];
          if (lastMessage?.kind === "text" && lastMessage.role === "assistant") {
            lastMessage.text += event.text;
          } else {
            next.push({
              id: createMessageId(),
              kind: "text",
              role: "assistant",
              text: event.text,
            });
          }
          continue;
        }

        if (event.kind === "assistant") {
          if (!event.text.trim()) {
            continue;
          }

          const lastMessage = next[next.length - 1];
          if (lastMessage?.kind === "text" && lastMessage.role === "assistant") {
            lastMessage.text = event.text;
          } else {
            next.push({
              id: createMessageId(),
              kind: "text",
              role: "assistant",
              text: event.text,
            });
          }
          continue;
        }

        if (event.kind === "search") {
          if (event.foods.length === 0) {
            continue;
          }

          next.push({
            id: createMessageId(),
            kind: "search",
            foods: event.foods,
          });
          continue;
        }

        next.push({
          id: createMessageId(),
          kind: "approval",
          toolCallId: event.toolCallId,
          suggestions: event.suggestions,
        });
      }

      return next;
    });
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
    let nextStatus: ChatStatus = "ready";

    try {
      setStatus("streaming");
      const streamedEventsJson = new Set<string>();
      const result = await requestTurn(action, {
        ...options,
        onEvent: (event) => {
          streamedEventsJson.add(JSON.stringify(event));
          applyAgentEvents([event]);
        },
      });
      const resolvedUserMessage = result.resolvedUserMessage?.trim();

      if (options?.appendResolvedUserMessage && resolvedUserMessage) {
        setMessages((current) => [
          ...current,
          {
            id: createMessageId(),
            kind: "text",
            role: "user",
            text: resolvedUserMessage,
          },
        ]);
      }

      const remainingEvents = result.events.filter((event) => !streamedEventsJson.has(JSON.stringify(event)));
      applyAgentEvents(remainingEvents);
      nextStatus = result.status;
    } catch (loopError) {
      showError(loopError);
      nextStatus = "ready";
    } finally {
      loopRunningRef.current = false;
      setStatus(nextStatus);
    }
  };

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

    clearError();

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required for voice input.");
        setErrorDetails(null);
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
    } catch (recordingError) {
      setIsRecording(false);
      showError(recordingError);
    }
  };

  const stopVoiceRecording = async () => {
    if (!isRecording) {
      return;
    }

    setIsRecording(false);

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
  const hasPendingApprovals = messages.some(
    (message) => message.kind === "approval" && message.suggestions.some((suggestion) => !suggestion.output),
  );
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

        {hasPendingApprovals ? (
          <View style={styles.awaitingCard}>
            <Text style={styles.awaitingText}>Suggestions stay available while you keep chatting.</Text>
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
                <Ionicons name="mic" size={15} color={palette.buttonText} />
                <Text style={[styles.messageText, styles.userMessageText]}>{message.label}</Text>
              </View>
            );
          }

          if (message.kind === "search") {
            if (message.foods.length === 0) {
              return null;
            }

            return (
              <View key={message.id} style={[styles.messageBubble, styles.assistantBubble]}>
                <View style={styles.toolCard}>
                  <Text style={styles.toolHeading}>Found foods</Text>
                  {message.foods.slice(0, 6).map((food) => (
                    <View key={food.resultId} style={styles.suggestionCard}>
                      <View style={styles.toolTitleRow}>
                        <Text style={styles.sourceBadge}>{food.sourceLabel}</Text>
                        <Text style={styles.toolText}>
                          {food.resultId} • {food.name}
                          {food.brand ? ` • ${food.brand}` : ""}
                        </Text>
                      </View>
                      {food.nutrition?.calories !== undefined ? (
                        <Text style={styles.toolMeta}>{`${formatCalories(food.nutrition.calories)} kcal`}</Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            );
          }

          return (
            <View key={message.id} style={[styles.messageBubble, styles.assistantBubble]}>
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

      <View
        style={[
          styles.composerContainer,
          { paddingBottom: isKeyboardVisible ? 10 : insets.bottom + 10 },
        ]}
      >
        <View style={styles.composerCard}>
          <TextInput
            value={input}
            onChangeText={setInput}
            onFocus={() => {
              requestAnimationFrame(() => {
                scrollViewRef.current?.scrollToEnd({ animated: true });
              });
            }}
            placeholder="Message the food assistant"
            placeholderTextColor={palette.secondaryLabel}
            style={styles.input}
            multiline
            maxLength={600}
            editable={Boolean(userId) && !isStreaming}
            keyboardAppearance={isDark ? "dark" : "light"}
            selectionColor={palette.tint}
          />
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
            <Ionicons name="send" size={16} color={palette.buttonText} />
          </Pressable>
          {!hasInputText ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canUseComposerActions}
              onPressIn={() => {
                void startVoiceRecording();
              }}
              onPressOut={() => {
                void stopVoiceRecording();
              }}
              style={[
                styles.voiceButton,
                isRecording && styles.voiceButtonRecording,
                !canUseComposerActions && styles.buttonDisabled,
              ]}
            >
              <Ionicons
                name={isRecording ? "radio-button-on" : "mic"}
                size={16}
                color={palette.buttonText}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
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
    awaitingCard: {
      backgroundColor: palette.card,
      borderRadius: 14,
      padding: 12,
      marginBottom: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    awaitingText: {
      color: palette.secondaryLabel,
      fontSize: 13,
      lineHeight: 18,
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
    audioBubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
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
    toolCard: {
      borderRadius: 10,
      backgroundColor: palette.cardElevated,
      padding: 10,
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
      marginTop: 10,
      flexDirection: "row",
      gap: 8,
    },
    approveButton: {
      flex: 1,
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
    },
    composerCard: {
      backgroundColor: palette.card,
      borderRadius: 22,
      paddingVertical: 6,
      paddingLeft: 16,
      paddingRight: 6,
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.separator,
    },
    input: {
      flex: 1,
      minHeight: 36,
      maxHeight: 140,
      color: palette.label,
      paddingHorizontal: 0,
      paddingVertical: 8,
      fontSize: 16,
      lineHeight: 20,
    },
    sendButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.tint,
    },
    voiceButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.tint,
    },
    voiceButtonRecording: {
      backgroundColor: palette.error,
    },
    buttonDisabled: {
      backgroundColor: palette.tintDisabled,
    },
  });
}

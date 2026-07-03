import { fetch as expoFetch } from "expo/fetch";
import { getAuthCookie, useAuth } from "../auth/auth-client";
import * as Sentry from "@sentry/react-native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  type GestureResponderEvent,
  Keyboard,
  type NativeSyntheticEvent,
  Platform,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { localDateKeyFromTimestamp } from "../date";
import { useAllFoodEntries, useDataStoreActions, useDataStoreReady } from "../data/DataProvider";
import { normalizeMeal } from "../meals";
import {
  buildRecentLogHints,
  buildErrorDetails,
  cloneNutrition,
  createAudioUploadPart,
  createMessageId,
  formatRecordingDuration,
  getErrorDetails,
  getErrorMessage,
  inferAudioMeta,
  normalizeStreamingPayloadEvent,
  parseSseEventsFromChunk,
  UIError,
} from "./helpers";
import {
  type ActiveTurn,
  type AgentAction,
  type AgentEvent,
  type AudioUpload,
  BACKEND_BASE_URL,
  type ChatStatus,
  interruptResumeDelayMs,
  maxResumeRetries,
  recordingCancelDistance,
  recordingLockDistance,
  type ResolvedApprovalSuggestion,
  resumeRetryDelayMs,
  type StreamingPayload,
  type TurnStreamOutcome,
  type UIMessage,
} from "./types";

type AnimatedStyle = ReturnType<typeof useAnimatedStyle>;

type AIChatContextValue = {
  // session / data
  userId: string | null | undefined;
  isReady: boolean;
  // conversation
  messages: UIMessage[];
  status: ChatStatus;
  isStreaming: boolean;
  error: string | null;
  errorDetails: string | null;
  // composer text
  input: string;
  setInput: (value: string) => void;
  hasInputText: boolean;
  canUseComposerActions: boolean;
  inputHeightAnimatedStyle: AnimatedStyle;
  handleInputContentSizeChange: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
  submitMessage: () => Promise<void>;
  // voice
  isRecording: boolean;
  isRecordingLocked: boolean;
  recordingSeconds: number;
  recordingUiProgress: SharedValue<number>;
  recordingDragProgress: SharedValue<number>;
  recordingCancelProgress: SharedValue<number>;
  voiceButtonAnimatedStyle: AnimatedStyle;
  handleVoicePressIn: (event: GestureResponderEvent) => void;
  handleVoiceRecordingMove: (event: GestureResponderEvent) => void;
  handleVoicePressOut: () => void;
  cancelVoiceRecording: () => void;
  sendVoiceRecording: () => void;
  formatRecordingDuration: (totalSeconds: number) => string;
  // transcript
  expandedSearchIds: Set<string>;
  toggleSearchExpanded: (messageId: string) => void;
  respondToApproval: (toolCallId: string, suggestionId: string, approved: boolean) => void;
  // panel visibility
  isKeyboardVisible: boolean;
  keyboardHeight: number;
  isConversationVisible: boolean;
  blurNonce: number;
  openConversation: () => void;
  closeConversation: () => void;
};

const AIChatContext = createContext<AIChatContextValue | null>(null);

export function useAIChat(): AIChatContextValue {
  const value = useContext(AIChatContext);
  if (!value) {
    throw new Error("useAIChat must be used within an AIChatProvider");
  }
  return value;
}

export function AIChatProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const isDataReady = useDataStoreReady();
  const { createFoodEntry } = useDataStoreActions();
  const { data: recentEntries, isLoading: isLoadingEntries } = useAllFoodEntries();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [expandedSearchIds, setExpandedSearchIds] = useState<Set<string>>(new Set());
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  // Bumped whenever the conversation is explicitly closed, so the composer can
  // blur its (native) input — otherwise it keeps focus and a later tap won't
  // re-fire focus to reopen the panel.
  const [blurNonce, setBlurNonce] = useState(0);
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
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setIsKeyboardVisible(true);
      const height = event?.endCoordinates?.height;
      if (typeof height === "number" && height > 0) {
        setKeyboardHeight(height);
      }
    });

    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setIsKeyboardVisible(false);
      setKeyboardHeight(0);
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

  const handleInputContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const nextHeight = Math.min(140, Math.max(36, Math.ceil(event.nativeEvent.contentSize.height)));
      inputHeight.value = withTiming(nextHeight, {
        duration: 130,
        easing: Easing.out(Easing.cubic),
      });
    },
    [inputHeight],
  );

  const toggleSearchExpanded = useCallback((messageId: string) => {
    setExpandedSearchIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const openConversation = useCallback(() => setIsPanelOpen(true), []);
  const closeConversation = useCallback(() => {
    setIsPanelOpen(false);
    setBlurNonce((n) => n + 1);
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

    const cookie = getAuthCookie();
    if (!cookie) {
      throw new UIError("Missing authentication token. Sign in again and retry.");
    }

    const sessionUrl = `${BACKEND_BASE_URL}/ai/session`;
    let response: Response;
    try {
      response = await fetch(sessionUrl, {
        method: "POST",
        credentials: "omit",
        headers: {
          Cookie: cookie,
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
    const cookie = getAuthCookie();
    if (!cookie) {
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
        credentials: "omit",
        headers: {
          Accept: "text/event-stream",
          Cookie: cookie,
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
      const cookie = getAuthCookie();
      if (!cookie) {
        throw new UIError("Missing authentication token. Sign in again and retry.");
      }

      const resumeUrl = `${BACKEND_BASE_URL}/ai/turn/${encodeURIComponent(active.turnId)}/stream?cursor=${active.appliedSeq}`;
      const response = await expoFetch(resumeUrl, {
        method: "GET",
        credentials: "omit",
        headers: {
          Accept: "text/event-stream",
          Cookie: cookie,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || !userId || status !== "ready") {
      return;
    }

    clearError();
    setInput("");
    setIsPanelOpen(true);

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

      setIsPanelOpen(true);
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

    const itemOutput = {
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

  const isReady = isDataReady && !isLoadingEntries;
  const hasInputText = input.trim().length > 0;
  const canUseComposerActions = Boolean(userId) && isReady && !isStreaming;
  const isConversationVisible = isPanelOpen && (messages.length > 0 || isStreaming || Boolean(error));

  const value = useMemo<AIChatContextValue>(
    () => ({
      userId,
      isReady,
      messages,
      status,
      isStreaming,
      error,
      errorDetails,
      input,
      setInput,
      hasInputText,
      canUseComposerActions,
      inputHeightAnimatedStyle,
      handleInputContentSizeChange,
      submitMessage,
      isRecording,
      isRecordingLocked,
      recordingSeconds,
      recordingUiProgress,
      recordingDragProgress,
      recordingCancelProgress,
      voiceButtonAnimatedStyle,
      handleVoicePressIn,
      handleVoiceRecordingMove,
      handleVoicePressOut,
      cancelVoiceRecording,
      sendVoiceRecording,
      formatRecordingDuration,
      expandedSearchIds,
      toggleSearchExpanded,
      respondToApproval,
      isKeyboardVisible,
      keyboardHeight,
      isConversationVisible,
      blurNonce,
      openConversation,
      closeConversation,
    }),
    // The handler closures are stable enough for our needs; re-memoize on the
    // state values the consumers actually render against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      userId,
      isReady,
      messages,
      status,
      isStreaming,
      error,
      errorDetails,
      input,
      hasInputText,
      canUseComposerActions,
      isRecording,
      isRecordingLocked,
      recordingSeconds,
      expandedSearchIds,
      isKeyboardVisible,
      keyboardHeight,
      isConversationVisible,
      blurNonce,
    ],
  );

  return <AIChatContext.Provider value={value}>{children}</AIChatContext.Provider>;
}

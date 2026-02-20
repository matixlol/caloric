import { useRef, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAccount } from "jazz-tools/expo";
import {
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
import { StreamdownRN } from "streamdown-rn";
import { CaloricAccount } from "../../src/jazz/schema";
import { mealLabelFor, normalizeMeal } from "../../src/meals";
import { formatPortionLabel } from "../../src/portion";

const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  userBubble: "#2563EB",
  assistantBubble: iosColor("secondarySystemFill", "#E5E7EB"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  separator: iosColor("separator", "#D1D5DB"),
  buttonText: "#FFFFFF",
  tint: "#2563EB",
  tintDisabled: "#9CA3AF",
  error: iosColor("systemRed", "#DC2626"),
  success: iosColor("systemGreen", "#16A34A"),
};

type Meal = "breakfast" | "lunch" | "dinner" | "snacks";

type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

type ChatStatus = "ready" | "streaming" | "awaiting-approval";

type SearchResultFood = {
  resultId: string;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugars?: number;
    sodiumMg?: number;
    potassiumMg?: number;
  };
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

type UIMessage = TextUIMessage | SearchUIMessage | ApprovalUIMessage;

type AgentEvent =
  | {
      kind: "assistant";
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
      message: string;
    }
  | {
      type: "approval";
      toolCallId: string;
      suggestionId: string;
      approved: boolean;
    };

const createMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Something went wrong while talking to the backend AI service.";
}

export default function AILogScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: true } },
  });

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);

  const isStreaming = status === "streaming";
  const sessionIdRef = useRef<string | null>(null);
  const pendingApprovalsRef = useRef(new Map<string, ResolvedApprovalSuggestion[]>());
  const loopRunningRef = useRef(false);

  const appendApprovedFoodToLog = (suggestion: ResolvedApprovalSuggestion) => {
    if (!me.$isLoaded) {
      return;
    }

    if (!me.root.logs) {
      me.root.$jazz.set("logs", []);
    }

    const meal = normalizeMeal(suggestion.meal) ?? "lunch";

    me.root.logs?.$jazz.push({
      meal,
      foodName: suggestion.food.name,
      brand: suggestion.food.brand,
      serving: suggestion.food.serving,
      portion: suggestion.portion,
      nutrition: cloneNutrition(suggestion.food.nutrition),
      createdAt: Date.now(),
    });
  };

  const ensureSessionId = async (currentUserId: string): Promise<string> => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    const response = await fetch(`${BACKEND_BASE_URL}/ai/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: currentUserId }),
    });

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
          : `Could not start AI session (${response.status}).`;
      throw new Error(message);
    }

    const sessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : "";

    if (!sessionId) {
      throw new Error("Backend did not return a valid AI session id.");
    }

    sessionIdRef.current = sessionId;
    return sessionId;
  };

  const requestTurn = async (
    currentUserId: string,
    action: AgentAction,
    retry = true,
  ): Promise<{ status: ChatStatus; events: AgentEvent[] }> => {
    const sessionId = await ensureSessionId(currentUserId);

    const response = await fetch(`${BACKEND_BASE_URL}/ai/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        userId: currentUserId,
        action,
      }),
    });

    const payload = (await response.json().catch(() => null)) as
      | {
          status?: unknown;
          events?: unknown;
          error?: unknown;
          message?: unknown;
        }
      | null;

    if (!response.ok) {
      if (response.status === 403 && retry) {
        sessionIdRef.current = null;
        return requestTurn(currentUserId, action, false);
      }

      const backendMessage =
        typeof payload?.message === "string"
          ? payload.message
          : typeof payload?.error === "string"
            ? payload.error
            : `AI request failed (${response.status}).`;
      throw new Error(backendMessage);
    }

    const nextStatus =
      payload?.status === "awaiting-approval" || payload?.status === "ready"
        ? payload.status
        : "ready";

    const events = Array.isArray(payload?.events) ? (payload.events as AgentEvent[]) : [];

    return {
      status: nextStatus,
      events,
    };
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
        if (event.kind === "assistant") {
          if (!event.text.trim()) {
            continue;
          }

          next.push({
            id: createMessageId(),
            kind: "text",
            role: "assistant",
            text: event.text,
          });
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

  const runAssistantAction = async (action: AgentAction) => {
    if (loopRunningRef.current) {
      return;
    }

    if (!userId) {
      setError("Missing authenticated user id. Sign in again and retry.");
      return;
    }

    loopRunningRef.current = true;
    let nextStatus: ChatStatus = "ready";

    try {
      setStatus("streaming");
      const result = await requestTurn(userId, action);
      applyAgentEvents(result.events);
      nextStatus = result.status;
    } catch (loopError) {
      setError(getErrorMessage(loopError));
      nextStatus = pendingApprovalsRef.current.size > 0 ? "awaiting-approval" : "ready";
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

    setError(null);
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

  const respondToApproval = async (toolCallId: string, suggestionId: string, approved: boolean) => {
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

    setError(null);
    await runAssistantAction({
      type: "approval",
      toolCallId,
      suggestionId,
      approved,
    });
  };

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading account…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        ref={scrollViewRef}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: insets.bottom + 96,
          },
        ]}
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

        {status === "awaiting-approval" ? (
          <View style={styles.awaitingCard}>
            <Text style={styles.awaitingText}>Approve or reject each suggestion to continue.</Text>
          </View>
        ) : null}

        {messages.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {"Try: \"I had a protein bar for breakfast\" or \"Find grilled chicken for lunch\""}
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
                      theme="light"
                      isComplete={!isActiveAssistantStream}
                      style={styles.assistantMarkdown}
                    >
                      {message.text}
                    </StreamdownRN>
                  )
                ) : (
                  <Text style={styles.typingText}>Thinking...</Text>
                )}
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
                    <Text key={food.resultId} style={styles.toolText}>
                      {food.resultId} • {food.name}
                      {food.brand ? ` • ${food.brand}` : ""}
                      {food.nutrition?.calories !== undefined
                        ? ` • ${formatCalories(food.nutrition.calories)} kcal`
                        : ""}
                    </Text>
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
                  const calories = (suggestion.food.nutrition?.calories ?? 0) * suggestion.portion;

                  return (
                    <View key={suggestion.suggestionId} style={styles.suggestionCard}>
                      <Text style={styles.toolText}>
                        {suggestion.food.name}
                        {suggestion.food.brand ? ` • ${suggestion.food.brand}` : ""}
                      </Text>
                      {suggestion.food.serving ? (
                        <Text style={styles.toolMeta}>{suggestion.food.serving}</Text>
                      ) : null}
                      <Text style={styles.toolMeta}>
                        {suggestion.resultId} • {formatPortionLabel(suggestion.portion)} to {mealLabel}
                      </Text>
                      <Text style={styles.toolMeta}>{`${formatCalories(calories)} kcal`}</Text>
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

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.composerContainer, { paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.composerCard}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Message the food assistant"
            placeholderTextColor={palette.secondaryLabel}
            style={styles.input}
            multiline
            maxLength={600}
            editable={Boolean(userId) && status === "ready"}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!userId || status !== "ready" || input.trim().length === 0}
            onPress={() => {
              void submitMessage();
            }}
            style={[
              styles.sendButton,
              (!userId || status !== "ready" || input.trim().length === 0) && styles.buttonDisabled,
            ]}
          >
            <Ionicons name="send" size={18} color={palette.buttonText} />
          </Pressable>
        </View>
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
  },
  awaitingText: {
    color: palette.secondaryLabel,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  emptyCard: {
    backgroundColor: palette.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 19,
    color: palette.secondaryLabel,
  },
  messageBubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    maxWidth: "92%",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: palette.userBubble,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: palette.assistantBubble,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
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
  typingText: {
    fontSize: 14,
    lineHeight: 18,
    color: palette.secondaryLabel,
    fontStyle: "italic",
  },
  toolCard: {
    borderRadius: 10,
    backgroundColor: palette.card,
    padding: 10,
    gap: 2,
  },
  suggestionCard: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.separator,
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
    marginBottom: 4,
    paddingHorizontal: 4,
    fontSize: 13,
    lineHeight: 18,
    color: palette.error,
  },
  composerContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: "rgba(255,255,255,0.4)",
  },
  composerCard: {
    backgroundColor: palette.card,
    borderRadius: 14,
    padding: 6,
    paddingLeft: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    borderRadius: 10,
    backgroundColor: palette.card,
    color: palette.label,
    paddingHorizontal: 6,
    paddingVertical: 8,
    fontSize: 16,
    lineHeight: 20,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  buttonDisabled: {
    backgroundColor: palette.tintDisabled,
  },
});

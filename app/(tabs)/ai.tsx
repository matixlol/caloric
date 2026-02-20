import { useRef, useState } from "react";
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
import { z } from "zod";
import { type SearchFood, searchFoods } from "../../src/food-search";
import { CaloricAccount } from "../../src/jazz/schema";
import { mealLabelFor, normalizeMeal } from "../../src/meals";
import { formatPortionLabel, sanitizePortion } from "../../src/portion";

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

const model = "moonshotai/kimi-k2-0905";
const systemPrompt = [
  "You are Caloric's food logging assistant.",
  "Always call searchFoods before suggesting a food entry.",
  "searchFoods returns local result IDs. Only reference those IDs later.",
  "Never send or edit nutrition/name/brand/serving in approval requests.",
  "When ready, call requestFoodApprovals once with one or more suggestions.",
  "Only set resultId, meal, portion, and reason in each suggestion.",
  "Portion should be in quarter increments (0.25).",
  "If the user rejects suggestions, explain briefly and search again.",
].join(" ");

const mealSchema = z.enum(["breakfast", "lunch", "dinner", "snacks"]);
const searchFoodsInputSchema = z.object({
  query: z.string().min(2),
  limit: z.number().int().min(1).max(10).default(6),
});
const approvalSuggestionSchema = z.object({
  resultId: z.string().min(1),
  meal: mealSchema.default("lunch"),
  portion: z.number().min(0.25).default(1),
  reason: z.string().min(1),
});
const approvalInputSchema = z.object({
  suggestions: z.array(approvalSuggestionSchema).min(1).max(8),
});

type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

type ChatStatus = "ready" | "streaming" | "awaiting-approval";

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

type SearchResultFood = {
  resultId: string;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: SearchFood["nutrition"];
};

type ResolvedApprovalSuggestion = {
  suggestionId: string;
  resultId: string;
  meal: z.infer<typeof mealSchema>;
  portion: number;
  reason: string;
  food: SearchResultFood;
  output?: ApprovalOutput;
};

type ApprovalUIMessage = {
  id: string;
  kind: "approval";
  toolCallId: string;
  suggestions: ResolvedApprovalSuggestion[];
};

type UIMessage = TextUIMessage | SearchUIMessage | ApprovalUIMessage;

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

type OpenRouterToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenRouterSsePayload = {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: OpenRouterToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
};

const openRouterTools = [
  {
    type: "function",
    function: {
      name: "searchFoods",
      description: "Search foods in the app food database.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "User query for food search.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max number of foods to return.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "requestFoodApprovals",
      description:
        "Request user approval for one or more selected food entries using local result IDs from searchFoods.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                resultId: { type: "string" },
                meal: {
                  type: "string",
                  enum: ["breakfast", "lunch", "dinner", "snacks"],
                },
                portion: { type: "number", minimum: 0.25 },
                reason: { type: "string" },
              },
              required: ["resultId", "meal", "portion", "reason"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
] as const;

const createMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function cloneNutrition(nutrition: SearchFood["nutrition"]) {
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

function parseToolArguments(raw: string): unknown {
  if (!raw || !raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Something went wrong while talking to OpenRouter.";
}

export default function AILogScreen() {
  const insets = useSafeAreaInsets();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: true } },
  });

  const openRouterApiKey = process.env.EXPO_PUBLIC_OPENROUTER_API_KEY?.trim() ?? "";
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);

  const hasApiKey = openRouterApiKey.length > 0;
  const isStreaming = status === "streaming";

  const conversationRef = useRef<OpenRouterMessage[]>([
    {
      role: "system",
      content: systemPrompt,
    },
  ]);
  const searchResultCounterRef = useRef(1);
  const searchResultsByLocalIdRef = useRef(new Map<string, SearchResultFood>());
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

  const streamAssistantTurn = async (assistantMessageId: string) => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        provider: {
          only: ["groq"],
          allow_fallbacks: false,
        },
        tool_choice: "auto",
        tools: openRouterTools,
        messages: conversationRef.current,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const bodySuffix = body ? `: ${body.slice(0, 280)}` : "";
      throw new Error(`OpenRouter request failed (${response.status})${bodySuffix}`);
    }

    let assistantText = "";
    const toolCallsByIndex = new Map<number, OpenRouterToolCall>();

    const appendAssistantChunk = (chunk: string) => {
      if (!chunk) {
        return;
      }

      assistantText += chunk;
      setMessages((current) =>
        current.map((message) =>
          message.kind === "text" && message.id === assistantMessageId
            ? {
                ...message,
                text: message.text + chunk,
              }
            : message,
        ),
      );
    };

    const mergeToolCallDelta = (deltaCall: OpenRouterToolCallDelta) => {
      const index = typeof deltaCall.index === "number" ? deltaCall.index : 0;
      const existing = toolCallsByIndex.get(index) ?? {
        id: "",
        type: "function",
        function: {
          name: "",
          arguments: "",
        },
      };

      const nextCall: OpenRouterToolCall = {
        id: deltaCall.id ?? existing.id,
        type: "function",
        function: {
          name: existing.function.name + (deltaCall.function?.name ?? ""),
          arguments: existing.function.arguments + (deltaCall.function?.arguments ?? ""),
        },
      };

      toolCallsByIndex.set(index, nextCall);
    };

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        return false;
      }

      const data = line.slice(5).trim();
      if (!data) {
        return false;
      }

      if (data === "[DONE]") {
        return true;
      }

      try {
        const parsed = JSON.parse(data) as OpenRouterSsePayload;
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        if (typeof delta?.content === "string") {
          appendAssistantChunk(delta.content);
        }

        if (Array.isArray(delta?.tool_calls)) {
          for (const deltaCall of delta.tool_calls) {
            mergeToolCallDelta(deltaCall);
          }
        }
      } catch {
        // Ignore malformed lines and continue parsing stream.
      }

      return false;
    };

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();

        if (streamDone) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let lineEnd = buffer.indexOf("\n");
        while (lineEnd !== -1) {
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);

          if (processLine(line)) {
            done = true;
            break;
          }

          lineEnd = buffer.indexOf("\n");
        }
      }

      if (!done && buffer.trim()) {
        processLine(buffer);
      }
    } else {
      const fullText = await response.text();
      for (const line of fullText.split("\n")) {
        if (processLine(line)) {
          break;
        }
      }
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, toolCall]) => toolCall)
      .filter((toolCall) => toolCall.id && toolCall.function.name);

    return {
      assistantText,
      toolCalls,
    };
  };

  const runToolCall = async (toolCall: OpenRouterToolCall) => {
    let rawArguments: unknown;
    try {
      rawArguments = parseToolArguments(toolCall.function.arguments);
    } catch {
      return {
        pauseForApproval: false,
        output: {
          error: "Tool arguments were invalid JSON.",
        },
      };
    }

    if (toolCall.function.name === "searchFoods") {
      const parsed = searchFoodsInputSchema.safeParse(rawArguments);
      if (!parsed.success) {
        return {
          pauseForApproval: false,
          output: {
            error: "Invalid searchFoods input.",
          },
        };
      }

      const limit = parsed.data.limit;
      const foods = await searchFoods(parsed.data.query, {
        maxItems: Math.min(20, Math.max(limit * 2, 8)),
      });
      const topFoods = foods.slice(0, limit);
      const foodsWithResultIds: SearchResultFood[] = topFoods.map((food) => {
        const resultId = `r${searchResultCounterRef.current}`;
        searchResultCounterRef.current += 1;
        const mappedFood: SearchResultFood = {
          resultId,
          name: food.name,
          brand: food.brand,
          serving: food.serving,
          nutrition: cloneNutrition(food.nutrition),
        };
        searchResultsByLocalIdRef.current.set(resultId, mappedFood);
        return mappedFood;
      });

      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "search",
          foods: foodsWithResultIds,
        },
      ]);

      return {
        pauseForApproval: false,
        output: {
          foods: foodsWithResultIds,
        },
      };
    }

    if (toolCall.function.name === "requestFoodApprovals") {
      const parsed = approvalInputSchema.safeParse(rawArguments);
      if (!parsed.success) {
        return {
          pauseForApproval: false,
          output: {
            error: "Invalid requestFoodApprovals input.",
          },
        };
      }

      const resolvedSuggestions: ResolvedApprovalSuggestion[] = [];
      const unknownResultIds: string[] = [];
      const seenSuggestions = new Set<string>();

      for (const suggestion of parsed.data.suggestions) {
        const resultId = suggestion.resultId.trim();
        const food = searchResultsByLocalIdRef.current.get(resultId);
        if (!food) {
          unknownResultIds.push(resultId || "(empty)");
          continue;
        }

        const meal = normalizeMeal(suggestion.meal) ?? "lunch";
        const portion = sanitizePortion(suggestion.portion);
        const reason = suggestion.reason.trim();
        if (!reason) {
          continue;
        }

        const duplicateKey = `${resultId}|${meal}|${portion}`;
        if (seenSuggestions.has(duplicateKey)) {
          continue;
        }
        seenSuggestions.add(duplicateKey);

        resolvedSuggestions.push({
          suggestionId: createMessageId(),
          resultId,
          meal,
          portion,
          reason,
          food,
        });
      }

      if (unknownResultIds.length > 0) {
        return {
          pauseForApproval: false,
          output: {
            error: `Unknown result IDs: ${unknownResultIds.slice(0, 5).join(", ")}`,
          },
        };
      }

      if (resolvedSuggestions.length === 0) {
        return {
          pauseForApproval: false,
          output: {
            error: "No valid suggestions to approve.",
          },
        };
      }

      pendingApprovalsRef.current.set(toolCall.id, resolvedSuggestions);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "approval",
          toolCallId: toolCall.id,
          suggestions: resolvedSuggestions,
        },
      ]);

      return {
        pauseForApproval: true,
        output: null,
      };
    }

    return {
      pauseForApproval: false,
      output: {
        error: `Unknown tool: ${toolCall.function.name}`,
      },
    };
  };

  const runAssistantLoop = async () => {
    if (loopRunningRef.current) {
      return;
    }

    loopRunningRef.current = true;
    let nextStatus: ChatStatus = "ready";

    try {
      for (let step = 0; step < 8; step += 1) {
        setStatus("streaming");

        const assistantMessageId = createMessageId();
        setMessages((current) => [
          ...current,
          {
            id: assistantMessageId,
            kind: "text",
            role: "assistant",
            text: "",
          },
        ]);

        const turn = await streamAssistantTurn(assistantMessageId);

        if (!turn.assistantText.trim()) {
          setMessages((current) =>
            current.filter(
              (message) =>
                !(
                  message.kind === "text" &&
                  message.id === assistantMessageId &&
                  message.role === "assistant" &&
                  !message.text.trim()
                ),
            ),
          );
        }

        conversationRef.current.push({
          role: "assistant",
          content: turn.assistantText.trim() ? turn.assistantText : null,
          ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
        });

        if (turn.toolCalls.length === 0) {
          nextStatus = "ready";
          return;
        }

        for (const toolCall of turn.toolCalls) {
          const toolResult = await runToolCall(toolCall);

          if (toolResult.pauseForApproval) {
            nextStatus = "awaiting-approval";
            return;
          }

          conversationRef.current.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult.output ?? {}),
          });
        }
      }

      nextStatus = "ready";
    } catch (loopError) {
      setError(getErrorMessage(loopError));
      nextStatus = "ready";
    } finally {
      loopRunningRef.current = false;
      setStatus(nextStatus);
    }
  };

  const submitMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || !hasApiKey || status !== "ready") {
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

    conversationRef.current.push({
      role: "user",
      content: trimmed,
    });

    await runAssistantLoop();
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

    const allResolved = nextSuggestions.every((suggestion) => Boolean(suggestion.output));
    if (!allResolved) {
      pendingApprovalsRef.current.set(toolCallId, nextSuggestions);
      setStatus("awaiting-approval");
      return;
    }

    pendingApprovalsRef.current.delete(toolCallId);
    conversationRef.current.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: JSON.stringify({
        decisions: nextSuggestions.map((suggestion) => ({
          suggestionId: suggestion.suggestionId,
          resultId: suggestion.resultId,
          meal: suggestion.meal,
          portion: suggestion.portion,
          approved: suggestion.output?.approved ?? false,
          reason: suggestion.output?.reason,
        })),
      }),
    });

    setError(null);
    await runAssistantLoop();
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

        {!hasApiKey ? (
          <View style={styles.warningCard}>
            <Text style={styles.warningText}>
              Add `EXPO_PUBLIC_OPENROUTER_API_KEY` to your `.env` file to enable AI logging.
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
            editable={hasApiKey && status === "ready"}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!hasApiKey || status !== "ready" || input.trim().length === 0}
            onPress={() => {
              void submitMessage();
            }}
            style={[
              styles.sendButton,
              (!hasApiKey || status !== "ready" || input.trim().length === 0) &&
                styles.buttonDisabled,
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

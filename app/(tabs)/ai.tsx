import { useRef, useState } from "react";
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
import { z } from "zod";
import { type SearchFood, searchFoods } from "../../src/food-search";
import { CaloricAccount } from "../../src/jazz/schema";
import { mealLabelFor, normalizeMeal } from "../../src/meals";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  userBubble: "#2563EB",
  assistantBubble: iosColor("secondarySystemFill", "#E5E7EB"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
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
  "Never invent nutrition values. Use only values returned by searchFoods.",
  "After selecting the best candidate, call requestFoodApproval exactly once.",
  "If the user rejects the suggestion, explain briefly and search again.",
].join(" ");

const mealSchema = z.enum(["breakfast", "lunch", "dinner", "snacks"]);
const searchFoodsInputSchema = z.object({
  query: z.string().min(2),
  limit: z.number().int().min(1).max(10).default(6),
});
const approvalInputSchema = z.object({
  foodId: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().optional(),
  serving: z.string().optional(),
  meal: mealSchema.default("lunch"),
  portion: z.number().min(0.1).max(5).default(1),
  nutrition: z
    .object({
      calories: z.number().optional(),
      protein: z.number().optional(),
      carbs: z.number().optional(),
      fat: z.number().optional(),
      fiber: z.number().optional(),
      sugars: z.number().optional(),
      sodiumMg: z.number().optional(),
      potassiumMg: z.number().optional(),
    })
    .optional(),
  reason: z.string().min(1),
});

type ApprovalInput = z.infer<typeof approvalInputSchema>;
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
  foods: SearchFood[];
};

type ApprovalUIMessage = {
  id: string;
  kind: "approval";
  toolCallId: string;
  input: ApprovalInput;
  output?: ApprovalOutput;
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
      name: "requestFoodApproval",
      description:
        "Request user approval for a single selected food entry before logging it.",
      parameters: {
        type: "object",
        properties: {
          foodId: { type: "string" },
          name: { type: "string" },
          brand: { type: "string" },
          serving: { type: "string" },
          meal: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snacks"],
          },
          portion: { type: "number", minimum: 0.1, maximum: 5 },
          nutrition: {
            type: "object",
            properties: {
              calories: { type: "number" },
              protein: { type: "number" },
              carbs: { type: "number" },
              fat: { type: "number" },
              fiber: { type: "number" },
              sugars: { type: "number" },
              sodiumMg: { type: "number" },
              potassiumMg: { type: "number" },
            },
          },
          reason: { type: "string" },
        },
        required: ["foodId", "name", "meal", "portion", "reason"],
      },
    },
  },
] as const;

const createMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

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
  const pendingApprovalsRef = useRef(new Map<string, ApprovalInput>());
  const loopRunningRef = useRef(false);

  const appendApprovedFoodToLog = (approvalInput: ApprovalInput) => {
    if (!me.$isLoaded) {
      return;
    }

    if (!me.root.logs) {
      me.root.$jazz.set("logs", []);
    }

    const meal = normalizeMeal(approvalInput.meal) ?? "lunch";

    me.root.logs?.$jazz.push({
      meal,
      foodName: approvalInput.name,
      brand: approvalInput.brand,
      serving: approvalInput.serving,
      portion: approvalInput.portion,
      nutrition: approvalInput.nutrition
        ? {
            calories: approvalInput.nutrition.calories,
            protein: approvalInput.nutrition.protein,
            carbs: approvalInput.nutrition.carbs,
            fat: approvalInput.nutrition.fat,
            fiber: approvalInput.nutrition.fiber,
            sugars: approvalInput.nutrition.sugars,
            sodiumMg: approvalInput.nutrition.sodiumMg,
            potassiumMg: approvalInput.nutrition.potassiumMg,
          }
        : undefined,
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

      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "search",
          foods: topFoods,
        },
      ]);

      return {
        pauseForApproval: false,
        output: {
          foods: topFoods,
        },
      };
    }

    if (toolCall.function.name === "requestFoodApproval") {
      const parsed = approvalInputSchema.safeParse(rawArguments);
      if (!parsed.success) {
        return {
          pauseForApproval: false,
          output: {
            approved: false,
            reason: "Invalid requestFoodApproval input.",
          },
        };
      }

      pendingApprovalsRef.current.set(toolCall.id, parsed.data);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          kind: "approval",
          toolCallId: toolCall.id,
          input: parsed.data,
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

  const respondToApproval = async (toolCallId: string, approved: boolean) => {
    if (status === "streaming") {
      return;
    }

    const inputForApproval = pendingApprovalsRef.current.get(toolCallId);
    if (!inputForApproval) {
      return;
    }

    pendingApprovalsRef.current.delete(toolCallId);

    if (approved) {
      appendApprovedFoodToLog(inputForApproval);
    }

    const output: ApprovalOutput = {
      approved,
      reason: approved ? undefined : "User rejected this suggestion.",
    };

    setMessages((current) =>
      current.map((message) =>
        message.kind === "approval" && message.toolCallId === toolCallId
          ? {
              ...message,
              output,
            }
          : message,
      ),
    );

    conversationRef.current.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: JSON.stringify(output),
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
          Ask for a food, review the suggestion, then approve to add it to your log.
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
            <Text style={styles.awaitingText}>Choose approve or reject to continue.</Text>
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
          if (message.kind === "text") {
            const isUser = message.role === "user";
            const text = message.text.trim();

            return (
              <View
                key={message.id}
                style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}
              >
                {text ? (
                  <Text style={[styles.messageText, isUser && styles.userMessageText]}>{message.text}</Text>
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
                  {message.foods.slice(0, 3).map((food) => (
                    <Text key={food.id} style={styles.toolText}>
                      {food.name}
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

          const selectedMeal = normalizeMeal(message.input.meal) ?? "lunch";
          const mealLabel = mealLabelFor(selectedMeal);

          return (
            <View key={message.id} style={[styles.messageBubble, styles.assistantBubble]}>
              <View style={styles.toolCard}>
                <Text style={styles.toolHeading}>Approve this log?</Text>
                <Text style={styles.toolText}>
                  {message.input.name}
                  {message.input.brand ? ` • ${message.input.brand}` : ""}
                </Text>
                {message.input.serving ? <Text style={styles.toolMeta}>{message.input.serving}</Text> : null}
                <Text style={styles.toolMeta}>
                  {formatCalories(message.input.nutrition?.calories)} kcal to {mealLabel}
                </Text>
                <Text style={styles.toolReason}>{message.input.reason}</Text>

                {message.output ? (
                  <Text
                    style={[
                      styles.toolMeta,
                      message.output.approved ? styles.approvedText : styles.rejectedText,
                    ]}
                  >
                    {message.output.approved
                      ? "Approved and logged."
                      : message.output.reason ?? "Rejected. Ask for another option."}
                  </Text>
                ) : (
                  <View style={styles.approvalRow}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isStreaming}
                      onPress={() => {
                        void respondToApproval(message.toolCallId, true);
                      }}
                      style={[styles.approveButton, isStreaming && styles.buttonDisabled]}
                    >
                      <Text style={styles.approveButtonText}>Approve</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isStreaming}
                      onPress={() => {
                        void respondToApproval(message.toolCallId, false);
                      }}
                      style={[styles.denyButton, isStreaming && styles.buttonDisabled]}
                    >
                      <Text style={styles.denyButtonText}>Reject</Text>
                    </Pressable>
                  </View>
                )}
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
          <View style={styles.composerActions}>
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
              <Text style={styles.sendButtonText}>Send</Text>
            </Pressable>
          </View>
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
    padding: 10,
    gap: 8,
  },
  input: {
    minHeight: 44,
    maxHeight: 140,
    borderRadius: 10,
    backgroundColor: palette.background,
    color: palette.label,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 20,
  },
  composerActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  sendButton: {
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  sendButtonText: {
    color: palette.buttonText,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
  },
  buttonDisabled: {
    backgroundColor: palette.tintDisabled,
  },
});

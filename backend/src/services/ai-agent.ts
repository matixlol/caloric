import {
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { createAiMessageId } from "../id";
import { mealValues, type AiSessionState, type ResolvedApprovalSuggestion } from "./ai-store";
import type { AgentEvent } from "./ai-turns";
import type { SearchResultFood } from "./search";

type FoodSearchResult = Omit<SearchResultFood, "resultId">;

// The model-agnostic agent loop. The HTTP layer (ai.ts) and the offline
// evaluation harness both drive it, so a model can be compared on exactly the
// prompts, tools and validation that production uses.

export type AssistantModel = {
  id: string;
  model: LanguageModel;
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
  telemetry?: Record<string, string>;
};

export type StepUsage = { inputTokens: number; outputTokens: number; costUsd?: number };

export type FoodSearch = (query: string, limit: number, signal?: AbortSignal) => Promise<FoodSearchResult[]>;

const MealSchema = z.enum(mealValues);
type SessionToolCall = {
  toolCallId: string;
  toolName: ToolName;
  input: unknown;
};

const SearchFoodsToolArgsSchema = z.object({
  query: z.string().trim().min(2),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

const ApprovalSuggestionInputSchema = z.object({
  resultId: z.string().trim().min(1),
  meal: z
    .string()
    .trim()
    .transform((value) => {
      const parsed = MealSchema.safeParse(value.toLowerCase());
      return parsed.success ? parsed.data : "lunch";
    }),
  portion: z.coerce
    .number()
    .finite()
    .catch(1)
    .transform((value) => Math.round(Math.max(0.25, value) * 4) / 4),
  reason: z.string().trim().min(1),
});

const RequestFoodApprovalsToolArgsSchema = z.object({
  suggestions: z.array(ApprovalSuggestionInputSchema).min(1).max(8),
});

const aiSdkTools = {
  searchFoods: tool({
    description: "Search foods in the app food database.",
    inputSchema: SearchFoodsToolArgsSchema,
  }),
  requestFoodApprovals: tool({
    description:
      "Request user approval for one or more selected food entries using local result IDs from searchFoods. This renders interactive suggestions in the app and ends the current turn.",
    inputSchema: RequestFoodApprovalsToolArgsSchema,
  }),
} as const;

type ToolName = keyof typeof aiSdkTools;

export const assistantToolCount = Object.keys(aiSdkTools).length;

export const systemPrompt = [
  "You are Caloric's food logging assistant.",
  "Always call searchFoods before suggesting a food entry.",
  "searchFoods returns local result IDs. Only reference those IDs later.",
  "Never send or edit nutrition/name/brand/serving in approval requests.",
  "When ready, call requestFoodApprovals once with one or more suggestions.",
  "Calling requestFoodApprovals ends your turn.",
  "The app handles approval and rejection locally. Do not expect approval results or react to approval clicks.",
  "Only set resultId, meal, portion, and reason in each suggestion.",
  "Portion should be in quarter increments (0.25).",
  "If the user sends audio, understand it directly from the audio input instead of talking about transcription.",
  "Before searching, silently make a checklist of every requested food, explicit brand or variant, meal, and quantity.",
  "Search every checklist item using the user's exact brand and variant terms.",
  "Reject implausible matches, such as a normal single slice, egg, glass of milk, or ordinary serving with clearly impossible calories or macros, and search again.",
  "If the exact variant is unavailable, prefer a plausible generic match over a conflicting brand or variant.",
  "Before requesting approval, verify that every requested food appears exactly once, explicit meal buckets are preserved, no unmentioned foods were added, and each portion correctly converts the requested amount into the selected entry's serving units.",
  "When you answer, keep the wording concise and practical.",
  "Users may attach photos of meals, plates, nutrition labels, packaging, or menus, with or without text or audio.",
  "For a meal photo, identify each distinct food and estimate its amount from visual cues such as plate size, utensils, and packaging; state the estimate briefly in each suggestion's reason.",
  "For a nutrition label or package, read the brand, product name, and serving size and search for that exact product.",
  "If a photo shows no food or is too unclear to estimate, ask one short clarifying question instead of guessing.",
  "Never output raw transcripts, timestamps, or internal reasoning. Reply in the user's language.",
  // The two-step shape (all searches at once, then approvals) cuts model round
  // trips, which dominate latency on reasoning models.
  "Speed matters: in your first reply, call searchFoods once for every item at the same time (parallel tool calls), then call requestFoodApprovals in your next reply.",
  "Only search again when every result for an item is clearly wrong.",
].join(" ");

function createToolResultMessage(toolCall: SessionToolCall, value: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: {
          type: "json",
          value: value as JSONValue,
        },
      },
    ],
  };
}

// Models sometimes print a tool call as text ("call:default_api:searchFoods{…}")
// or leak a thought header instead of calling the function.
const leakedToolCallPattern = /default_api[:.]|^\s*(call:|thought\b|<thought|model\s*\n)/i;
const leakDetectionChars = 24;

const repairNudge: ModelMessage = {
  role: "user",
  content:
    "(Automatic note from the app, not the user.) Your previous reply was not delivered: it printed a tool call as text or stopped without suggesting foods. Continue the task by calling the tools through function calling. Only reply with text if you genuinely need to ask the user something.",
};

async function requestAiSdkTurn(
  session: AiSessionState,
  assistant: AssistantModel,
  options?: {
    onAssistantDelta?: (text: string) => void;
    signal?: AbortSignal;
    nudge?: boolean;
    onUsage?: (usage: StepUsage) => void;
  },
): Promise<{
  assistantText: string;
  leaked: boolean;
  toolCalls: SessionToolCall[];
  responseMessages: ModelMessage[];
}> {
  const result = streamText({
    model: assistant.model,
    messages: options?.nudge ? [...session.conversation, repairNudge] : session.conversation,
    tools: aiSdkTools,
    abortSignal: options?.signal,
    providerOptions: assistant.providerOptions,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "backend.ai.turn",
      metadata: {
        sessionId: session.id,
        messageCount: session.conversation.length,
        toolCount: assistantToolCount,
        ...assistant.telemetry,
      },
    },
  });

  let assistantText = "";
  let leaked = false;
  // Hold the first characters back until they can be classified so a leaked
  // tool call never reaches the client.
  let released = false;

  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta" && chunk.text) {
      assistantText += chunk.text;
      if (released) {
        if (!leaked) options?.onAssistantDelta?.(chunk.text);
      } else if (assistantText.trim().length >= leakDetectionChars) {
        released = true;
        leaked = leakedToolCallPattern.test(assistantText);
        if (!leaked) options?.onAssistantDelta?.(assistantText);
      }
    }
  }

  if (!released) {
    leaked = leakedToolCallPattern.test(assistantText);
    if (!leaked && assistantText) options?.onAssistantDelta?.(assistantText);
  }

  const response = await result.response;
  if (options?.onUsage) {
    const [usage, metadata] = await Promise.all([result.usage, result.providerMetadata]);
    const cost = (metadata?.openrouter as { usage?: { cost?: number } } | undefined)?.usage?.cost;
    options.onUsage({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costUsd: typeof cost === "number" ? cost : undefined });
  }
  const toolCalls: SessionToolCall[] = [];
  for (const toolCall of await result.toolCalls) {
    if (!(toolCall.toolName in aiSdkTools)) {
      continue;
    }

    toolCalls.push({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName as ToolName,
      input: toolCall.input,
    });
  }

  return {
    assistantText,
    leaked: leaked || (toolCalls.length === 0 && leakedToolCallPattern.test(assistantText)),
    toolCalls,
    responseMessages: response.messages,
  };
}

async function runToolCall(
  session: AiSessionState,
  toolCall: SessionToolCall,
  search: FoodSearch,
  signal?: AbortSignal,
): Promise<{ stopAfterTool: boolean; output: unknown; events: AgentEvent[] }> {
  if (toolCall.toolName === "searchFoods") {
    const parsedArgs = SearchFoodsToolArgsSchema.safeParse(toolCall.input);
    if (!parsedArgs.success) {
      return {
        stopAfterTool: false,
        output: {
          error: "Invalid searchFoods input.",
        },
        events: [],
      };
    }

    const limit = parsedArgs.data.limit ?? 6;
    const topFoods = await search(parsedArgs.data.query, limit, signal);
    const foodsWithResultIds: SearchResultFood[] = topFoods.map((food) => {
      const resultId = `r${session.searchResultCounter}`;
      session.searchResultCounter += 1;

      const mapped: SearchResultFood = {
        ...food,
        resultId,
      };

      session.searchResultsByLocalId[resultId] = mapped;
      return mapped;
    });

    return {
      stopAfterTool: false,
      output: {
        foods: foodsWithResultIds,
      },
      events: [
        {
          kind: "search",
          query: parsedArgs.data.query,
          foods: foodsWithResultIds,
        },
      ],
    };
  }

  if (toolCall.toolName === "requestFoodApprovals") {
    const parsedArgs = RequestFoodApprovalsToolArgsSchema.safeParse(toolCall.input);
    if (!parsedArgs.success) {
      return {
        stopAfterTool: false,
        output: {
          error: "Invalid requestFoodApprovals input.",
        },
        events: [],
      };
    }

    const resolvedSuggestions: ResolvedApprovalSuggestion[] = [];
    const unknownResultIds: string[] = [];
    const seenSuggestions = new Set<string>();

    for (const suggestion of parsedArgs.data.suggestions) {
      const food = session.searchResultsByLocalId[suggestion.resultId];
      if (!food) {
        unknownResultIds.push(suggestion.resultId);
        continue;
      }

      const duplicateKey = `${suggestion.resultId}|${suggestion.meal}|${suggestion.portion}`;
      if (seenSuggestions.has(duplicateKey)) {
        continue;
      }

      seenSuggestions.add(duplicateKey);
      resolvedSuggestions.push({
        suggestionId: createAiMessageId(),
        resultId: suggestion.resultId,
        meal: suggestion.meal,
        portion: suggestion.portion,
        reason: suggestion.reason,
        food,
      });
    }

    if (unknownResultIds.length > 0) {
      return {
        stopAfterTool: false,
        output: {
          error: `Unknown result IDs: ${unknownResultIds.slice(0, 5).join(", ")}`,
        },
        events: [],
      };
    }

    if (resolvedSuggestions.length === 0) {
      return {
        stopAfterTool: false,
        output: {
          error: "No valid suggestions to approve.",
        },
        events: [],
      };
    }

    return {
      stopAfterTool: true,
      output: {
        displayed: true,
        suggestionCount: resolvedSuggestions.length,
        note: "Suggestions are visible in the app. Approval and rejection stay local to the client.",
      },
      events: [
        {
          kind: "approval",
          toolCallId: toolCall.toolCallId,
          suggestions: resolvedSuggestions,
        },
      ],
    };
  }

  return {
    stopAfterTool: false,
    output: {
      error: `Unknown tool: ${toolCall.toolName}`,
    },
    events: [],
  };
}

export async function runAssistantLoop(
  session: AiSessionState,
  options: {
    assistant: AssistantModel;
    search: FoodSearch;
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    // Token usage and, for OpenRouter, billed cost of every model call.
    onUsage?: (usage: StepUsage) => void;
  },
): Promise<void> {
  const emit = (event: AgentEvent) => {
    options.onEvent?.(event);
  };
  let repairs = 0;
  let nudge = false;
  let searched = false;

  for (let step = 0; step < 8; step += 1) {
    const turn = await requestAiSdkTurn(session, options.assistant, {
      nudge,
      onUsage: options.onUsage,
      signal: options.signal,
      onAssistantDelta: (text) => {
        if (!text) {
          return;
        }

        emit({
          kind: "assistant-delta",
          text,
        });
      },
    });

    // Retry a step (at most twice) when the model leaks a tool call as text or
    // stops silently after searching instead of suggesting foods.
    const stalled = turn.toolCalls.length === 0 && (turn.leaked || (searched && !turn.assistantText.trim()));
    if (stalled && repairs < 2) {
      repairs += 1;
      nudge = true;
      continue;
    }
    nudge = false;

    if (turn.assistantText.trim() && !turn.leaked) {
      emit({
        kind: "assistant",
        text: turn.assistantText,
      });
    }

    session.conversation.push(...turn.responseMessages);

    if (turn.toolCalls.length === 0) {
      return;
    }

    // Start every search of a step at once. Result IDs are still assigned in
    // tool-call order, so the transcript is the same as running them in turn.
    const prefetched = new Map<string, Promise<FoodSearchResult[]>>();
    for (const toolCall of turn.toolCalls) {
      const parsedArgs = toolCall.toolName === "searchFoods" ? SearchFoodsToolArgsSchema.safeParse(toolCall.input) : null;
      if (!parsedArgs?.success) continue;
      const pending = options.search(parsedArgs.data.query, parsedArgs.data.limit ?? 6, options.signal);
      // Observed below in order; this only silences calls skipped after an approval.
      pending.catch(() => {});
      prefetched.set(toolCall.toolCallId, pending);
    }

    for (const toolCall of turn.toolCalls) {
      searched ||= toolCall.toolName === "searchFoods";
      const search: FoodSearch = (query, limit, signal) => prefetched.get(toolCall.toolCallId) ?? options.search(query, limit, signal);
      const toolResult = await runToolCall(session, toolCall, search, options.signal);
      for (const event of toolResult.events) {
        emit(event);
      }

      session.conversation.push(createToolResultMessage(toolCall, toolResult.output ?? null));

      if (toolResult.stopAfterTool) {
        return;
      }
    }
  }
}

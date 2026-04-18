import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";
import { buildRecentLogContextPrompt, parseRecentLogHints } from "../ai-log-context";
import { config } from "../config";
import { isObjectRecord, jsonResponse, requireAuthenticatedUser } from "../http";
import { createAiMessageId, createAiSessionId } from "../id";
import { logError, summarizeText } from "../logging";
import { Sentry } from "../lib/sentry";
import { searchUnifiedFoods, type SearchResultFood } from "./search";

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenRouterContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "input_audio";
      input_audio: {
        data: string;
        format: string;
      };
    };

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenRouterContentPart[] | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

const MealSchema = z.enum(["breakfast", "lunch", "dinner", "snacks"]);

type Meal = z.infer<typeof MealSchema>;

type ApprovalOutput = {
  approved: boolean;
  reason?: string;
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

type AgentStatus = "ready" | "awaiting-approval";

type AgentSession = {
  id: string;
  userId: string;
  conversation: OpenRouterMessage[];
  searchResultCounter: number;
  searchResultsByLocalId: Map<string, SearchResultFood>;
  pendingApprovals: Map<string, ResolvedApprovalSuggestion[]>;
  updatedAt: number;
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

const UserMessageActionSchema = z.object({
  type: z.literal("user-message"),
  message: z.string().trim().optional(),
});

const ApprovalActionSchema = z.object({
  type: z.literal("approval"),
  toolCallId: z.string().trim().min(1),
  suggestionId: z.string().trim().min(1),
  approved: z.boolean(),
});

const JsonActionSchema = z.discriminatedUnion("type", [UserMessageActionSchema, ApprovalActionSchema]);

type AgentAction = z.infer<typeof JsonActionSchema>;
type UserMessageAction = z.infer<typeof UserMessageActionSchema>;
type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

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

const systemPrompt = [
  "You are Caloric's food logging assistant.",
  "Always call searchFoods before suggesting a food entry.",
  "searchFoods returns local result IDs. Only reference those IDs later.",
  "Never send or edit nutrition/name/brand/serving in approval requests.",
  "When ready, call requestFoodApprovals once with one or more suggestions.",
  "Only set resultId, meal, portion, and reason in each suggestion.",
  "Portion should be in quarter increments (0.25).",
  "If the user rejects suggestions, explain briefly and search again.",
  "If the user sends audio, understand it directly from the audio input instead of talking about transcription.",
  "When you answer, keep the wording concise and practical.",
].join(" ");

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

const aiSessions = new Map<string, AgentSession>();
const maxAiSessionIdleMs = 1000 * 60 * 60 * 8;

type SseWriter = {
  writeEvent: (event: AgentEvent) => void;
  writeResolvedUserMessage: (message: string) => void;
  writeStatus: (status: AgentStatus) => void;
  writeError: (code: string, message: string) => void;
};

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function captureUnknownError(code: string, error: unknown): void {
  const errorForCapture =
    error instanceof Error ? error : new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
  });

  logError(`api.${code}`, errorForCapture);
  Sentry.captureException(errorForCapture);
}

function reportUnknownError(code: string, error: unknown): Response {
  captureUnknownError(code, error);

  return jsonResponse(
    {
      error: code,
      message: "Unknown error.",
    },
    502,
  );
}

function encodeSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createSseResponse(run: (writer: SseWriter) => Promise<void>, errorCode: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const writeChunk = (chunk: string) => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(chunk));
      };

      const writer: SseWriter = {
        writeEvent(event) {
          writeChunk(
            encodeSseChunk({
              type: "event",
              event,
            }),
          );
        },
        writeResolvedUserMessage(message) {
          writeChunk(
            encodeSseChunk({
              type: "resolved-user-message",
              resolvedUserMessage: message,
            }),
          );
        },
        writeStatus(status) {
          writeChunk(
            encodeSseChunk({
              type: "status",
              status,
            }),
          );
        },
        writeError(code, message) {
          writeChunk(
            encodeSseChunk({
              type: "error",
              error: code,
              message,
            }),
          );
        },
      };

      try {
        await run(writer);
      } catch (error) {
        captureUnknownError(errorCode, error);
        writer.writeError(errorCode, "Unknown error.");
      } finally {
        if (!closed) {
          writeChunk("data: [DONE]\n\n");
          closed = true;
          controller.close();
        }
      }
    },
  });

  return new Response(stream, { headers: sseHeaders });
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function createMessageId(): string {
  return createAiMessageId();
}

function normalizeOpenRouterUserId(userId: string): string {
  return userId.slice(0, 128);
}

function pruneOldAiSessions(now = Date.now()) {
  for (const [sessionId, session] of aiSessions) {
    if (now - session.updatedAt > maxAiSessionIdleMs) {
      aiSessions.delete(sessionId);
    }
  }
}

function requireSessionOwner(sessionId: string, userId: string): AgentSession | null {
  const session = aiSessions.get(sessionId);
  if (!session || session.userId !== userId) {
    return null;
  }

  return session;
}

function parseOpenRouterText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isObjectRecord(part) || typeof part.text !== "string") {
        return "";
      }

      return part.text;
    })
    .join("");
}

function parseOpenRouterToolCalls(raw: unknown): OpenRouterToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const output: OpenRouterToolCall[] = [];

  for (const candidate of raw) {
    if (!isObjectRecord(candidate) || candidate.type !== "function" || !isObjectRecord(candidate.function)) {
      continue;
    }

    const idValue = candidate.id;
    const id =
      typeof idValue === "string"
        ? idValue.trim()
        : typeof idValue === "number" && Number.isFinite(idValue)
          ? String(idValue)
          : "";

    const nameValue = candidate.function.name;
    const name =
      typeof nameValue === "string"
        ? nameValue.trim()
        : typeof nameValue === "number" && Number.isFinite(nameValue)
          ? String(nameValue)
          : "";

    if (!id || !name) {
      continue;
    }

    const argumentsValue = candidate.function.arguments;
    const args =
      typeof argumentsValue === "string"
        ? argumentsValue
        : argumentsValue === undefined
          ? ""
          : JSON.stringify(argumentsValue);

    output.push({
      id,
      type: "function",
      function: {
        name,
        arguments: args,
      },
    });
  }

  return output;
}

function parseToolCallDeltas(raw: unknown): Array<{ index: number; toolCall: OpenRouterToolCall }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const byIndex = new Map<number, OpenRouterToolCall>();

  for (const candidate of raw) {
    if (!isObjectRecord(candidate) || !Number.isInteger(candidate.index)) {
      continue;
    }

    const index = candidate.index as number;
    const existing = byIndex.get(index) ?? {
      id:
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `tool-${index}`,
      type: "function" as const,
      function: {
        name: "",
        arguments: "",
      },
    };

    if (typeof candidate.id === "string" && candidate.id.trim()) {
      existing.id = candidate.id.trim();
    }

    if (isObjectRecord(candidate.function)) {
      if (typeof candidate.function.name === "string" && candidate.function.name.trim()) {
        existing.function.name = candidate.function.name.trim();
      }

      const argumentsValue = candidate.function.arguments;
      if (typeof argumentsValue === "string") {
        existing.function.arguments += argumentsValue;
      } else if (argumentsValue !== undefined) {
        existing.function.arguments += JSON.stringify(argumentsValue);
      }
    }

    byIndex.set(index, existing);
  }

  return Array.from(byIndex.entries())
    .filter(([, toolCall]) => toolCall.function.name.length > 0)
    .map(([index, toolCall]) => ({ index, toolCall }));
}

function normalizeAudioFormat(value: string | undefined): string {
  const normalized = (value ?? "m4a").trim().toLowerCase();

  if (normalized === "mpeg" || normalized === "mpga") {
    return "mp3";
  }

  if (["wav", "mp3", "aiff", "aac", "ogg", "flac", "m4a", "pcm16", "pcm24"].includes(normalized)) {
    return normalized;
  }

  return "m4a";
}

async function encodeAudioFileForOpenRouter(audioFile: File): Promise<{ data: string; format: string }> {
  if (audioFile.size <= 0) {
    throw new Error("Audio snippet was empty.");
  }

  if (audioFile.size > 12 * 1024 * 1024) {
    throw new Error("Audio snippet is too large (max 12 MB).");
  }

  const bytes = new Uint8Array(await audioFile.arrayBuffer());
  const data = Buffer.from(bytes).toString("base64");
  const typeFormat = audioFile.type.split("/").at(1);
  const nameFormat = audioFile.name.split(".").at(-1);

  return {
    data,
    format: normalizeAudioFormat(typeFormat ?? nameFormat ?? undefined),
  };
}

async function requestOpenRouterTurn(
  session: AgentSession,
  options?: {
    onAssistantDelta?: (text: string) => void;
    signal?: AbortSignal;
  },
): Promise<{
  assistantText: string;
  toolCalls: OpenRouterToolCall[];
}> {
  const providerOnly = config.openRouterProviderOnly?.trim() ?? "";
  const requestBody: Record<string, unknown> = {
    model: config.openRouterModel,
    stream: true,
    tool_choice: "auto",
    tools: openRouterTools,
    messages: session.conversation,
    user: normalizeOpenRouterUserId(session.userId),
    session_id: session.id,
  };

  requestBody.provider = providerOnly
    ? {
        only: [providerOnly],
        allow_fallbacks: true,
        sort: "throughput",
      }
    : {
        sort: "throughput",
      };

  return Sentry.startSpan(
    {
      name: "openrouter.chat.completions",
      op: "ai.client",
      attributes: {
        "server.address": "openrouter.ai",
        "http.request.method": "POST",
        "url.full": "https://openrouter.ai/api/v1/chat/completions",
        "gen_ai.system": "openrouter",
        "gen_ai.request.model": config.openRouterModel,
        "app.ai.message_count": session.conversation.length,
        "app.ai.tool_count": openRouterTools.length,
        "app.ai.provider.only": providerOnly || undefined,
      },
    },
    async (span) => {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      });

      span.setAttribute("http.response.status_code", response.status);

      if (!response.ok) {
        const textBody = await response.text();
        const suffix = textBody ? `: ${textBody.slice(0, 300)}` : "";
        throw new Error(`OpenRouter request failed (${response.status})${suffix}`);
      }

      if (!response.body) {
        throw new Error("OpenRouter response was not streamable.");
      }

      let assistantText = "";
      let messageTextFallback = "";
      const toolCallsByIndex = new Map<number, OpenRouterToolCall>();
      const eventStream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());

      for await (const event of eventStream) {
        const chunk = event.data;
        if (!chunk || chunk === "[DONE]") {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(chunk);
        } catch {
          continue;
        }

        if (!isObjectRecord(parsed) || !Array.isArray(parsed.choices)) {
          continue;
        }

        const firstChoice = parsed.choices[0];
        if (!isObjectRecord(firstChoice)) {
          continue;
        }

        const delta = isObjectRecord(firstChoice.delta) ? firstChoice.delta : null;
        const textDelta = parseOpenRouterText(delta?.content);
        if (textDelta) {
          assistantText += textDelta;
          options?.onAssistantDelta?.(textDelta);
        }

        for (const { index, toolCall } of parseToolCallDeltas(delta?.tool_calls)) {
          const existing = toolCallsByIndex.get(index);
          if (!existing) {
            toolCallsByIndex.set(index, toolCall);
            continue;
          }

          if (toolCall.id.trim()) {
            existing.id = toolCall.id;
          }

          if (toolCall.function.name.trim()) {
            existing.function.name = toolCall.function.name;
          }

          if (toolCall.function.arguments) {
            existing.function.arguments += toolCall.function.arguments;
          }
        }

        const message = isObjectRecord(firstChoice.message) ? firstChoice.message : null;
        const messageText = parseOpenRouterText(message?.content);
        if (messageText) {
          messageTextFallback = messageText;
        }

        const messageToolCalls = parseOpenRouterToolCalls(message?.tool_calls);
        if (messageToolCalls.length > 0) {
          for (const [index, toolCall] of messageToolCalls.entries()) {
            toolCallsByIndex.set(index, toolCall);
          }
        }
      }

      if (!assistantText && messageTextFallback) {
        assistantText = messageTextFallback;
      }

      const toolCalls = Array.from(toolCallsByIndex.values()).filter(
        (toolCall) => toolCall.function.name.trim().length > 0,
      );

      span.setAttribute("app.ai.assistant_text_length", assistantText.length);
      span.setAttribute("app.ai.tool_call_count", toolCalls.length);

      return {
        assistantText,
        toolCalls,
      };
    },
  );
}

async function runToolCall(
  session: AgentSession,
  toolCall: OpenRouterToolCall,
): Promise<{ pauseForApproval: boolean; output: unknown; events: AgentEvent[] }> {
  return Sentry.startSpan(
    {
      name: `ai.tool.${toolCall.function.name}`,
      op: "ai.tool",
      attributes: {
        "app.ai.tool_name": toolCall.function.name,
        "app.ai.tool_call_id": toolCall.id,
      },
    },
    async (span) => {
      let rawArguments: unknown;
      try {
        rawArguments = parseToolArguments(toolCall.function.arguments);
      } catch {
        span.setAttribute("app.ai.tool.invalid_arguments", true);
        return {
          pauseForApproval: false,
          output: {
            error: "Tool arguments were invalid JSON.",
          },
          events: [],
        };
      }

      if (toolCall.function.name === "searchFoods") {
        const parsedArgs = SearchFoodsToolArgsSchema.safeParse(rawArguments);
        if (!parsedArgs.success) {
          return {
            pauseForApproval: false,
            output: {
              error: "Invalid searchFoods input.",
            },
            events: [],
          };
        }

        const query = parsedArgs.data.query;
        const limit = parsedArgs.data.limit ?? 6;

        span.setAttribute("app.search.query_length", query.length);
        span.setAttribute("app.search.limit", limit);

        const topFoods = await searchUnifiedFoods(query, limit);
        const foodsWithResultIds: SearchResultFood[] = topFoods.map((food) => {
          const resultId = `r${session.searchResultCounter}`;
          session.searchResultCounter += 1;

          const mapped: SearchResultFood = {
            ...food,
            resultId,
          };

          session.searchResultsByLocalId.set(resultId, mapped);
          return mapped;
        });

        span.setAttribute("app.search.result_count", foodsWithResultIds.length);

        return {
          pauseForApproval: false,
          output: {
            foods: foodsWithResultIds,
          },
          events: [
            {
              kind: "search",
              foods: foodsWithResultIds,
            },
          ],
        };
      }

      if (toolCall.function.name === "requestFoodApprovals") {
        const parsedArgs = RequestFoodApprovalsToolArgsSchema.safeParse(rawArguments);
        if (!parsedArgs.success) {
          return {
            pauseForApproval: false,
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
          const food = session.searchResultsByLocalId.get(suggestion.resultId);
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
            suggestionId: createMessageId(),
            resultId: suggestion.resultId,
            meal: suggestion.meal,
            portion: suggestion.portion,
            reason: suggestion.reason,
            food,
          });
        }

        span.setAttribute("app.ai.approval_candidate_count", parsedArgs.data.suggestions.length);
        span.setAttribute("app.ai.approval_resolved_count", resolvedSuggestions.length);

        if (unknownResultIds.length > 0) {
          span.setAttribute("app.ai.approval_unknown_result_ids", unknownResultIds.length);
          return {
            pauseForApproval: false,
            output: {
              error: `Unknown result IDs: ${unknownResultIds.slice(0, 5).join(", ")}`,
            },
            events: [],
          };
        }

        if (resolvedSuggestions.length === 0) {
          return {
            pauseForApproval: false,
            output: {
              error: "No valid suggestions to approve.",
            },
            events: [],
          };
        }

        session.pendingApprovals.set(toolCall.id, resolvedSuggestions);

        return {
          pauseForApproval: true,
          output: null,
          events: [
            {
              kind: "approval",
              toolCallId: toolCall.id,
              suggestions: resolvedSuggestions,
            },
          ],
        };
      }

      span.setAttribute("app.ai.tool_unknown", true);
      return {
        pauseForApproval: false,
        output: {
          error: `Unknown tool: ${toolCall.function.name}`,
        },
        events: [],
      };
    },
  );
}

async function runAssistantLoop(
  session: AgentSession,
  options?: {
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{ status: AgentStatus; events: AgentEvent[] }> {
  return Sentry.startSpan(
    {
      name: "ai.assistant.loop",
      op: "ai.loop",
      attributes: {
        "app.ai.message_count": session.conversation.length,
      },
    },
    async (loopSpan) => {
      const events: AgentEvent[] = [];

      const emit = (event: AgentEvent) => {
        events.push(event);
        options?.onEvent?.(event);
      };

      for (let step = 0; step < 8; step += 1) {
        const turn = await Sentry.startSpan(
          {
            name: "ai.assistant.step",
            op: "ai.step",
            attributes: {
              "app.ai.step_index": step,
              "app.ai.message_count": session.conversation.length,
            },
          },
          async (stepSpan) => {
            const nextTurn = await requestOpenRouterTurn(session, {
              signal: options?.signal,
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

            stepSpan.setAttribute("app.ai.assistant_text_length", nextTurn.assistantText.length);
            stepSpan.setAttribute("app.ai.tool_call_count", nextTurn.toolCalls.length);
            return nextTurn;
          },
        );

        loopSpan.setAttribute("app.ai.step_count", step + 1);

        if (turn.assistantText.trim()) {
          emit({
            kind: "assistant",
            text: turn.assistantText,
          });
        }

        session.conversation.push({
          role: "assistant",
          content: turn.assistantText.trim() ? turn.assistantText : null,
          ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
        });

        if (turn.toolCalls.length === 0) {
          loopSpan.setAttribute("app.ai.event_count", events.length);
          return {
            status: "ready",
            events,
          };
        }

        for (const toolCall of turn.toolCalls) {
          const toolResult = await runToolCall(session, toolCall);
          for (const event of toolResult.events) {
            emit(event);
          }

          if (toolResult.pauseForApproval) {
            loopSpan.setAttribute("app.ai.event_count", events.length);
            return {
              status: "awaiting-approval",
              events,
            };
          }

          session.conversation.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult.output ?? {}),
          });
        }
      }

      loopSpan.setAttribute("app.ai.event_count", events.length);
      return {
        status: "ready",
        events,
      };
    },
  );
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function parseTurnRequest(request: Request): Promise<
  | {
      sessionId: string;
      action: AgentAction;
      audioFile: File | null;
    }
  | Response
> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonResponse({ error: "Invalid multipart body" }, 400);
    }

    const rawSessionId = formData.get("sessionId");
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    if (!sessionId) {
      return jsonResponse({ error: "sessionId is required" }, 400);
    }

    const rawActionType = formData.get("actionType");
    const actionType = typeof rawActionType === "string" ? rawActionType.trim() : "";
    if (!actionType) {
      return jsonResponse({ error: "actionType is required" }, 400);
    }

    if (actionType === "user-message") {
      const rawMessage = formData.get("message");
      const message = typeof rawMessage === "string" ? rawMessage.trim() : undefined;
      const parsedAction = UserMessageActionSchema.safeParse({
        type: "user-message",
        ...(message ? { message } : {}),
      });
      if (!parsedAction.success) {
        return jsonResponse({ error: "Invalid action payload" }, 400);
      }

      const audioField = formData.get("audio");
      const audioFile = audioField instanceof File && audioField.size > 0 ? audioField : null;

      return {
        sessionId,
        action: parsedAction.data,
        audioFile,
      };
    }

    if (actionType === "approval") {
      const parsedAction = ApprovalActionSchema.safeParse({
        type: "approval",
        toolCallId: typeof formData.get("toolCallId") === "string" ? formData.get("toolCallId") : "",
        suggestionId: typeof formData.get("suggestionId") === "string" ? formData.get("suggestionId") : "",
        approved: formData.get("approved") === "true",
      });

      if (!parsedAction.success) {
        return jsonResponse({ error: "Invalid action payload" }, 400);
      }

      return {
        sessionId,
        action: parsedAction.data,
        audioFile: null,
      };
    }

    return jsonResponse({ error: `Unsupported action type: ${actionType}` }, 400);
  }

  const body = await parseJsonBody(request);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, 400);
  }

  const parsedAction = JsonActionSchema.safeParse(body?.action);
  if (!parsedAction.success) {
    return jsonResponse({ error: "Invalid action payload" }, 400);
  }

  return {
    sessionId,
    action: parsedAction.data,
    audioFile: null,
  };
}

export async function handleAiSessionRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = await parseJsonBody(request);

    pruneOldAiSessions();
    const recentLogHints = parseRecentLogHints(body?.recentLogs);
    const recentLogContextPrompt = buildRecentLogContextPrompt(recentLogHints);

    Sentry.getActiveSpan()?.setAttributes({
      "app.ai.endpoint": "/ai/session",
      "app.ai.recent_log_count": recentLogHints.length,
    });

    const sessionId = createAiSessionId();
    const now = Date.now();
    aiSessions.set(sessionId, {
      id: sessionId,
      userId: auth.userId,
      conversation: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...(recentLogContextPrompt
          ? [
              {
                role: "system" as const,
                content: recentLogContextPrompt,
              },
            ]
          : []),
      ],
      searchResultCounter: 1,
      searchResultsByLocalId: new Map<string, SearchResultFood>(),
      pendingApprovals: new Map<string, ResolvedApprovalSuggestion[]>(),
      updatedAt: now,
    });

    return jsonResponse({
      sessionId,
      status: "ready",
    });
  } catch (error) {
    return reportUnknownError("ai_session_failed", error);
  }
}

export async function handleAiTurnRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  const parsed = await parseTurnRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  pruneOldAiSessions();
  const session = requireSessionOwner(parsed.sessionId, auth.userId);
  if (!session) {
    return jsonResponse({ error: "Session not found for this user" }, 403);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.endpoint": "/ai/turn",
    "app.ai.session_id": parsed.sessionId,
    "app.ai.action_type": parsed.action.type,
    "app.ai.has_audio": Boolean(parsed.audioFile),
    "app.ai.pending_approval_count": session.pendingApprovals.size,
  });

  session.updatedAt = Date.now();

  try {
    if (parsed.action.type === "user-message") {
      return handleUserMessageAction(request, session, parsed.action, parsed.audioFile);
    }

    return handleApprovalAction(request, session, parsed.action);
  } catch (error) {
    return reportUnknownError("ai_turn_failed", error);
  }
}

async function handleUserMessageAction(
  request: Request,
  session: AgentSession,
  action: UserMessageAction,
  audioFile: File | null,
): Promise<Response> {
  const message = action.message?.trim() ?? "";

  if (!message && !audioFile) {
    return jsonResponse({ error: "action.message or audio is required" }, 400);
  }

  if (session.pendingApprovals.size > 0) {
    return jsonResponse({ error: "Resolve pending approvals before sending a new message." }, 409);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.user_message_length": message.length,
  });

  if (audioFile) {
    const encodedAudio = await encodeAudioFileForOpenRouter(audioFile);
    const content: OpenRouterContentPart[] = [];

    if (message) {
      content.push({
        type: "text",
        text: message,
      });
    }

    content.push({
      type: "input_audio",
      input_audio: encodedAudio,
    });

    session.conversation.push({
      role: "user",
      content,
    });
  } else {
    session.conversation.push({
      role: "user",
      content: message,
    });
  }

  return createSseResponse(async (writer) => {
    if (message) {
      writer.writeResolvedUserMessage(message);
    }

    const loopResult = await runAssistantLoop(session, {
      onEvent: writer.writeEvent,
      signal: request.signal,
    });

    session.updatedAt = Date.now();
    writer.writeStatus(loopResult.status);
  }, "ai_turn_failed");
}

function handleApprovalAction(request: Request, session: AgentSession, action: ApprovalAction): Response {
  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.approval.tool_call_id": action.toolCallId,
    "app.ai.approval.suggestion_id": action.suggestionId,
    "app.ai.approval.approved": action.approved,
  });

  const pendingSuggestions = session.pendingApprovals.get(action.toolCallId);
  if (!pendingSuggestions) {
    return jsonResponse({ error: "No pending approval request for tool call." }, 409);
  }

  const targetIndex = pendingSuggestions.findIndex((suggestion) => suggestion.suggestionId === action.suggestionId);
  if (targetIndex === -1) {
    return jsonResponse({ error: "Suggestion not found." }, 404);
  }

  if (pendingSuggestions[targetIndex]?.output) {
    return jsonResponse({
      status: "awaiting-approval",
      events: [],
    });
  }

  const itemOutput: ApprovalOutput = {
    approved: action.approved,
    reason: action.approved ? undefined : "User rejected this suggestion.",
  };

  const nextSuggestions = pendingSuggestions.map((suggestion, index) =>
    index === targetIndex
      ? {
          ...suggestion,
          output: itemOutput,
        }
      : suggestion,
  );

  if (!nextSuggestions.every((suggestion) => Boolean(suggestion.output))) {
    session.pendingApprovals.set(action.toolCallId, nextSuggestions);
    session.updatedAt = Date.now();
    return jsonResponse({
      status: "awaiting-approval",
      events: [],
    });
  }

  session.pendingApprovals.delete(action.toolCallId);
  session.conversation.push({
    role: "tool",
    tool_call_id: action.toolCallId,
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

  return createSseResponse(async (writer) => {
    const loopResult = await runAssistantLoop(session, {
      onEvent: writer.writeEvent,
      signal: request.signal,
    });

    session.updatedAt = Date.now();
    writer.writeStatus(loopResult.status);
  }, "ai_turn_failed");
}

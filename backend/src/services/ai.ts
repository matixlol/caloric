import {
  streamText,
  tool,
  type JSONValue,
  type ModelMessage,
} from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { buildRecentLogContextPrompt, parseRecentLogHints } from "../ai-log-context";
import { config } from "../config";
import { isObjectRecord, jsonResponse, requireAuthenticatedUser } from "../http";
import { createAiMessageId, createAiSessionId } from "../id";
import { logError, summarizeText } from "../logging";
import { Sentry } from "../lib/sentry";
import {
  createAiSession,
  loadAiSession,
  mealValues,
  saveAiSession,
  type AiSessionState,
  type Meal,
  type ResolvedApprovalSuggestion,
} from "./ai-store";
import { searchUnifiedFoods, type SearchResultFood } from "./search";

const MealSchema = z.enum(mealValues);
type SessionToolCall = {
  toolCallId: string;
  toolName: keyof typeof aiSdkTools;
  input: unknown;
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
      query: string;
      foods: SearchResultFood[];
    }
  | {
      kind: "approval";
      toolCallId: string;
      suggestions: ResolvedApprovalSuggestion[];
    };

type AgentStatus = "ready";

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

const systemPrompt = [
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
  "When you answer, keep the wording concise and practical.",
].join(" ");

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

const googleAiStudio = createGoogleGenerativeAI({
  apiKey: config.googleAiStudioApiKey,
  fetch: fetchWithGeminiSentryLogging as typeof fetch,
});

const sentryPayloadMaxLength = 80_000;
const geminiSpanCallCounters = new WeakMap<object, number>();

function truncateForSentry(value: string, maxLength = sentryPayloadMaxLength): { value: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return {
      value,
      truncated: false,
    };
  }

  return {
    value: `${value.slice(0, maxLength - 3)}...`,
    truncated: true,
  };
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Array.from(headers.entries()).map(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return [
        key,
        normalizedKey === "authorization" || normalizedKey === "x-goog-api-key" ? "[redacted]" : value,
      ];
    }),
  );
}

async function requestBodyText(request: Request): Promise<string | null> {
  if (!request.body) {
    return null;
  }

  try {
    return await request.clone().text();
  } catch (error) {
    return `[unavailable: ${stringifyUnknownError(error)}]`;
  }
}

function addGeminiSpanEvent(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
): void {
  const compactAttributes: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      compactAttributes[key] = value;
    }
  }

  Sentry.getActiveSpan()?.addEvent(name, compactAttributes);
}

function nextGeminiSpanCallIndex(): number {
  const span = Sentry.getActiveSpan();
  if (!span) {
    return 1;
  }

  const next = (geminiSpanCallCounters.get(span) ?? 0) + 1;
  geminiSpanCallCounters.set(span, next);
  span.setAttributes({
    "app.ai.gemini.call_count": next,
  });

  return next;
}

async function fetchWithGeminiSentryLogging(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
  const callIndex = nextGeminiSpanCallIndex();
  const startedAt = performance.now();
  const rawRequestBody = await requestBodyText(request);
  const requestBody = rawRequestBody ? truncateForSentry(rawRequestBody) : null;

  addGeminiSpanEvent("gemini.request", {
    "app.ai.gemini.call_index": callIndex,
    "http.request.method": request.method,
    "url.full": request.url,
    "http.request.headers": JSON.stringify(headerRecord(request.headers)),
    "http.request.body": requestBody?.value,
    "http.request.body_length": rawRequestBody?.length ?? 0,
    "http.request.body_truncated": requestBody?.truncated ?? false,
  });

  try {
    const response = await fetch(request);
    const clonedResponse = response.clone();

    clonedResponse
      .text()
      .then((rawResponseBody) => {
        const responseBody = truncateForSentry(rawResponseBody);
        addGeminiSpanEvent("gemini.response", {
          "app.ai.gemini.call_index": callIndex,
          "http.response.status_code": response.status,
          "http.response.headers": JSON.stringify(headerRecord(response.headers)),
          "http.response.body": responseBody.value,
          "http.response.body_length": rawResponseBody.length,
          "http.response.body_truncated": responseBody.truncated,
          "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
        });
      })
      .catch((error) => {
        addGeminiSpanEvent("gemini.response_body_failed", {
          "app.ai.gemini.call_index": callIndex,
          "http.response.status_code": response.status,
          "app.ai.gemini.error": stringifyUnknownError(error),
          "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
        });
      });

    return response;
  } catch (error) {
    addGeminiSpanEvent("gemini.fetch_failed", {
      "app.ai.gemini.call_index": callIndex,
      "app.ai.gemini.error": stringifyUnknownError(error),
      "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
    });

    throw error;
  }
}

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

function captureUnknownError(code: string, error: unknown) {
  const isConnectionClosed =
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.includes("connection was closed") ||
      error.message.includes("Connection closed") ||
      error.message.includes("stream closed"));

  const errorForCapture =
    error instanceof Error ? error : new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
    "app.error.is_connection_closed": isConnectionClosed,
  });

  logError(`api.${code}`, errorForCapture);

  if (!isConnectionClosed) {
    Sentry.captureException(errorForCapture);
  }
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

function createMessageId(): string {
  return createAiMessageId();
}

function createGeminiModel() {
  return googleAiStudio.chat(config.geminiModel);
}

async function encodeAudioFile(audioFile: File): Promise<{ data: string; mediaType: string }> {
  if (audioFile.size <= 0) {
    throw new Error("Audio snippet was empty.");
  }

  if (audioFile.size > 12 * 1024 * 1024) {
    throw new Error("Audio snippet is too large (max 12 MB).");
  }

  const bytes = new Uint8Array(await audioFile.arrayBuffer());
  const data = Buffer.from(bytes).toString("base64");
  const mediaType = audioFile.type.trim().toLowerCase().startsWith("audio/") ? audioFile.type.trim().toLowerCase() : "audio/mp4";

  return {
    data,
    mediaType,
  };
}

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

async function requestAiSdkTurn(
  session: AiSessionState,
  options?: {
    onAssistantDelta?: (text: string) => void;
    signal?: AbortSignal;
  },
): Promise<{
  assistantText: string;
  toolCalls: SessionToolCall[];
  responseMessages: ModelMessage[];
}> {
  const result = streamText({
    model: createGeminiModel(),
    messages: session.conversation,
    tools: aiSdkTools,
    abortSignal: options?.signal,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "backend.ai.turn",
      metadata: {
        sessionId: session.id,
        messageCount: session.conversation.length,
        toolCount: Object.keys(aiSdkTools).length,
        provider: "google-ai-studio",
        model: config.geminiModel,
      },
    },
  });

  let assistantText = "";

  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta" && chunk.text) {
      assistantText += chunk.text;
      options?.onAssistantDelta?.(chunk.text);
    }
  }

  const response = await result.response;
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
    toolCalls,
    responseMessages: response.messages,
  };
}

async function runToolCall(
  session: AiSessionState,
  toolCall: SessionToolCall,
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
    const topFoods = await searchUnifiedFoods(parsedArgs.data.query, limit);
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
        suggestionId: createMessageId(),
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

async function runAssistantLoop(
  session: AiSessionState,
  options?: {
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{ status: AgentStatus; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];

  const emit = (event: AgentEvent) => {
    events.push(event);
    options?.onEvent?.(event);
  };

  for (let step = 0; step < 8; step += 1) {
    const turn = await requestAiSdkTurn(session, {
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

    if (turn.assistantText.trim()) {
      emit({
        kind: "assistant",
        text: turn.assistantText,
      });
    }

    session.conversation.push(...turn.responseMessages);

    if (turn.toolCalls.length === 0) {
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

      session.conversation.push(createToolResultMessage(toolCall, toolResult.output ?? null));

      if (toolResult.stopAfterTool) {
        return {
          status: "ready",
          events,
        };
      }
    }
  }

  return {
    status: "ready",
    events,
  };
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
    const recentLogHints = parseRecentLogHints(body?.recentLogs);
    const recentLogContextPrompt = buildRecentLogContextPrompt(recentLogHints);

    Sentry.getActiveSpan()?.setAttributes({
      "app.ai.endpoint": "/ai/session",
      "app.ai.recent_log_count": recentLogHints.length,
    });

    const sessionId = createAiSessionId();
    await createAiSession({
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
      searchResultsByLocalId: {},
      pendingApprovals: {},
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

  const session = await loadAiSession(parsed.sessionId, auth.userId);
  if (!session) {
    return jsonResponse({ error: "Session not found for this user" }, 403);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.endpoint": "/ai/turn",
    "app.ai.session_id": parsed.sessionId,
    "app.ai.action_type": parsed.action.type,
    "app.ai.has_audio": Boolean(parsed.audioFile),
    "app.ai.pending_approval_count": Object.keys(session.pendingApprovals).length,
  });

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
  session: AiSessionState,
  action: UserMessageAction,
  audioFile: File | null,
): Promise<Response> {
  const message = action.message?.trim() ?? "";

  if (!message && !audioFile) {
    return jsonResponse({ error: "action.message or audio is required" }, 400);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.user_message_length": message.length,
  });

  if (audioFile) {
    const encodedAudio = await encodeAudioFile(audioFile);
    const content: Array<{ type: "text"; text: string } | { type: "file"; data: string; mediaType: string; filename?: string }> = [];

    if (message) {
      content.push({
        type: "text",
        text: message,
      });
    }

    content.push({
      type: "file",
      data: encodedAudio.data,
      mediaType: encodedAudio.mediaType,
      filename: audioFile.name || undefined,
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

  // Approval cards are now client-local only; clear any stale server-side state from older sessions.
  session.pendingApprovals = {};
  await saveAiSession(session);

  return createSseResponse(async (writer) => {
    if (message) {
      writer.writeResolvedUserMessage(message);
    }

    const loopResult = await runAssistantLoop(session, {
      onEvent: writer.writeEvent,
      signal: request.signal,
    });

    await saveAiSession(session);
    writer.writeStatus(loopResult.status);
  }, "ai_turn_failed");
}

async function handleApprovalAction(request: Request, session: AiSessionState, action: ApprovalAction): Promise<Response> {
  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.approval.tool_call_id": action.toolCallId,
    "app.ai.approval.suggestion_id": action.suggestionId,
    "app.ai.approval.approved": action.approved,
  });
  session.pendingApprovals = {};
  await saveAiSession(session);

  return jsonResponse({
    status: "ready",
    events: [],
  });
}

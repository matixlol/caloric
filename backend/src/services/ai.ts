import { authenticateUserRequest } from "../auth";
import { buildRecentLogContextPrompt, parseRecentLogHints } from "../ai-log-context";
import { config } from "../config";
import { logError, summarizeText } from "../logging";
import { Sentry } from "../lib/sentry";
import { createAiMessageId, createAiSessionId } from "../id";
import { searchUnifiedFoods, type SearchResultFood } from "./search";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

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

type Meal = "breakfast" | "lunch" | "dinner" | "snacks";

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

const aiSessions = new Map<string, AgentSession>();
const maxAiSessionIdleMs = 1000 * 60 * 60 * 8;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function requireAuthenticatedUser(request: Request): Promise<{ userId: string } | Response> {
  try {
    return await authenticateUserRequest(request);
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }
}

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

function reportUnknownError(code: string, error: unknown): Response {
  const errorForCapture =
    error instanceof Error ? error : new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
  });

  logError(`api.${code}`, errorForCapture);
  Sentry.captureException(errorForCapture);

  return json(
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeMeal(meal: unknown): Meal {
  const normalized = typeof meal === "string" ? meal.trim().toLowerCase() : "";
  if (
    normalized === "breakfast" ||
    normalized === "lunch" ||
    normalized === "dinner" ||
    normalized === "snacks"
  ) {
    return normalized;
  }
  return "lunch";
}

function sanitizePortion(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1;
  }

  const bounded = Math.max(0.25, parsed);
  return Math.round(bounded * 4) / 4;
}

function parseToolArguments(raw: string): unknown {
  if (!raw || !raw.trim()) {
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
  if (!session) {
    return null;
  }

  if (session.userId !== userId) {
    return null;
  }

  return session;
}

function parseOpenRouterText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        if (!record) {
          return "";
        }

        const text = record.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }

  return "";
}

function parseOpenRouterToolCalls(raw: unknown): OpenRouterToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const output: OpenRouterToolCall[] = [];

  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }

    const id = asString(record.id);
    const type = record.type;
    const fn = asRecord(record.function);
    const name = asString(fn?.name);

    if (!id || type !== "function" || !name) {
      continue;
    }

    const fnArgsRaw = fn?.arguments;
    let args = "";
    if (typeof fnArgsRaw === "string") {
      args = fnArgsRaw;
    } else if (fnArgsRaw !== undefined) {
      try {
        args = JSON.stringify(fnArgsRaw);
      } catch {
        args = "";
      }
    }

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

function parseSseDataChunks(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n");
  const events = normalized.split("\n\n");
  const chunks: string[] = [];

  for (const event of events) {
    const lines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (lines.length === 0) {
      continue;
    }

    const payload = lines.join("\n");
    if (payload === "[DONE]") {
      continue;
    }

    chunks.push(payload);
  }

  if (chunks.length === 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return [raw];
      }
    } catch {
      // Ignore non-JSON bodies.
    }
  }

  return chunks;
}

function parseToolCallDeltas(raw: unknown): Array<{ index: number; toolCall: OpenRouterToolCall }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const byIndex = new Map<number, OpenRouterToolCall>();

  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }

    const index = typeof record.index === "number" ? record.index : undefined;
    if (index === undefined) {
      continue;
    }

    const existing = byIndex.get(index) ?? {
      id: asString(record.id) ?? `tool-${index}`,
      type: "function",
      function: {
        name: "",
        arguments: "",
      },
    };

    const maybeId = asString(record.id);
    if (maybeId) {
      existing.id = maybeId;
    }

    const fn = asRecord(record.function);
    const maybeName = asString(fn?.name);
    if (maybeName) {
      existing.function.name = maybeName;
    }

    const argsChunk = fn?.arguments;
    if (typeof argsChunk === "string") {
      existing.function.arguments += argsChunk;
    } else if (argsChunk !== undefined) {
      try {
        existing.function.arguments += JSON.stringify(argsChunk);
      } catch {
        // Ignore non-serializable chunks.
      }
    }

    byIndex.set(index, existing);
  }

  return Array.from(byIndex.entries())
    .filter(([, toolCall]) => toolCall.function.name.trim().length > 0)
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
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      span.setAttribute("http.response.status_code", response.status);

      const textBody = await response.text();

      if (!response.ok) {
        const suffix = textBody ? `: ${textBody.slice(0, 300)}` : "";
        throw new Error(`OpenRouter request failed (${response.status})${suffix}`);
      }

      const chunks = parseSseDataChunks(textBody);
      let assistantText = "";
      let messageTextFallback = "";
      const toolCallsByIndex = new Map<number, OpenRouterToolCall>();

      for (const chunk of chunks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(chunk);
        } catch {
          continue;
        }

        const root = asRecord(parsed);
        const choices = Array.isArray(root?.choices) ? root.choices : [];
        const firstChoice = asRecord(choices[0]);
        const delta = asRecord(firstChoice?.delta);

        const textDelta = parseOpenRouterText(delta?.content);
        if (textDelta) {
          assistantText += textDelta;
          options?.onAssistantDelta?.(textDelta);
        }

        const toolCallDeltas = parseToolCallDeltas(delta?.tool_calls);
        for (const { index, toolCall } of toolCallDeltas) {
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

        const message = asRecord(firstChoice?.message);
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
        const args = asRecord(rawArguments);
        const query = asString(args?.query) ?? "";
        const parsedLimit = asNumber(args?.limit);
        const limit = Math.max(1, Math.min(10, typeof parsedLimit === "number" ? Math.round(parsedLimit) : 6));

        span.setAttribute("app.search.query_length", query.trim().length);
        span.setAttribute("app.search.limit", limit);

        if (query.trim().length < 2) {
          return {
            pauseForApproval: false,
            output: {
              error: "Invalid searchFoods input.",
            },
            events: [],
          };
        }

        const topFoods = await searchUnifiedFoods(query.trim(), limit);
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
        const args = asRecord(rawArguments);
        const suggestionsRaw = args?.suggestions;

        if (!Array.isArray(suggestionsRaw) || suggestionsRaw.length === 0 || suggestionsRaw.length > 8) {
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

        for (const candidate of suggestionsRaw) {
          const suggestion = asRecord(candidate);
          const resultId = asString(suggestion?.resultId)?.trim() ?? "";
          const food = session.searchResultsByLocalId.get(resultId);
          if (!food) {
            unknownResultIds.push(resultId || "(empty)");
            continue;
          }

          const meal = normalizeMeal(suggestion?.meal);
          const portion = sanitizePortion(suggestion?.portion);
          const reason = asString(suggestion?.reason)?.trim() ?? "";
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

        span.setAttribute("app.ai.approval_candidate_count", suggestionsRaw.length);
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

async function runAssistantLoop(session: AgentSession): Promise<{ status: AgentStatus; events: AgentEvent[] }> {
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
              onAssistantDelta: (text) => {
                if (!text) {
                  return;
                }

                events.push({
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
          events.push({
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
          events.push(...toolResult.events);

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
    return asRecord(parsed);
  } catch {
    return null;
  }
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

    return json({
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

  let sessionId = "";
  let action: Record<string, unknown> | null = null;
  let audioFile: File | null = null;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: "Invalid multipart body" }, 400);
    }

    sessionId = asString(formData.get("sessionId"))?.trim() ?? "";

    const actionType = asString(formData.get("actionType"))?.trim() ?? "";
    if (!actionType) {
      return json({ error: "actionType is required" }, 400);
    }

    if (actionType === "user-message") {
      const message = asString(formData.get("message"))?.trim();
      action = {
        type: "user-message",
        ...(message ? { message } : {}),
      };

      const audioField = formData.get("audio");
      if (audioField instanceof File && audioField.size > 0) {
        audioFile = audioField;
      }
    } else if (actionType === "approval") {
      action = {
        type: "approval",
        toolCallId: asString(formData.get("toolCallId")) ?? "",
        suggestionId: asString(formData.get("suggestionId")) ?? "",
        approved: formData.get("approved") === "true",
      };
    } else {
      action = {
        type: actionType,
      };
    }
  } else {
    const body = await parseJsonBody(request);
    sessionId = asString(body?.sessionId)?.trim() ?? "";
    action = asRecord(body?.action);
  }

  if (!action) {
    return json({ error: "action is required" }, 400);
  }

  const actionType = asString(action.type)?.trim() ?? "";

  if (!sessionId) {
    return json({ error: "sessionId is required" }, 400);
  }

  if (!actionType) {
    return json({ error: "action.type is required" }, 400);
  }

  pruneOldAiSessions();
  const session = requireSessionOwner(sessionId, auth.userId);
  if (!session) {
    return json({ error: "Session not found for this user" }, 403);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.endpoint": "/ai/turn",
    "app.ai.session_id": sessionId,
    "app.ai.action_type": actionType,
    "app.ai.has_audio": Boolean(audioFile),
    "app.ai.pending_approval_count": session.pendingApprovals.size,
  });

  session.updatedAt = Date.now();

  try {
    if (actionType === "user-message") {
      const message = asString(action.message)?.trim() ?? "";

      if (!message && !audioFile) {
        return json({ error: "action.message or audio is required" }, 400);
      }

      Sentry.getActiveSpan()?.setAttributes({
        "app.ai.user_message_length": message.length,
      });

      if (session.pendingApprovals.size > 0) {
        return json({ error: "Resolve pending approvals before sending a new message." }, 409);
      }

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

      const loopResult = await runAssistantLoop(session);
      session.updatedAt = Date.now();

      return new Response(
        encodeSseChunk({
          type: "status",
          status: loopResult.status,
        }) +
          (message
            ? encodeSseChunk({
                type: "resolved-user-message",
                resolvedUserMessage: message,
              })
            : "") +
          loopResult.events
            .map((event) =>
              encodeSseChunk({
                type: "event",
                event,
              }),
            )
            .join("") +
          "data: [DONE]\n\n",
        {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        },
      );
    }

    if (actionType === "approval") {
      const toolCallId = asString(action.toolCallId)?.trim() ?? "";
      const suggestionId = asString(action.suggestionId)?.trim() ?? "";
      const approved = action.approved === true;

      if (!toolCallId || !suggestionId) {
        return json({ error: "action.toolCallId and action.suggestionId are required" }, 400);
      }

      Sentry.getActiveSpan()?.setAttributes({
        "app.ai.approval.tool_call_id": toolCallId,
        "app.ai.approval.suggestion_id": suggestionId,
        "app.ai.approval.approved": approved,
      });

      const pendingSuggestions = session.pendingApprovals.get(toolCallId);
      if (!pendingSuggestions) {
        return json({ error: "No pending approval request for tool call." }, 409);
      }

      const targetIndex = pendingSuggestions.findIndex(
        (suggestion) => suggestion.suggestionId === suggestionId,
      );
      if (targetIndex === -1) {
        return json({ error: "Suggestion not found." }, 404);
      }

      if (pendingSuggestions[targetIndex]?.output) {
        return json({
          status: "awaiting-approval",
          events: [],
        });
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

      const allResolved = nextSuggestions.every((suggestion) => Boolean(suggestion.output));

      if (!allResolved) {
        session.pendingApprovals.set(toolCallId, nextSuggestions);
        session.updatedAt = Date.now();
        return json({
          status: "awaiting-approval",
          events: [],
        });
      }

      session.pendingApprovals.delete(toolCallId);
      session.conversation.push({
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

      const loopResult = await runAssistantLoop(session);
      session.updatedAt = Date.now();

      return new Response(
        encodeSseChunk({
          type: "status",
          status: loopResult.status,
        }) +
          loopResult.events
            .map((event) =>
              encodeSseChunk({
                type: "event",
                event,
              }),
            )
            .join("") +
          "data: [DONE]\n\n",
        {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        },
      );
    }

    return json({ error: `Unsupported action type: ${actionType}` }, 400);
  } catch (error) {
    return reportUnknownError("ai_turn_failed", error);
  }
}

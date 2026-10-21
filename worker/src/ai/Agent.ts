import * as LanguageModel from "effect/ai/LanguageModel";
import * as Prompt from "effect/ai/Prompt";
import type * as Response from "effect/ai/Response";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Stream from "effect/Stream";
import { aiMessageId } from "../ids.ts";
import { FoodSearch, type FoodSearchError, type FoodSearchResult } from "../search/FoodSearch.ts";
import { type AgentEvent, Meal, type ResolvedApprovalSuggestion, type SearchResultFood } from "./Domain.ts";

// The model-agnostic agent loop: the session object drives it in production
// and tests drive it with a scripted LanguageModel.

export interface SessionState {
  readonly id: string;
  readonly userId: string;
  conversation: Array<Prompt.Message>;
  searchResultCounter: number;
  searchResultsByLocalId: Record<string, SearchResultFood>;
}

export interface StepUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface AgentHooks {
  readonly emit: (event: AgentEvent) => Effect.Effect<void>;
  // Token usage and OpenRouter's billed cost of every model call.
  readonly onUsage?: (usage: StepUsage) => Effect.Effect<void>;
}

export class AiModelError extends Schema.TaggedError<AiModelError>()("AiModelError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// --- Tools ------------------------------------------------------------------

// What the model sees (JSON schema). Calls are validated leniently below, as
// backend/'s zod schemas did, so a sloppy call gets a tool error the model can
// recover from instead of failing the turn.
const SearchFoods = Tool.make("searchFoods", {
  description: "Search foods in the app food database.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(2)),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  }),
});

const RequestFoodApprovals = Tool.make("requestFoodApprovals", {
  description:
    "Request user approval for one or more selected food entries using local result IDs from searchFoods. This renders interactive suggestions in the app and ends the current turn.",
  parameters: Schema.Struct({
    suggestions: Schema.Array(
      Schema.Struct({ resultId: Schema.String, meal: Schema.String, portion: Schema.Number, reason: Schema.String }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
});

export const AssistantToolkit = Toolkit.make(SearchFoods, RequestFoodApprovals);

const toNumber = SchemaTransformation.transform<number, unknown>({ decode: (input) => Number(input), encode: (n) => n });
const NonEmptyTrimmed = Schema.Trim.check(Schema.isMinLength(1));

const SearchFoodsInput = Schema.Struct({
  query: Schema.Trim.check(Schema.isMinLength(2)),
  limit: Schema.optionalKey(
    Schema.Unknown.pipe(Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })), toNumber)),
  ),
});

const SuggestionInput = Schema.Struct({
  resultId: NonEmptyTrimmed,
  // Unknown meals fall back to lunch rather than rejecting the whole call.
  meal: Schema.Trim.pipe(
    Schema.decodeTo(
      Meal,
      SchemaTransformation.transform<Meal, string>({
        decode: (value) => Option.getOrElse(Schema.decodeUnknownOption(Meal)(value.toLowerCase()), () => "lunch"),
        encode: (meal) => meal,
      }),
    ),
  ),
  // Quarter-serving steps, at least a quarter; garbage becomes one serving.
  portion: Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform<number, unknown>({
        decode: (value) => {
          const parsed = Number(value);
          const portion = Number.isFinite(parsed) ? parsed : 1;
          return Math.round(Math.max(0.25, portion) * 4) / 4;
        },
        encode: (n) => n,
      }),
    ),
  ),
  reason: NonEmptyTrimmed,
});

const RequestFoodApprovalsInput = Schema.Struct({
  suggestions: Schema.Array(SuggestionInput).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});

const decodeSearchInput = Schema.decodeUnknownOption(SearchFoodsInput);
const decodeApprovalsInput = Schema.decodeUnknownOption(RequestFoodApprovalsInput);

// --- Prompt -----------------------------------------------------------------

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

const textMessage = (role: "system" | "user", text: string): Prompt.Message =>
  role === "system"
    ? Prompt.makeMessage("system", { content: text })
    : Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] });

export const systemMessage = (text: string) => textMessage("system", text);

// Models sometimes print a tool call as text ("call:default_api:searchFoods{…}")
// or leak a thought header instead of calling the function.
const leakedToolCallPattern = /default_api[:.]|^\s*(call:|thought\b|<thought|model\s*\n)/i;
const leakDetectionChars = 24;

const repairNudge = textMessage(
  "user",
  "(Automatic note from the app, not the user.) Your previous reply was not delivered: it printed a tool call as text or stopped without suggesting foods. Continue the task by calling the tools through function calling. Only reply with text if you genuinely need to ask the user something.",
);

// --- One model call ---------------------------------------------------------

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly params: unknown;
}

interface Step {
  readonly assistantText: string;
  readonly leaked: boolean;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  readonly responseMessages: ReadonlyArray<Prompt.Message>;
}

const finishCost = (part: Response.FinishPart): number | undefined => {
  const usage = part.metadata.openrouter?.usage;
  return usage && Predicate.isNumber(usage.cost) ? usage.cost : undefined;
};

const requestStep = Effect.fnUntraced(function* (session: SessionState, nudge: boolean, hooks: AgentHooks) {
  const parts: Array<Response.AnyPart> = [];
  const toolCalls: Array<ToolCall> = [];
  let assistantText = "";
  let leaked = false;
  // Hold the first characters back until they can be classified so a leaked
  // tool call never reaches the client.
  let released = false;

  yield* LanguageModel.streamText({
    prompt: Prompt.fromMessages(nudge ? [...session.conversation, repairNudge] : session.conversation),
    toolkit: AssistantToolkit,
    disableToolCallResolution: true,
    toolCallValidation: "deferred",
  }).pipe(
    Stream.mapError((cause) => new AiModelError({ message: "Model request failed.", cause })),
    Stream.runForEach((part) =>
      Effect.gen(function* () {
        parts.push(part);
        switch (part.type) {
          case "text-delta": {
            if (!part.delta) return;
            assistantText += part.delta;
            if (released) {
              if (!leaked) yield* hooks.emit({ kind: "assistant-delta", text: part.delta });
            } else if (assistantText.trim().length >= leakDetectionChars) {
              released = true;
              leaked = leakedToolCallPattern.test(assistantText);
              if (!leaked) yield* hooks.emit({ kind: "assistant-delta", text: assistantText });
            }
            return;
          }
          case "tool-call": {
            if (!part.providerExecuted) toolCalls.push({ id: part.id, name: part.name, params: part.params });
            return;
          }
          case "finish": {
            if (hooks.onUsage) {
              yield* hooks.onUsage({
                inputTokens: part.usage.inputTokens.total ?? 0,
                outputTokens: part.usage.outputTokens.total ?? 0,
                costUsd: finishCost(part),
              });
            }
            return;
          }
          case "error":
            return yield* new AiModelError({ message: "Model stream reported an error.", cause: part.error });
        }
      }),
    ),
  );

  if (!released) {
    leaked = leakedToolCallPattern.test(assistantText);
    if (!leaked && assistantText) yield* hooks.emit({ kind: "assistant-delta", text: assistantText });
  }

  return {
    assistantText,
    leaked: leaked || (toolCalls.length === 0 && leakedToolCallPattern.test(assistantText)),
    toolCalls,
    responseMessages: Prompt.fromResponseParts(parts).content,
  } satisfies Step;
});

// --- Tools at runtime -------------------------------------------------------

interface ToolOutcome {
  readonly stop: boolean;
  readonly output: unknown;
  readonly events: ReadonlyArray<AgentEvent>;
}

const toolError = (error: string): ToolOutcome => ({ stop: false, output: { error }, events: [] });

const toolResultMessage = (call: ToolCall, output: unknown): Prompt.Message =>
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id: call.id,
        name: call.name,
        isFailure: false,
        result: output,
        providerExecuted: false,
      }),
    ],
  });

const searchOutcome = (
  session: SessionState,
  query: string,
  foods: ReadonlyArray<FoodSearchResult>,
): ToolOutcome => {
  const withIds = foods.map((food): SearchResultFood => {
    const mapped = { ...food, resultId: `r${session.searchResultCounter}` };
    session.searchResultCounter += 1;
    session.searchResultsByLocalId[mapped.resultId] = mapped;
    return mapped;
  });
  return { stop: false, output: { foods: withIds }, events: [{ kind: "search", query, foods: withIds }] };
};

const approvalOutcome = (session: SessionState, call: ToolCall): ToolOutcome => {
  const input = decodeApprovalsInput(call.params);
  if (Option.isNone(input)) return toolError("Invalid requestFoodApprovals input.");

  const resolved: Array<ResolvedApprovalSuggestion> = [];
  const unknownResultIds: Array<string> = [];
  const seen = new Set<string>();
  for (const suggestion of input.value.suggestions) {
    const food = session.searchResultsByLocalId[suggestion.resultId];
    if (!food) {
      unknownResultIds.push(suggestion.resultId);
      continue;
    }
    const key = `${suggestion.resultId}|${suggestion.meal}|${suggestion.portion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ suggestionId: aiMessageId(), ...suggestion, food });
  }

  if (unknownResultIds.length > 0) return toolError(`Unknown result IDs: ${unknownResultIds.slice(0, 5).join(", ")}`);
  if (resolved.length === 0) return toolError("No valid suggestions to approve.");
  return {
    stop: true,
    output: {
      displayed: true,
      suggestionCount: resolved.length,
      note: "Suggestions are visible in the app. Approval and rejection stay local to the client.",
    },
    events: [{ kind: "approval", toolCallId: call.id, suggestions: resolved }],
  };
};

// Runs a step's tool calls in order and reports whether the turn should end.
// Every search of the step starts at once; result IDs are still assigned in
// call order, so the transcript matches running them one by one.
const runToolCalls = (session: SessionState, calls: ReadonlyArray<ToolCall>, hooks: AgentHooks) =>
  Effect.gen(function* () {
    const foodSearch = yield* FoodSearch;
    const searches = new Map<string, { query: string; fiber: Fiber.Fiber<ReadonlyArray<FoodSearchResult>, FoodSearchError> }>();
    for (const call of calls) {
      if (call.name !== SearchFoods.name) continue;
      const input = decodeSearchInput(call.params);
      if (Option.isNone(input)) continue;
      const fiber = yield* Effect.forkScoped(foodSearch.searchUnified(input.value.query, input.value.limit ?? 6));
      searches.set(call.id, { query: input.value.query, fiber });
    }

    for (const call of calls) {
      const search = searches.get(call.id);
      const outcome =
        call.name === SearchFoods.name
          ? search
            ? searchOutcome(session, search.query, yield* Fiber.join(search.fiber))
            : toolError("Invalid searchFoods input.")
          : call.name === RequestFoodApprovals.name
            ? approvalOutcome(session, call)
            : toolError(`Unknown tool: ${call.name}`);
      for (const event of outcome.events) yield* hooks.emit(event);
      session.conversation.push(toolResultMessage(call, outcome.output));
      if (outcome.stop) return true;
    }
    return false;
  }).pipe(Effect.scoped);

// --- The loop ---------------------------------------------------------------

export const runAssistantLoop = Effect.fn("Assistant.runLoop")(function* (session: SessionState, hooks: AgentHooks) {
  let repairs = 0;
  let nudge = false;
  let searched = false;

  for (let step = 0; step < 8; step += 1) {
    const turn = yield* requestStep(session, nudge, hooks);

    // Retry a step (at most twice) when the model leaks a tool call as text or
    // stops silently after searching instead of suggesting foods. The nudge and
    // the dropped reply never enter the stored conversation.
    const stalled = turn.toolCalls.length === 0 && (turn.leaked || (searched && !turn.assistantText.trim()));
    if (stalled && repairs < 2) {
      repairs += 1;
      nudge = true;
      continue;
    }
    nudge = false;

    if (turn.assistantText.trim() && !turn.leaked) {
      yield* hooks.emit({ kind: "assistant", text: turn.assistantText });
    }
    session.conversation.push(...turn.responseMessages);
    if (turn.toolCalls.length === 0) return;

    searched ||= turn.toolCalls.some((call) => call.name === SearchFoods.name);
    if (yield* runToolCalls(session, turn.toolCalls, hooks)) return;
  }
});

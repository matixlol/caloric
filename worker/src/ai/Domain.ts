import * as Schema from "effect/Schema";
import type { FoodSearchResult } from "../search/FoodSearch.ts";

export const mealValues = ["breakfast", "lunch", "dinner", "snacks"] as const;
export const Meal = Schema.Literals(mealValues);
export type Meal = typeof Meal.Type;

// A search hit as the model and the app see it: the unified result plus the
// session-local id ("r1", "r2", ...) the model must use to reference it.
export type SearchResultFood = FoodSearchResult & { readonly resultId: string };

export interface ResolvedApprovalSuggestion {
  readonly suggestionId: string;
  readonly resultId: string;
  readonly meal: Meal;
  readonly portion: number;
  readonly reason: string;
  readonly food: SearchResultFood;
}

// Agent events streamed to the client. `assistant-delta` events are transient
// (live typing only) and never persisted for replay.
export type AgentEvent =
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "assistant-delta"; readonly text: string }
  | { readonly kind: "search"; readonly query: string; readonly foods: ReadonlyArray<SearchResultFood> }
  | {
      readonly kind: "approval";
      readonly toolCallId: string;
      readonly suggestions: ReadonlyArray<ResolvedApprovalSuggestion>;
    };

// Messages of a turn's SSE stream after the leading `{ type: "turn" }` frame.
// Durable messages (event / resolved-user-message) carry a monotonic `seq` so a
// reconnecting client can resume from a cursor; the rest are seqless.
export type DurableMessage =
  | { readonly type: "event"; readonly event: AgentEvent; readonly seq: number }
  | { readonly type: "resolved-user-message"; readonly resolvedUserMessage: string; readonly seq: number };

export type TerminalMessage =
  | { readonly type: "status"; readonly status: "ready" }
  | { readonly type: "error"; readonly error: string; readonly message: string };

export type TurnMessage =
  | DurableMessage
  | TerminalMessage
  | { readonly type: "event"; readonly event: AgentEvent }
  | { readonly type: "done" };

// What the Worker hands the session object for a user message. Media is
// already validated and base64-encoded (images as data URLs).
export type UserMessagePart =
  | { readonly type: "image"; readonly mediaType: string; readonly dataUrl: string }
  | { readonly type: "audio"; readonly mediaType: string; readonly base64: string; readonly fileName?: string };

export interface StartTurnInput {
  readonly turnId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly message: string;
  readonly media: ReadonlyArray<UserMessagePart>;
}

export type TurnLookup = "found" | "not_found" | "unauthorized";

export class AiSessionNotFound extends Schema.TaggedError<AiSessionNotFound>()("AiSessionNotFound", {
  sessionId: Schema.String,
}) {}

export class AiStoreError extends Schema.TaggedError<AiStoreError>()("AiStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

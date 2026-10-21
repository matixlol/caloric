import { and, eq } from "drizzle-orm";
import * as Prompt from "effect/ai/Prompt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Db, withRuntime } from "../db/Db.ts";
import { aiSessions } from "../db/schema.ts";
import { type SessionState, systemMessage, systemPrompt } from "./Agent.ts";
import { AiStoreError, type SearchResultFood } from "./Domain.ts";

// Conversations are stored as Effect AI's encoded `Prompt` (JSON). D1 caps a
// row at 2 MB, and photos/voice notes are inlined as base64, so oversized
// conversations drop media (replaced by a note), oldest messages first, until
// they fit. Search results the assistant can still refer to are capped too.
const conversationByteBudget = 1_500_000;
const maxStoredSearchResults = 300;
const mediaPlaceholder = "(An attachment was sent here; it is no longer available.)";

const encodePrompt = Schema.encodeEffect(Prompt.Prompt);
const decodePrompt = Schema.decodeUnknownEffect(Prompt.Prompt);

const hasMedia = (message: Prompt.Message) =>
  message.role === "user" && message.content.some((part) => part.type === "file");

const withoutMedia = (message: Prompt.Message): Prompt.Message =>
  hasMedia(message) && message.role === "user"
    ? Prompt.makeMessage("user", {
        content: message.content.map((part) =>
          part.type === "file" ? Prompt.makePart("text", { text: mediaPlaceholder }) : part,
        ),
      })
    : message;

// Insertion order is the order the assistant saw them; keep the newest.
const recentSearchResults = <A>(results: Record<string, A>): Record<string, A> => {
  const entries = Object.entries(results);
  return entries.length <= maxStoredSearchResults
    ? results
    : Object.fromEntries(entries.slice(entries.length - maxStoredSearchResults));
};

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const storeError = (message: string) => (cause: unknown) => new AiStoreError({ message, cause });

const make = Effect.gen(function* () {
  const db = yield* Db;

  const encodeConversation = Effect.fnUntraced(function* (messages: ReadonlyArray<Prompt.Message>) {
    const kept = [...messages];
    let encoded = yield* encodePrompt(Prompt.fromMessages(kept));
    for (let index = 0; index < kept.length && byteLength(encoded) > conversationByteBudget; index++) {
      if (!hasMedia(kept[index]!)) continue;
      kept[index] = withoutMedia(kept[index]!);
      encoded = yield* encodePrompt(Prompt.fromMessages(kept));
    }
    return encoded;
  });

  const create = Effect.fn("AiSessionStore.create")(
    function* (session: { readonly id: string; readonly userId: string; readonly conversation: ReadonlyArray<Prompt.Message> }) {
      const now = new Date();
      yield* db.insert(aiSessions).values({
        id: session.id,
        userId: session.userId,
        conversation: yield* encodeConversation(session.conversation),
        searchResultCounter: 1,
        searchResultsByLocalId: {},
        pendingApprovals: {},
        createdAt: now,
        updatedAt: now,
      });
    },
    Effect.mapError(storeError("Could not create the AI session.")),
    withRuntime,
  );

  const exists = Effect.fn("AiSessionStore.exists")(
    function* (sessionId: string, userId: string) {
      const rows = yield* db
        .select({ id: aiSessions.id })
        .from(aiSessions)
        .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)))
        .limit(1);
      return rows.length > 0;
    },
    Effect.mapError(storeError("Could not read the AI session.")),
    withRuntime,
  );

  const load = Effect.fn("AiSessionStore.load")(
    function* (sessionId: string, userId: string) {
      const [row] = yield* db
        .select({
          conversation: aiSessions.conversation,
          searchResultCounter: aiSessions.searchResultCounter,
          searchResultsByLocalId: aiSessions.searchResultsByLocalId,
        })
        .from(aiSessions)
        .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)))
        .limit(1);
      if (!row) return null;
      // Sessions imported from backend/ carry no usable conversation (its AI
      // SDK message format doesn't decode); they continue from a fresh one.
      const conversation = yield* decodePrompt(row.conversation).pipe(
        Effect.map((prompt) => [...prompt.content]),
        Effect.catchTag("SchemaError", () =>
          Effect.logInfo("ai.session_conversation_reset").pipe(Effect.as([systemMessage(systemPrompt)])),
        ),
      );
      return {
        id: sessionId,
        userId,
        conversation,
        searchResultCounter: row.searchResultCounter,
        // Written only by `save` below from the agent's own state.
        searchResultsByLocalId: (row.searchResultsByLocalId ?? {}) as Record<string, SearchResultFood>,
      } satisfies SessionState;
    },
    Effect.mapError(storeError("Could not load the AI session.")),
    withRuntime,
  );

  // Approval cards are client-local; any server-side pending state from older
  // sessions is cleared whenever the session is written.
  const save = Effect.fn("AiSessionStore.save")(
    function* (session: SessionState) {
      yield* db
        .update(aiSessions)
        .set({
          conversation: yield* encodeConversation(session.conversation),
          searchResultCounter: session.searchResultCounter,
          searchResultsByLocalId: recentSearchResults(session.searchResultsByLocalId),
          pendingApprovals: {},
          updatedAt: new Date(),
        })
        .where(and(eq(aiSessions.id, session.id), eq(aiSessions.userId, session.userId)));
    },
    Effect.mapError(storeError("Could not save the AI session.")),
    withRuntime,
  );

  const clearPendingApprovals = Effect.fn("AiSessionStore.clearPendingApprovals")(
    function* (sessionId: string, userId: string) {
      yield* db
        .update(aiSessions)
        .set({ pendingApprovals: {}, updatedAt: new Date() })
        .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)));
    },
    Effect.mapError(storeError("Could not save the AI session.")),
    withRuntime,
  );

  return { create, exists, load, save, clearPendingApprovals };
});

export class AiSessionStore extends Context.Service<AiSessionStore, Effect.Success<typeof make>>()(
  "caloric/ai/AiSessionStore",
) {
  static readonly layer = Layer.effect(AiSessionStore, make);
}

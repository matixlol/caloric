import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { TurnMessage } from "./Domain.ts";

// backend/'s SSE framing: one JSON payload per `data:` frame, `[DONE]` last.
const frame = (message: TurnMessage | { readonly type: "turn"; readonly turnId: string }) =>
  message.type === "done" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(message)}\n\n`;

// The turn id frame, then the turn's messages; ends after `done`.
export const turnEventStream = (turnId: string, messages: Stream.Stream<TurnMessage, unknown>) =>
  HttpServerResponse.stream(
    Stream.concat(Stream.succeed({ type: "turn" as const, turnId }), messages).pipe(
      Stream.takeUntil((message) => message.type === "done"),
      Stream.map(frame),
      Stream.encodeText,
    ),
    { contentType: "text/event-stream; charset=utf-8", headers: { "cache-control": "no-cache, no-transform" } },
  );

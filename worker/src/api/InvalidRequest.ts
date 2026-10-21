import * as Effect from "effect/Effect";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { BadRequest } from "./Errors.ts";

// backend/'s 400 messages for malformed requests, per API group. Clients show
// `message ?? error`, so a schema failure should read like the old server's.
const messages: Record<string, string> = {
  sync: "Invalid sync payload",
  search: "query is required",
  ai: "Invalid action payload",
};

// Turns request decoding failures (body, query, path) into backend/'s
// `{ "error": "..." }` 400 body instead of HttpApi's default empty 400.
export class InvalidRequest extends HttpApiMiddleware.Service<InvalidRequest>()("caloric/api/InvalidRequest", {
  error: BadRequest,
}) {
  static readonly layer = HttpApiMiddleware.layerSchemaErrorTransform(InvalidRequest, (_, { group }) =>
    Effect.fail(new BadRequest({ error: messages[group.identifier] ?? "Invalid request" })),
  );
}

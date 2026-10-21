import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Authentication } from "../api/Authentication.ts";
import { UpstreamFailure } from "../api/Errors.ts";

// POST /ai/session. The turn endpoints (POST /ai/turn, which answers with SSE
// or multipart-driven JSON, and GET /ai/turn/:turnId/stream) are raw routes:
// see `AiRoutes` in ./http.ts.

export const AiSessionPayload = Schema.Struct({
  // Recent diary entries; parsed leniently (bad entries are skipped).
  recentLogs: Schema.optionalKey(Schema.Unknown),
});

export class AiGroup extends HttpApiGroup.make("ai")
  .add(
    HttpApiEndpoint.post("session", "/session", {
      payload: AiSessionPayload,
      success: Schema.Struct({ sessionId: Schema.String, status: Schema.Literal("ready") }),
      error: UpstreamFailure,
    }),
  )
  .middleware(Authentication)
  .prefix("/ai") {}

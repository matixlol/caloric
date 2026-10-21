import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";
import { UpstreamFailure } from "../api/Errors.ts";
import { MfpSession } from "../providers/myfitnesspal/MfpSession.ts";

export const MfpHandlers = HttpApiBuilder.group(
  Api,
  "mfp",
  Effect.fn(function* (handlers) {
    const session = yield* MfpSession;
    return handlers.handle("refreshSession", () =>
      session.getAuth({ forceRefresh: true }).pipe(
        Effect.map((auth) => ({
          ok: true as const,
          refreshed: true as const,
          hasAuthorization: Boolean(auth.authorization),
          hasCookie: Boolean(auth.cookieHeader),
        })),
        Effect.tapCause((cause) => Effect.logError("mfp_session_refresh_failed", cause)),
        Effect.mapError(() => UpstreamFailure.fromCode("mfp_session_refresh_failed")),
      ),
    );
  }),
).pipe(Layer.provide(MfpSession.layer));

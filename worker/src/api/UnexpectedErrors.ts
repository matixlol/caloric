import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { UpstreamFailure } from "./Errors.ts";

// Safety net for defects (bugs, unexpected library throws). HttpApi would answer
// them with an empty 500; backend/ answered `{ error, message }` with 502, which
// clients display. Expected failures are mapped per endpoint before this runs.
export class UnexpectedErrors extends HttpApiMiddleware.Service<UnexpectedErrors>()("caloric/api/UnexpectedErrors", {
  error: UpstreamFailure,
}) {
  static readonly layer = Layer.succeed(UnexpectedErrors, (httpEffect, { group, endpoint }) =>
    httpEffect.pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("api.unexpected_error", defect).pipe(
          Effect.annotateLogs({ group: group.identifier, endpoint: endpoint.name }),
          Effect.andThen(Effect.fail(UpstreamFailure.fromCode(`${group.identifier}_failed`))),
        ),
      ),
    ),
  );
}

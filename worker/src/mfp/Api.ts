import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Authentication } from "../api/Authentication.ts";
import { UpstreamFailure } from "../api/Errors.ts";

export class MfpGroup extends HttpApiGroup.make("mfp")
  .add(
    // Forces a new browser login. Unlike backend/, this requires a signed-in
    // user: each refresh costs a captcha solve.
    HttpApiEndpoint.post("refreshSession", "/mfp/session/refresh", {
      success: Schema.Struct({
        ok: Schema.Literal(true),
        refreshed: Schema.Literal(true),
        hasAuthorization: Schema.Boolean,
        hasCookie: Schema.Boolean,
      }),
      error: UpstreamFailure,
    }),
  )
  .middleware(Authentication) {}

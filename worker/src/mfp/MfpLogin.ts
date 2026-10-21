import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Contract between the MyFitnessPal client (src/mfp, src/search) and the
// browser login that runs in a Cloudflare Container (src/container).

export const MfpLoginResult = Schema.Struct({
  cookieHeader: Schema.NonEmptyString,
  authorization: Schema.NullOr(Schema.String),
  // Playwright storage state ({ cookies, origins }) and sessionStorage dump.
  storageState: Schema.Unknown,
  sessionStorage: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});
export type MfpLoginResult = typeof MfpLoginResult.Type;

export class MfpLoginError extends Schema.TaggedError<MfpLoginError>()("MfpLoginError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class MfpLogin extends Context.Service<
  MfpLogin,
  {
    // Signs in to MyFitnessPal in a real browser (proxy + 2captcha) and
    // returns the session. Slow (tens of seconds); callers persist the result.
    readonly login: Effect.Effect<MfpLoginResult, MfpLoginError>;
  }
>()("caloric/mfp/MfpLogin") {}

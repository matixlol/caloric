import { expo } from "@better-auth/expo";
import { BetterAuth } from "@alchemy.run/better-auth";
import { RuntimeContext } from "alchemy";
import { emailOTP } from "better-auth/plugins";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Authentication, CurrentUser } from "../api/Authentication.ts";
import { ServiceUnavailable, Unauthorized } from "../api/Errors.ts";
import { Email, loginCodeEmail } from "../email/Email.ts";
import { cachedUserId, forgetSession } from "./SessionCache.ts";

// App deep-link schemes (production + dev build) Better Auth must trust.
const APP_SCHEMES = ["caloric://", "caloric://*", "caloric-dev://", "caloric-dev://*"];

const csv = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((raw) => raw.split(",").map((value) => value.trim()).filter(Boolean)),
  );

const make = Effect.gen(function* () {
  // Production reuses the Railway backend's secret so existing session
  // cookies stay valid (alchemy.run.ts refuses a prod deploy without it);
  // other stages may omit it and get an auto-provisioned random secret.
  const secret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(Config.option);
  const extraOrigins = yield* csv("AUTH_TRUSTED_ORIGINS");
  // Public origin for callback URLs; production sets it in deploy:prod. Without
  // it Better Auth derives the origin from each request (fine on workers.dev).
  const baseURL = yield* Config.String("BETTER_AUTH_URL").pipe(Config.option);
  const email = yield* Email;

  return yield* BetterAuth({
    ...(Option.isSome(secret) ? { secret: secret.value } : {}),
    ...(Option.isSome(baseURL) ? { baseURL: baseURL.value } : {}),
    trustedOrigins: ["https://caloric.mati.lol", ...APP_SCHEMES, ...extraOrigins],
    // Railway issued `__Secure-` cookies, and the iOS app replays the stored
    // cookie name verbatim; keep issuing (and reading) the same name.
    //
    // Alchemy builds a Better Auth instance (and D1 client) per request, so the
    // runtime schema check — memoized per client — would introspect every table
    // on every auth request, one D1 round trip per PRAGMA. Deploys already
    // migrate the auth schema (BetterAuthMigrate).
    //
    // Joins make a session lookup one query (session joined with its user)
    // instead of two sequential D1 round trips.
    advanced: { useSecureCookies: true, database: { validateSchema: false, joins: true } },
    // Password login is what App Store review uses; accounts are invite-only,
    // so there is no email-verification gate.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOTP: ({ email: to, otp }) =>
          Effect.runPromise(email.send({ to, ...loginCodeEmail(otp) })),
      }),
      expo(),
    ],
  });
});

export class Auth extends Context.Service<Auth, Effect.Success<typeof make>>()("caloric/auth/Auth") {
  static readonly layer = Layer.effect(Auth, make);
}

// The signed-in user's id for a request, or undefined without a valid session.
// Goes through the edge session cache (SessionCache.ts); Better Auth decides
// on a miss.
export const currentUserId = (auth: Auth["Service"], request: HttpServerRequest.HttpServerRequest) =>
  cachedUserId(
    request,
    auth
      .getSession(new Headers(request.headers as Record<string, string>))
      .pipe(Effect.map((found) => (found ? { userId: found.user.id, expiresAt: found.session.expiresAt } : null))),
  );

// Better Auth's own routes. Writes (sign-in, sign-out, session revocation)
// drop the cached user for the cookie they carried.
export const authRoutes = (auth: Auth["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* auth.fetch;
    if (request.method !== "GET") {
      yield* forgetSession(request);
    }
    return response;
  });

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return Authentication.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const userId = yield* currentUserId(auth, request).pipe(
          Effect.tapCause((cause) => Effect.logError("auth.session_lookup_failed", cause)),
          Effect.mapError(() => ServiceUnavailable.fromCode("auth_unavailable")),
        );
        if (!userId) {
          return yield* Unauthorized.instance();
        }
        return yield* Effect.provideService(httpEffect, CurrentUser, { id: userId });
      }).pipe(
        // HttpApi middleware can't declare Alchemy's per-request RuntimeContext;
        // the Worker provides the real one to every request at runtime.
        Effect.provide(RuntimeContext.phantom),
      ),
    );
  }),
);

import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api as ApiSpec } from "./api/Api.ts";
import { Auth, AuthenticationLive } from "./auth/Auth.ts";
import { withLegacySessionCookies } from "./auth/LegacySessionCookie.ts";
import { Database } from "./db/Database.ts";
import { Db } from "./db/Db.ts";
import { Email } from "./email/Email.ts";
import { InvalidRequest } from "./api/InvalidRequest.ts";
import { UnexpectedErrors } from "./api/UnexpectedErrors.ts";
import { AiHandlers, AiRoutes } from "./ai/http.ts";
import { AudioTranscoder } from "./audio/AudioTranscoder.ts";
import { AudioTranscoderLive, MfpLoginLive } from "./container/Live.ts";
import { MfpLogin } from "./mfp/MfpLogin.ts";
import { HealthHandlers } from "./health/http.ts";
import { MfpHandlers } from "./mfp/http.ts";
import { FoodSearchLive } from "./search/FoodSearchLive.ts";
import { SearchHandlers } from "./search/http.ts";
import { SocialHandlers } from "./social/http.ts";
import { SyncHandlers } from "./sync/http.ts";
import { customDomain } from "./Stage.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    // Built by scripts/build-web.ts. Asset paths (/, /web/*, /.well-known/*)
    // are answered by Cloudflare's asset layer before the Worker runs.
    assets: "./dist/public",
    ...(customDomain ? { domain: customDomain } : {}),
    // Run next to D1 instead of at the edge: authenticated requests make
    // several sequential D1 queries, and from Argentina each one is a round
    // trip to the database's primary in Miami (ENAM). No cloud region is in
    // Miami; gcp:us-east1 measured fastest (sync/bootstrap ~500ms -> ~310ms
    // from EZE) at the cost of ~170ms on requests that skip D1. Smart Placement
    // can't do this: it only picks among locations the Worker already runs in,
    // and nearly all traffic arrives at EZE. Static assets stay at the edge.
    placement: { region: "gcp:us-east1" },
    compatibility: { flags: ["nodejs_compat"], date: "2026-10-01" },
  },
  Effect.gen(function* () {
    const auth = yield* Auth;
    // Both are backed by the one MFP/ffmpeg container Durable Object.
    const mfpLogin = yield* MfpLogin;
    const audio = yield* AudioTranscoder;

    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(ApiSpec).pipe(
        Layer.provide([HealthHandlers, SyncHandlers, SocialHandlers, SearchHandlers, MfpHandlers, AiHandlers]),
        Layer.provide([AuthenticationLive, InvalidRequest.layer, UnexpectedErrors.layer]),
      ),
      // Better Auth owns everything under /api/auth (sign-in, OTP, session).
      HttpRouter.add("*", "/api/auth/*", auth.fetch),
      // Multipart turns and the resumable SSE stream (also binds the AiSession
      // Durable Object that runs turns).
      AiRoutes,
    );

    const app = yield* HttpRouter.toHttpEffect(
      routes.pipe(
        Layer.provide(FoodSearchLive),
        Layer.provide([
          Db.layer,
          Layer.succeed(Auth, auth),
          Layer.succeed(MfpLogin, mfpLogin),
          Layer.succeed(AudioTranscoder, audio),
        ]),
        Layer.provide(Http.Platform),
      ),
    );

    return { fetch: yield* withLegacySessionCookies(app) };
  }).pipe(
    Effect.provide(Auth.layer),
    Effect.provide(Layer.mergeAll(MfpLoginLive, AudioTranscoderLive)),
    Effect.provide(Email.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(CloudflareD1(Database)),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}

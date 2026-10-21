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
import { Database } from "./db/Database.ts";
import { Db } from "./db/Db.ts";
import { Email } from "./email/Email.ts";
import { AiHandlers } from "./ai/http.ts";
import { HealthHandlers } from "./health/http.ts";
import { MfpHandlers } from "./mfp/http.ts";
import { SearchHandlers } from "./search/http.ts";
import { SocialHandlers } from "./social/http.ts";
import { SyncHandlers } from "./sync/http.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"], date: "2026-10-01" },
  },
  Effect.gen(function* () {
    const auth = yield* Auth;

    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(ApiSpec).pipe(
        Layer.provide([HealthHandlers, SyncHandlers, SocialHandlers, SearchHandlers, MfpHandlers, AiHandlers]),
        Layer.provide(AuthenticationLive),
      ),
      // Better Auth owns everything under /api/auth (sign-in, OTP, session).
      HttpRouter.add("*", "/api/auth/*", auth.fetch),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        routes.pipe(
          Layer.provide([Db.layer, Layer.succeed(Auth, auth)]),
          Layer.provide(Http.Platform),
        ),
      ),
    };
  }).pipe(
    Effect.provide(Auth.layer),
    Effect.provide(Email.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(CloudflareD1(Database)),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}

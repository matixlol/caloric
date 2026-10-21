import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import Api from "./src/Api.worker.ts";
import { isProduction } from "./src/Stage.ts";

export default Alchemy.Stack(
  "Caloric",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Without Railway's secret every iOS user's session cookie stops working.
    // (Alchemy also reads worker/.env when present; keep config in .env.<stage>.)
    const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(Config.option);
    if (isProduction && Option.isNone(authSecret)) {
      return yield* Effect.die(new Error("BETTER_AUTH_SECRET must be set for prod (Railway's value, in .env.prod)."));
    }
    const api = yield* Api;
    return { url: api.url };
  }),
);

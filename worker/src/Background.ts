import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Work the response doesn't wait for, such as caching a provider response in
// D1. In a Worker request it runs under `ctx.waitUntil`; elsewhere (the AI
// session Durable Object searches too) it runs inline. Failures are only logged.
export class Background extends Context.Service<
  Background,
  { readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R> }
>()("caloric/Background") {
  static readonly layer = Layer.effect(
    Background,
    Effect.gen(function* () {
      const execution = yield* Cloudflare.WorkerExecutionContext;
      return Background.of({
        run: (effect) => {
          const work = effect.pipe(
            Effect.tapCause((cause) => Effect.logWarning("background_failed", cause)),
            Effect.ignore,
          );
          return execution.waitUntil(work).pipe(
            Effect.catchDefect(() => work),
            // Handlers can't declare Alchemy's per-request RuntimeContext; the
            // Worker provides the real one to every request at runtime.
            Effect.provide(RuntimeContext.phantom),
          );
        },
      });
    }),
  );

  // Tests run background work inline, so its writes are visible afterwards.
  static readonly inline = Layer.succeed(
    Background,
    Background.of({ run: (effect) => effect.pipe(Effect.ignore) }),
  );
}

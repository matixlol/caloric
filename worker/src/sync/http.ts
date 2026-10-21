import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";
import { CurrentUser } from "../api/Authentication.ts";
import { UpstreamFailure } from "../api/Errors.ts";
import { SyncRepository } from "./SyncRepository.ts";

const failWith = (code: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError(code, cause)),
    Effect.mapError(() => UpstreamFailure.fromCode(code)),
  );

export const SyncHandlers = HttpApiBuilder.group(
  Api,
  "sync",
  Effect.fn(function* (handlers) {
    const repository = yield* SyncRepository;
    return handlers
      .handle("bootstrap", () =>
        Effect.flatMap(CurrentUser, (user) => repository.bootstrap(user.id)).pipe(
          failWith("sync_bootstrap_failed"),
        ),
      )
      .handle("push", ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => repository.push(user.id, payload)).pipe(
          failWith("sync_push_failed"),
        ),
      );
  }),
).pipe(Layer.provide(SyncRepository.layer));

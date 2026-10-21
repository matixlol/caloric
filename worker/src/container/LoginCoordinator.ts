import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { MfpLoginError, MfpLoginResult } from "../mfp/MfpLogin.ts";

interface StoredLogin {
  readonly at: number;
  readonly result: MfpLoginResult;
}

// Coordinates browser logins inside the single MfpBrowser Durable Object:
// one login at a time, run detached so a caller that disconnects (iOS gives up
// on a search after 60s; logins take minutes) doesn't cancel it, and the
// result kept so the next caller reuses it instead of paying for another
// captcha. A stored login is only reused when it is newer than the session
// the caller already has (that one may be the session MFP just rejected).
export const makeLoginCoordinator = (options: {
  readonly run: Effect.Effect<MfpLoginResult, MfpLoginError>;
  readonly storage: {
    readonly get: Effect.Effect<StoredLogin | undefined>;
    readonly put: (login: StoredLogin) => Effect.Effect<void>;
  };
  // Keeps the object alive until the detached login settles (DO waitUntil).
  readonly keepAlive: (running: Effect.Effect<void>) => Effect.Effect<void>;
  readonly reuseWithin: number;
}) => {
  let inflight: Deferred.Deferred<MfpLoginResult, MfpLoginError> | undefined;

  const start = Effect.gen(function* () {
    const deferred = Deferred.makeUnsafe<MfpLoginResult, MfpLoginError>();
    inflight = deferred;
    const settle = options.run.pipe(
      Effect.tap((result) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((at) => options.storage.put({ at, result }))),
      ),
      Effect.exit,
      Effect.flatMap((exit) => {
        inflight = undefined;
        return Deferred.done(deferred, exit);
      }),
    );
    yield* options.keepAlive(settle);
    return deferred;
  });

  return Effect.fnUntraced(function* (newerThan: number) {
    const now = yield* Clock.currentTimeMillis;
    const stored = yield* options.storage.get;
    if (stored && stored.at > newerThan && now - stored.at < options.reuseWithin) {
      return stored.result;
    }
    return yield* Deferred.await(inflight ?? (yield* start));
  });
};

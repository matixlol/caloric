import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeLoginCoordinator } from "../src/container/LoginCoordinator.ts";
import { MfpLoginError, type MfpLoginResult } from "../src/mfp/MfpLogin.ts";

const result = (cookieHeader: string): MfpLoginResult => ({
  cookieHeader,
  authorization: null,
  storageState: { cookies: [], origins: [] },
  sessionStorage: null,
});

const setup = (run: Effect.Effect<MfpLoginResult, MfpLoginError>) => {
  let stored: { at: number; result: MfpLoginResult } | undefined;
  const login = makeLoginCoordinator({
    run,
    storage: {
      get: Effect.sync(() => stored),
      put: (value) => Effect.sync(() => void (stored = value)),
    },
    keepAlive: (running) => Effect.forkDetach(running).pipe(Effect.asVoid),
    reuseWithin: 10 * 60_000,
  });
  return { login, stored: () => stored };
};

const runTest = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

describe("LoginCoordinator", () => {
  test("concurrent callers share one browser login", () =>
    runTest(
      Effect.gen(function* () {
        let runs = 0;
        const gate = Deferred.makeUnsafe<void>();
        const { login } = setup(
          Effect.gen(function* () {
            runs += 1;
            yield* Deferred.await(gate);
            return result("shared");
          }),
        );
        const callers = yield* Effect.forkChild(Effect.all([login(0), login(0), login(0)], { concurrency: "unbounded" }));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        const results = yield* Fiber.join(callers);
        expect(runs).toBe(1);
        expect(results.map((r) => r.cookieHeader)).toEqual(["shared", "shared", "shared"]);
      }),
    ));

  test("reuses a recent login only when it is newer than the caller's session", () =>
    runTest(
      Effect.gen(function* () {
        let runs = 0;
        const { login } = setup(Effect.sync(() => result(`run=${++runs}`)));
        yield* TestClock.adjust("1 second");
        const first = yield* login(0);
        // A caller whose session predates that login gets it without a new run.
        const reused = yield* login(0);
        // A caller holding that very login (just rejected by MFP) forces a new run.
        yield* TestClock.adjust("1 second");
        const fresh = yield* login(2_000);
        expect([first.cookieHeader, reused.cookieHeader, fresh.cookieHeader]).toEqual(["run=1", "run=1", "run=2"]);
        // Logins older than the reuse window are not handed out.
        yield* TestClock.adjust("11 minutes");
        expect((yield* login(0)).cookieHeader).toBe("run=3");
      }),
    ));

  test("a failed login fails its callers and the next call runs again", () =>
    runTest(
      Effect.gen(function* () {
        let runs = 0;
        const { login, stored } = setup(
          Effect.suspend(() =>
            ++runs === 1 ? Effect.fail(new MfpLoginError({ message: "captcha" })) : Effect.succeed(result("ok")),
          ),
        );
        const failure = yield* Effect.flip(login(0));
        expect(failure.message).toBe("captcha");
        expect(stored()).toBeUndefined();
        expect((yield* login(0)).cookieHeader).toBe("ok");
      }),
    ));

  test("the login finishes and is kept even when its caller is interrupted", () =>
    runTest(
      Effect.gen(function* () {
        const gate = Deferred.makeUnsafe<void>();
        const { login, stored } = setup(Deferred.await(gate).pipe(Effect.as(result("survived"))));
        const caller = yield* Effect.forkChild(login(0));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.yieldNow;
        expect(stored()?.result.cookieHeader).toBe("survived");
      }),
    ));
});

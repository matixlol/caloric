import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Db } from "../src/db/Db.ts";
import { mfpAuthSessions } from "../src/db/schema.ts";
import { MfpLogin, MfpLoginError, type MfpLoginResult } from "../src/mfp/MfpLogin.ts";
import { MfpSession } from "../src/providers/myfitnesspal/MfpSession.ts";
import { TestDb } from "./TestDb.ts";

const loginResult = (cookie: string, overrides: Partial<MfpLoginResult> = {}): MfpLoginResult => ({
  cookieHeader: cookie,
  authorization: "eyJ_head.eyJ_body.sig_nature",
  storageState: { cookies: [{ name: "a" }], origins: [] },
  sessionStorage: { token: "x" },
  ...overrides,
});

const run = <A, E>(login: MfpLogin["Service"], effect: Effect.Effect<A, E, MfpSession | Db>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        MfpSession.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(TestDb, Layer.succeed(MfpLogin, login), Logger.layer([]))),
        ),
      ),
    ),
  );

describe("MfpSession", () => {
  test("uses the stored session without logging in", async () => {
    let logins = 0;
    const auth = await run(
      { login: Effect.sync(() => (logins += 1, loginResult("fresh"))) },
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .insert(mfpAuthSessions)
          .values({ provider: "myfitnesspal", cookieHeader: " stored=1 ", authorization: "mfp.example.com" });
        return yield* (yield* MfpSession).getAuth();
      }),
    );
    // A hostname captured from sessionStorage is not a token.
    expect(auth).toEqual({ cookieHeader: "stored=1", authorization: null });
    expect(logins).toBe(0);
  });

  test("shares one in-flight browser login between concurrent refreshes and persists it", async () => {
    let logins = 0;
    const gate = Deferred.makeUnsafe<void>();
    const login = {
      login: Effect.gen(function* () {
        logins += 1;
        yield* Deferred.await(gate);
        return loginResult(`session=${logins}`);
      }),
    };
    const [results, stored] = await run(
      login,
      Effect.gen(function* () {
        const session = yield* MfpSession;
        const refresh = session.getAuth({ forceRefresh: true });
        const [results] = yield* Effect.all(
          [
            Effect.all([refresh, refresh, refresh], { concurrency: "unbounded" }),
            Effect.sleep("10 millis").pipe(Effect.andThen(Deferred.succeed(gate, undefined))),
          ],
          { concurrency: "unbounded" },
        );
        const db = yield* Db;
        return [results, yield* db.select().from(mfpAuthSessions)] as const;
      }),
    );

    expect(logins).toBe(1);
    const expected = { cookieHeader: "session=1", authorization: "Bearer eyJ_head.eyJ_body.sig_nature" };
    expect(results).toEqual([expected, expected, expected]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      provider: "myfitnesspal",
      cookieHeader: "session=1",
      authorization: "Bearer eyJ_head.eyJ_body.sig_nature",
      storageState: { cookies: [{ name: "a" }], origins: [] },
      sessionStorage: { token: "x" },
    });
  });

  test("a failed refresh fails its callers and the next call tries again", async () => {
    let logins = 0;
    const [first, second] = await run(
      {
        login: Effect.suspend(() => {
          logins += 1;
          return logins === 1
            ? Effect.fail(new MfpLoginError({ message: "captcha" }))
            : Effect.succeed(loginResult("ok=1"));
        }),
      },
      Effect.gen(function* () {
        const session = yield* MfpSession;
        const first = yield* Effect.flip(session.getAuth());
        const second = yield* session.getAuth();
        return [first, second] as const;
      }),
    );
    expect(first._tag).toBe("MfpSessionError");
    expect(second.cookieHeader).toBe("ok=1");
    expect(logins).toBe(2);
  });

  test("rejects logins without storage state", async () => {
    const error = await run(
      { login: Effect.succeed(loginResult("c=1", { storageState: null })) },
      Effect.flatMap(MfpSession, (session) => Effect.flip(session.getAuth({ forceRefresh: true }))),
    );
    expect(error.message).toBe("MyFitnessPal refresh finished without storage state.");
  });
});

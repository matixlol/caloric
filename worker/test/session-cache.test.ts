import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { cachedUserId, sessionCookieValue } from "../src/auth/SessionCache.ts";

describe("SessionCache", () => {
  test("reads the session cookie by either name, ignoring other cookies", () => {
    expect(sessionCookieValue("a=1; __Secure-better-auth.session_token=tok.sig%3D; b=2")).toBe("tok.sig%3D");
    expect(sessionCookieValue("better-auth.session_token=tok.sig")).toBe("tok.sig");
    expect(sessionCookieValue("better-auth.session_data=x")).toBeUndefined();
    expect(sessionCookieValue("__Secure-better-auth.session_token=")).toBeUndefined();
    expect(sessionCookieValue(undefined)).toBeUndefined();
  });

  test("without the Workers cache, every call asks Better Auth", async () => {
    let lookups = 0;
    const request = HttpServerRequest.fromWeb(
      new Request("https://backend.test/sync/bootstrap", { headers: { cookie: "better-auth.session_token=tok.sig" } }),
    );
    const lookup = Effect.sync(() => {
      lookups += 1;
      return { userId: "u1", expiresAt: new Date(Date.now() + 60_000) };
    });
    const ids = await Effect.runPromise(Effect.all([cachedUserId(request, lookup), cachedUserId(request, lookup)]));
    expect(ids).toEqual(["u1", "u1"]);
    expect(lookups).toBe(2);
    expect(await Effect.runPromise(cachedUserId(request, Effect.succeed(null)))).toBeUndefined();
  });
});

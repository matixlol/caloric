import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { upgradeCookieHeader, withLegacySessionCookies } from "../src/auth/LegacySessionCookie.ts";

const previous = "old-secret-0123456789abcdef0123456789abcdef";
const current = "new-secret-0123456789abcdef0123456789abcdef";
const NAME = "__Secure-better-auth.session_token";

// The same signing better-call uses for Better Auth's session cookie.
const signed = async (token: string, secret: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`);
};

describe("upgradeCookieHeader", () => {
  test("re-signs a cookie signed with the previous secret and keeps other cookies", async () => {
    const header = `theme=dark; ${NAME}=${await signed("tok123", previous)}; other=1`;
    const upgrade = await upgradeCookieHeader(header, { current, previous });
    expect(upgrade?.cookieHeader).toBe(`theme=dark; ${NAME}=${await signed("tok123", current)}; other=1`);
    expect(encodeURIComponent(upgrade!.value)).toBe(await signed("tok123", current));
  });

  test("leaves current, unknown and malformed cookies alone", async () => {
    const secrets = { current, previous };
    expect(await upgradeCookieHeader(`${NAME}=${await signed("tok", current)}`, secrets)).toBeUndefined();
    expect(await upgradeCookieHeader(`${NAME}=${await signed("tok", "someone-elses-secret")}`, secrets)).toBeUndefined();
    expect(await upgradeCookieHeader(`${NAME}=garbage`, secrets)).toBeUndefined();
    expect(await upgradeCookieHeader(`${NAME}=%E0%A4%A`, secrets)).toBeUndefined();
    expect(await upgradeCookieHeader(`unrelated=${await signed("tok", previous)}`, secrets)).toBeUndefined();
  });
});

// Echoes the Cookie header the way Better Auth sees it: from the web Request.
const echoApp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
  return HttpServerResponse.text(web.headers.get("cookie") ?? "");
});

const serve = (cookie: string, env: Record<string, string>, app = echoApp) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const handler = yield* withLegacySessionCookies(app);
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("https://backend.test/me", { headers: { cookie } })),
        ),
      );
      return HttpServerResponse.toWeb(response);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
  );

const env = {
  BETTER_AUTH_SECRET: current,
  BETTER_AUTH_PREVIOUS_SECRET: previous,
  BETTER_AUTH_PREVIOUS_SECRET_UNTIL: new Date(Date.now() + 86_400_000).toISOString(),
};

describe("withLegacySessionCookies", () => {
  test("passes the re-signed cookie through and hands it to the client", async () => {
    const response = await serve(`${NAME}=${await signed("tok123", previous)}`, env);
    const expected = await signed("tok123", current);
    expect(await response.text()).toBe(`${NAME}=${expected}`);
    const [setCookie] = response.headers.getSetCookie();
    expect(setCookie).toStartWith(`${NAME}=${expected};`);
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  test("keeps the request body", async () => {
    const readBody = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
      return HttpServerResponse.text(yield* Effect.promise(() => web.text()));
    });
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* withLegacySessionCookies(readBody);
        const request = new Request("https://backend.test/sync/push", {
          method: "POST",
          body: JSON.stringify({ entries: [1, 2, 3] }),
          headers: { cookie: `${NAME}=${yield* Effect.promise(() => signed("tok123", previous))}` },
        });
        return HttpServerResponse.toWeb(
          yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))),
        );
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
    );
    expect(await response.text()).toBe(JSON.stringify({ entries: [1, 2, 3] }));
  });

  test("doesn't override a session cookie the response already sets", async () => {
    const signOut = Effect.succeed(HttpServerResponse.empty().pipe(HttpServerResponse.setCookieUnsafe(NAME, "", { maxAge: 0 })));
    const response = await serve(`${NAME}=${await signed("tok123", previous)}`, env, signOut);
    expect(response.headers.getSetCookie()).toEqual([`${NAME}=; Max-Age=0`]);
  });

  test("stops accepting the previous secret after the window", async () => {
    const old = `${NAME}=${await signed("tok123", previous)}`;
    const response = await serve(old, { ...env, BETTER_AUTH_PREVIOUS_SECRET_UNTIL: new Date(Date.now() - 1000).toISOString() });
    expect(await response.text()).toBe(old);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("is off without a previous secret", async () => {
    const old = `${NAME}=${await signed("tok123", previous)}`;
    const response = await serve(old, { BETTER_AUTH_SECRET: current });
    expect(await response.text()).toBe(old);
  });
});

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// BETTER_AUTH_SECRET was rotated at the Railway cutover (Railway's Oct 21
// environment-variable leak). Session cookies are `<token>.<HMAC-SHA256(token)>`
// and Better Auth only verifies them with the current secret, so until
// BETTER_AUTH_PREVIOUS_SECRET_UNTIL the Worker also accepts cookies signed with
// the previous secret: it re-signs them for the request and sends the client
// the re-signed cookie. The iOS app saves it from get-session (on launch and
// resume); browsers and the Expo client from any response. Sessions last 7 days
// from their last use, so a window of 8 days covers every live session.

const SESSION_COOKIE_NAMES = ["__Secure-better-auth.session_token", "better-auth.session_token"];
// Better Auth's default session lifetime (session.expiresIn).
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const sign = async (value: string, secret: string) => {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
};

const verify = async (value: string, signature: string, secret: string) => {
  try {
    const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, new TextEncoder().encode(value));
  } catch {
    return false;
  }
};

export interface CookieUpgrade {
  // The request's Cookie header with the session cookie re-signed.
  readonly cookieHeader: string;
  readonly name: string;
  // `<token>.<signature>`, not URI-encoded.
  readonly value: string;
}

// Re-signs the session cookie in `cookieHeader` when it is signed with
// `previous` rather than `current`. Mirrors better-call's signed cookies.
export const upgradeCookieHeader = async (
  cookieHeader: string,
  secrets: { readonly current: string; readonly previous: string },
): Promise<CookieUpgrade | undefined> => {
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const [index, part] of parts.entries()) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator);
    if (separator < 1 || !SESSION_COOKIE_NAMES.includes(name)) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(separator + 1));
    } catch {
      return undefined;
    }
    const dot = value.lastIndexOf(".");
    const token = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    if (dot < 1 || signature.length !== 44 || !signature.endsWith("=")) return undefined;
    if (await verify(token, signature, secrets.current)) return undefined;
    if (!(await verify(token, signature, secrets.previous))) return undefined;

    const resigned = `${token}.${await sign(token, secrets.current)}`;
    parts[index] = `${name}=${encodeURIComponent(resigned)}`;
    return { cookieHeader: parts.join("; "), name, value: resigned };
  }
  return undefined;
};

const setsSessionCookie = (response: HttpServerResponse.HttpServerResponse) =>
  SESSION_COOKIE_NAMES.some((name) => name in response.cookies.cookies);

// Wraps the Worker's HTTP app. A no-op unless both secrets are configured and
// the window hasn't passed.
export const withLegacySessionCookies = Effect.fnUntraced(function* <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>,
) {
  const current = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(Config.option);
  const previous = yield* Config.Redacted("BETTER_AUTH_PREVIOUS_SECRET").pipe(Config.option);
  const until = yield* Config.Date("BETTER_AUTH_PREVIOUS_SECRET_UNTIL").pipe(Config.option);
  if (Option.isNone(current) || Option.isNone(previous) || Option.isNone(until)) return app;
  const secrets = { current: Redacted.value(current.value), previous: Redacted.value(previous.value) };
  const deadline = until.value.getTime();

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader || Date.now() >= deadline) return yield* app;
    const upgrade = yield* Effect.promise(() => upgradeCookieHeader(cookieHeader, secrets));
    if (!upgrade) return yield* app;

    // Better Auth reads the underlying web Request, so rebuild that rather
    // than only overriding the Effect request's headers.
    const source = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const headers = new Headers(source.headers);
    headers.set("cookie", upgrade.cookieHeader);
    const upgraded = HttpServerRequest.fromWeb(new Request(source, { headers }));
    yield* Effect.logInfo("auth.legacy_session_cookie_upgraded");

    const response = yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, upgraded));
    // Sign-in, sign-out and session refreshes already set the cookie themselves.
    return setsSessionCookie(response)
      ? response
      : HttpServerResponse.setCookieUnsafe(response, upgrade.name, upgrade.value, {
          maxAge: `${SESSION_MAX_AGE_SECONDS} seconds`,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        });
  });
});

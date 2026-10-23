import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { SESSION_COOKIE_NAMES } from "./LegacySessionCookie.ts";

// Every authenticated request starts with Better Auth's session lookup, a D1
// round trip (~145ms from Buenos Aires to the database in Miami). The user a
// session cookie resolves to is cached in the data center's Cache API for a
// few minutes, so most requests skip it.
//
// The key is a hash of the whole signed cookie value, so only cookies Better
// Auth has verified are ever cached. Any POST to /api/auth/* (sign-out,
// session revocation, sign-in) forgets the cookie it carries. A session
// revoked from another device, or a deleted account, stays usable for at most
// TTL_SECONDS here.
const TTL_SECONDS = 300;

interface CachedSession {
  readonly userId: string;
  readonly expiresAt: number;
}

export const sessionCookieValue = (cookieHeader: string | null | undefined): string | undefined => {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (SESSION_COOKIE_NAMES.includes(part.slice(0, separator).trim())) {
      const value = part.slice(separator + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
};

// The Cache API exists on Workers only (not under bun test).
const edgeCache = (): Cache | undefined =>
  typeof caches === "undefined" ? undefined : (caches as unknown as { default: Cache }).default;

// Keys live under the request's own origin (the zone's cache).
const cacheKey = async (request: HttpServerRequest.HttpServerRequest, cookie: string) => {
  const origin = Option.match(HttpServerRequest.toURL(request), {
    onNone: () => "https://caloric.invalid",
    onSome: (url) => url.origin,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`${origin}/__session-cache/${hex}`);
};

const read = (cache: Cache, key: Request) =>
  Effect.promise(async () => {
    const response = await cache.match(key);
    if (!response) return undefined;
    const cached = (await response.json()) as CachedSession;
    return cached.expiresAt > Date.now() ? cached : undefined;
  }).pipe(Effect.catchDefect(() => Effect.succeed(undefined)));

const write = (cache: Cache, key: Request, session: CachedSession) => {
  const maxAge = Math.min(TTL_SECONDS, Math.floor((session.expiresAt - Date.now()) / 1000));
  if (maxAge <= 0) return Effect.void;
  return Effect.promise(() =>
    cache.put(key, new Response(JSON.stringify(session), { headers: { "cache-control": `max-age=${maxAge}` } })),
  ).pipe(Effect.catchDefect(() => Effect.void));
};

/**
 * Resolves a request's session cookie to its user id, through the edge cache.
 * `lookup` is Better Auth's session lookup for the same headers; it decides
 * on a miss (and whenever there is no cache or no session cookie).
 */
export const cachedUserId = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  lookup: Effect.Effect<{ readonly userId: string; readonly expiresAt: Date } | null, E, R>,
): Effect.Effect<string | undefined, E, R> =>
  Effect.gen(function* () {
    const cache = edgeCache();
    const cookie = sessionCookieValue(request.headers.cookie);
    if (!cache || !cookie) {
      return (yield* lookup)?.userId;
    }
    const key = yield* Effect.promise(() => cacheKey(request, cookie));
    const cached = yield* read(cache, key);
    if (cached) return cached.userId;

    const session = yield* lookup;
    if (!session) return undefined;
    yield* write(cache, key, { userId: session.userId, expiresAt: session.expiresAt.getTime() });
    return session.userId;
  });

// Drops the cached user for the request's session cookie.
export const forgetSession = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cache = edgeCache();
    const cookie = sessionCookieValue(request.headers.cookie);
    if (!cache || !cookie) return;
    const key = yield* Effect.promise(() => cacheKey(request, cookie));
    yield* Effect.promise(() => cache.delete(key)).pipe(Effect.catchDefect(() => Effect.void));
  });

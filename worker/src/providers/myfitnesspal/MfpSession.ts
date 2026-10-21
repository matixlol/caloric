import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Db, withRuntime } from "../../db/Db.ts";
import { mfpAuthSessions } from "../../db/schema.ts";
import { MfpLogin } from "../../mfp/MfpLogin.ts";
import { normalizeAuthorization } from "./authorization.ts";

const MFP_PROVIDER = "myfitnesspal";

export interface MfpRequestAuth {
  readonly authorization: string | null;
  readonly cookieHeader: string;
}

export class MfpSessionError extends Schema.TaggedError<MfpSessionError>()("MfpSessionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Playwright storage state; anything else means the login didn't finish.
const StorageState = Schema.Struct({
  cookies: Schema.Array(Schema.Unknown),
  origins: Schema.Array(Schema.Unknown),
});

const make = Effect.gen(function* () {
  const db = yield* Db;
  const login = yield* MfpLogin;

  const readStored = Effect.fn("MfpSession.readStored")(
    function* () {
      const [row] = yield* db
        .select({
          authorization: mfpAuthSessions.authorization,
          cookieHeader: mfpAuthSessions.cookieHeader,
          refreshedAt: mfpAuthSessions.refreshedAt,
        })
        .from(mfpAuthSessions)
        .where(eq(mfpAuthSessions.provider, MFP_PROVIDER))
        .limit(1);
      const cookieHeader = row?.cookieHeader?.trim();
      return {
        refreshedAt: row?.refreshedAt.getTime() ?? 0,
        auth: cookieHeader
          ? Option.some({ authorization: normalizeAuthorization(row?.authorization, true), cookieHeader })
          : Option.none<MfpRequestAuth>(),
      };
    },
    withRuntime,
    Effect.mapError((cause) => new MfpSessionError({ message: "Failed to read the stored MFP session", cause })),
  );

  const refreshNow = Effect.fn("MfpSession.refresh")(
    function* (newerThan: number) {
      const result = yield* login.login({ newerThan });
      yield* Schema.decodeUnknownEffect(StorageState)(result.storageState).pipe(
        Effect.mapError(
          (cause) => new MfpSessionError({ message: "MyFitnessPal refresh finished without storage state.", cause }),
        ),
      );
      const cookieHeader = result.cookieHeader.trim();
      if (!cookieHeader) {
        return yield* new MfpSessionError({ message: "MyFitnessPal refresh finished without a cookie header." });
      }
      const authorization = normalizeAuthorization(result.authorization, true);
      const now = new Date();
      const values = {
        storageState: result.storageState,
        sessionStorage: result.sessionStorage,
        authorization,
        cookieHeader,
        refreshedAt: now,
        updatedAt: now,
      };
      yield* db
        .insert(mfpAuthSessions)
        .values({ provider: MFP_PROVIDER, createdAt: now, ...values })
        .onConflictDoUpdate({ target: mfpAuthSessions.provider, set: values });
      return { authorization, cookieHeader } satisfies MfpRequestAuth;
    },
    withRuntime,
    Effect.mapError((cause) =>
      cause._tag === "MfpSessionError" ? cause : new MfpSessionError({ message: "MyFitnessPal refresh failed", cause }),
    ),
  );

  // The stored session, or a fresh browser login when there is none (or the
  // caller saw MFP reject the stored one).
  const getAuth = Effect.fn("MfpSession.getAuth")(function* (options?: { readonly forceRefresh?: boolean }) {
    const stored = yield* readStored();
    if (!options?.forceRefresh && Option.isSome(stored.auth)) {
      return stored.auth.value;
    }
    // Concurrent refreshes share one browser login in the MfpBrowser object,
    // which may also hand back a login newer than the stored session.
    return yield* refreshNow(stored.refreshedAt);
  });

  return { getAuth };
});

export class MfpSession extends Context.Service<MfpSession, Effect.Success<typeof make>>()(
  "caloric/providers/MfpSession",
) {
  static readonly layer = Layer.effect(MfpSession, make);
}

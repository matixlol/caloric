import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";
import { CurrentUser } from "../api/Authentication.ts";
import { BadRequest, NotFound, UpstreamFailure } from "../api/Errors.ts";
import { DateKey, FriendCodePayload, ProfilePayload, RequestIdPayload } from "./Domain.ts";
import { SocialConflict } from "./Errors.ts";
import { Social } from "./Social.ts";

type ClientError = BadRequest | NotFound | SocialConflict;

const isClientError = (error: unknown): error is ClientError =>
  error instanceof BadRequest || error instanceof NotFound || error instanceof SocialConflict;

// Client errors keep their status and message; anything else is logged and
// becomes backend/'s 502 with the endpoint's error code.
const failWith =
  (code: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, ClientError> | UpstreamFailure, R> =>
    effect.pipe(
      Effect.tapError((error) => (isClientError(error) ? Effect.void : Effect.logError(code, error))),
      Effect.mapError((error) =>
        isClientError(error) ? (error as Extract<E, ClientError>) : UpstreamFailure.fromCode(code),
      ),
    );

// Strict like backend/'s zod `.strict()`: unknown keys are a 400 too.
const decodeOr =
  <A>(schema: Schema.Decoder<A>, error: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new BadRequest({ error })),
    );

// Unparseable bodies decode as null (and then fail validation), as in backend/.
const parseJson = (body: string) =>
  Effect.try(() => JSON.parse(body) as unknown).pipe(Effect.orElseSucceed(() => null));

const INVALID_FRIEND_REQUEST_PAYLOAD = "Invalid friend request payload";
const decodeProfile = decodeOr(ProfilePayload, "Invalid profile payload");
const decodeFriendCode = decodeOr(FriendCodePayload, INVALID_FRIEND_REQUEST_PAYLOAD);
const decodeRequestId = decodeOr(RequestIdPayload, INVALID_FRIEND_REQUEST_PAYLOAD);
const decodeDateKey = decodeOr(DateKey, "Invalid dateKey");

export const SocialHandlers = HttpApiBuilder.group(
  Api,
  "social",
  Effect.fn(function* (handlers) {
    const social = yield* Social;
    return handlers
      .handle("overview", () =>
        Effect.flatMap(CurrentUser, (user) => social.overview(user.id)).pipe(failWith("social_overview_failed")),
      )
      .handle("updateProfile", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const { displayName } = yield* decodeProfile(yield* parseJson(payload));
          return yield* social.updateProfile(user.id, displayName);
        }).pipe(failWith("social_profile_failed")),
      )
      .handle("sendFriendRequest", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const { friendCode } = yield* decodeFriendCode(yield* parseJson(payload));
          return yield* social.sendFriendRequest(user.id, friendCode);
        }).pipe(failWith("social_friend_request_failed")),
      )
      .handle("acceptFriendRequest", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const { requestId } = yield* decodeRequestId(yield* parseJson(payload));
          return yield* social.acceptFriendRequest(user.id, requestId);
        }).pipe(failWith("social_accept_request_failed")),
      )
      .handle("ignoreFriendRequest", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const { requestId } = yield* decodeRequestId(yield* parseJson(payload));
          return yield* social.ignoreFriendRequest(user.id, requestId);
        }).pipe(failWith("social_ignore_request_failed")),
      )
      .handle("removeFriend", ({ params }) =>
        Effect.flatMap(CurrentUser, (user) => social.removeFriend(user.id, params.friendUserId)).pipe(
          failWith("social_remove_friend_failed"),
        ),
      )
      .handle("dailySummaries", ({ query }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const dateKey = yield* decodeDateKey(query.dateKey);
          return yield* social.dailySummaries(user.id, dateKey);
        }).pipe(failWith("social_daily_summaries_failed")),
      )
      .handle("friendDay", ({ params, query }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const friendUserId = params.friendUserId.trim();
          if (!friendUserId) {
            return yield* new BadRequest({ error: "Invalid friend id" });
          }
          const dateKey = yield* decodeDateKey(query.dateKey);
          return yield* social.friendDay(user.id, friendUserId, dateKey);
        }).pipe(failWith("social_friend_day_failed")),
      );
  }),
).pipe(Layer.provide(Social.layer));

import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { Authentication } from "../api/Authentication.ts";
import { BadRequest, NotFound, UpstreamFailure } from "../api/Errors.ts";
import { FriendDailyDayResponse, FriendDailySummariesResponse, SocialOverview } from "./Domain.ts";
import { SocialConflict } from "./Errors.ts";

// Bodies (raw JSON text) and `dateKey` are declared loosely and validated in
// the handlers so invalid input, including empty or malformed JSON, gets
// backend/'s 400 `{ "error": ... }` bodies instead of HttpApi's empty 400.
const JsonBody = Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" }));
const DateKeyQuery = { dateKey: Schema.optional(Schema.String) };
const FriendParams = { friendUserId: Schema.String };

export class SocialGroup extends HttpApiGroup.make("social")
  .add(
    HttpApiEndpoint.get("overview", "/me", {
      success: SocialOverview,
      error: UpstreamFailure,
    }),
    HttpApiEndpoint.post("updateProfile", "/profile", {
      payload: JsonBody,
      success: SocialOverview,
      error: [BadRequest, UpstreamFailure],
    }),
    HttpApiEndpoint.post("sendFriendRequest", "/friend-requests", {
      payload: JsonBody,
      success: SocialOverview,
      error: [BadRequest, NotFound, SocialConflict, UpstreamFailure],
    }),
    HttpApiEndpoint.post("acceptFriendRequest", "/friend-requests/accept", {
      payload: JsonBody,
      success: SocialOverview,
      error: [BadRequest, UpstreamFailure],
    }),
    HttpApiEndpoint.post("ignoreFriendRequest", "/friend-requests/ignore", {
      payload: JsonBody,
      success: SocialOverview,
      error: [BadRequest, UpstreamFailure],
    }),
    HttpApiEndpoint.delete("removeFriend", "/friends/:friendUserId", {
      params: FriendParams,
      success: SocialOverview,
      error: UpstreamFailure,
    }),
    HttpApiEndpoint.get("dailySummaries", "/daily-summaries", {
      query: DateKeyQuery,
      success: FriendDailySummariesResponse,
      error: [BadRequest, UpstreamFailure],
    }),
    HttpApiEndpoint.get("friendDay", "/friends/:friendUserId/day", {
      params: FriendParams,
      query: DateKeyQuery,
      success: FriendDailyDayResponse,
      error: [BadRequest, NotFound, UpstreamFailure],
    }),
  )
  .middleware(Authentication)
  .prefix("/social") {}

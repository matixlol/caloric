import * as Schema from "effect/Schema";

// Error bodies keep backend/'s wire shape: `{ "error": string, "message"?: string }`.
// Clients read `message ?? error`; the extra `_tag` field is ignored by them.

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { error: Schema.Literal("Unauthorized") },
  { httpApiStatus: 401 },
) {
  static readonly instance = () => new Unauthorized({ error: "Unauthorized" });
}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { error: Schema.String },
  { httpApiStatus: 404 },
) {}

// Unexpected failures. `error` is a stable code per endpoint (for example
// "sync_push_failed"); details go to logs, never to the client.
export class UpstreamFailure extends Schema.TaggedError<UpstreamFailure>()(
  "UpstreamFailure",
  { error: Schema.String, message: Schema.String },
  { httpApiStatus: 502 },
) {
  static readonly fromCode = (error: string) => new UpstreamFailure({ error, message: "Unknown error." });
}

// A dependency (database, auth store) is down. Distinct from 401 so clients
// don't treat an outage as being signed out.
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { error: Schema.String, message: Schema.String },
  { httpApiStatus: 503 },
) {
  static readonly fromCode = (error: string) =>
    new ServiceUnavailable({ error, message: "Service temporarily unavailable." });
}

import * as Schema from "effect/Schema";

// 409 for friend requests that conflict with the pair's current state
// ("Already friends", "Friend request already pending"), backend/'s wire shape.
export class SocialConflict extends Schema.TaggedError<SocialConflict>()(
  "SocialConflict",
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}

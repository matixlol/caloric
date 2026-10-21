import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Contract for voice-note transcoding (implemented by the container in
// src/container). The assistant model only accepts WAV/MP3/FLAC; iOS records m4a.

export class AudioTranscodeError extends Schema.TaggedError<AudioTranscodeError>()("AudioTranscodeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class AudioTranscoder extends Context.Service<
  AudioTranscoder,
  {
    readonly toWav: (
      audio: Uint8Array,
      mediaType: string,
    ) => Effect.Effect<Uint8Array, AudioTranscodeError>;
  }
>()("caloric/audio/AudioTranscoder") {}

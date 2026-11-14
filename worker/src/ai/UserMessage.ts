import * as Prompt from "effect/ai/Prompt";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import { AudioTranscoder } from "../audio/AudioTranscoder.ts";
import type { StartTurnInput, VoiceNote } from "./Domain.ts";
import { fallbackAudioMediaType } from "./TurnRequest.ts";

// Several audio-native models only accept WAV/MP3/FLAC, so phones keep
// uploading compact m4a and the container decodes it. If that fails the
// original upload is sent as-is.
const voiceNotePart = Effect.fnUntraced(function* (audio: VoiceNote) {
  const transcoder = yield* AudioTranscoder;
  const { mediaType, bytes } = yield* transcoder.toWav(audio.bytes, audio.contentType).pipe(
    Effect.map((wav) => ({ mediaType: "audio/wav", bytes: wav })),
    Effect.tapCause((cause) => Effect.logError("ai_audio_decode_failed", cause)),
    Effect.orElseSucceed(() => ({ mediaType: fallbackAudioMediaType(audio.contentType), bytes: audio.bytes })),
  );
  return Prompt.makePart("file", {
    mediaType,
    data: Base64.encode(bytes),
    ...(audio.fileName ? { fileName: audio.fileName } : {}),
  });
});

// The conversation message for a user turn: text, then photos, then the voice note.
export const userMessage = Effect.fnUntraced(function* (input: StartTurnInput) {
  const text = input.message ? [Prompt.makePart("text", { text: input.message })] : [];
  const images = input.images.map((image) => Prompt.makePart("file", { mediaType: image.mediaType, data: image.dataUrl }));
  const audio = input.audio ? [yield* voiceNotePart(input.audio)] : [];
  return Prompt.makeMessage("user", { content: [...text, ...images, ...audio] });
});

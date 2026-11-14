import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { AudioTranscodeError, AudioTranscoder } from "../src/audio/AudioTranscoder.ts";
import type { StartTurnInput } from "../src/ai/Domain.ts";
import { userMessage } from "../src/ai/UserMessage.ts";

const input = (overrides: Partial<StartTurnInput>): StartTurnInput => ({
  turnId: "turn",
  sessionId: "session",
  userId: "user",
  message: "",
  images: [],
  ...overrides,
});

const voiceNote = { contentType: "audio/m4a", bytes: new Uint8Array([1, 2, 3]), fileName: "voice.m4a" };

const run = (turn: StartTurnInput, toWav: AudioTranscoder["Service"]["toWav"]) =>
  Effect.runPromise(userMessage(turn).pipe(Effect.provideService(AudioTranscoder, AudioTranscoder.of({ toWav }))));

describe("userMessage", () => {
  test("decodes the voice note to WAV after the text and photos", async () => {
    const calls: Array<string> = [];
    const message = await run(
      input({ message: "lunch", images: [{ mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==" }], audio: voiceNote }),
      (bytes, mediaType) => {
        calls.push(`${mediaType}:${bytes.length}`);
        return Effect.succeed(new Uint8Array([9, 9]));
      },
    );
    expect(calls).toEqual(["audio/m4a:3"]);
    expect(message.role).toBe("user");
    const content = message.content as ReadonlyArray<{ type: string; mediaType?: string; data?: unknown; text?: string; fileName?: string }>;
    expect(content.map((part) => part.type)).toEqual(["text", "file", "file"]);
    expect(content[0]?.text).toBe("lunch");
    expect(content[1]?.mediaType).toBe("image/jpeg");
    expect(content[2]).toMatchObject({ mediaType: "audio/wav", data: "CQk=", fileName: "voice.m4a" });
  });

  test("falls back to the original upload when decoding fails", async () => {
    const message = await run(input({ audio: voiceNote }), () =>
      Effect.fail(new AudioTranscodeError({ message: "container unavailable" })),
    );
    const content = message.content as ReadonlyArray<{ mediaType?: string; data?: unknown }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ mediaType: "audio/m4a", data: "AQID" });
  });

  test("text-only turns never touch the transcoder", async () => {
    const message = await run(input({ message: "two eggs" }), () => Effect.die("unexpected transcode"));
    expect((message.content as ReadonlyArray<{ type: string }>).map((part) => part.type)).toEqual(["text"]);
  });
});

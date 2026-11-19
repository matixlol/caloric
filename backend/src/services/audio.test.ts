import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { transcodeAudioToWav } from "./audio";

describe("transcodeAudioToWav", () => {
  test("decodes an AAC voice note to 16 kHz mono WAV", async () => {
    // One second of tone encoded as m4a with the index at the end, like iOS recordings.
    const path = `${tmpdir()}/caloric-audio-test-${process.pid}.m4a`;
    await Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", path]).exited;
    const m4a = new Uint8Array(await Bun.file(path).arrayBuffer());
    await Bun.file(path).delete();
    const wav = await transcodeAudioToWav(m4a);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    // Real chunk sizes, not the 0xFFFFFFFF placeholders a piped WAV carries.
    expect(wav.readUInt32LE(4)).toBe(wav.byteLength - 8);
    const data = wav.indexOf("data");
    expect(wav.readUInt32LE(data + 4)).toBe(wav.byteLength - data - 8);
  });

  test("rejects input that is not audio", async () => {
    await expect(transcodeAudioToWav(new TextEncoder().encode("not audio"))).rejects.toThrow("Could not decode the voice note");
  });
});

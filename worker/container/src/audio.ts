// Ported from backend/src/services/audio.ts. Decodes any recorded voice note
// (m4a/AAC from iOS, WebM/Opus from browsers) to 16 kHz mono 16-bit WAV. The
// input goes through a temp file because iOS m4a keeps its index at the end,
// which ffmpeg cannot reach on a non-seekable pipe.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class AudioDecodeFailure extends Error {
  override name = "AudioDecodeFailure";
}

export async function transcodeAudioToWav(
  input: Uint8Array,
  options: { ffmpegPath?: string; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "caloric-audio-"));
  try {
    const source = join(dir, "input");
    // Writing to a file (not a pipe) lets ffmpeg seek back and fill in the RIFF
    // and data chunk sizes; piped WAVs carry 0xFFFFFFFF, which some providers reject.
    const target = join(dir, "output.wav");
    await writeFile(source, input);
    const proc = spawn(
      options.ffmpegPath ?? "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", target],
      { stdio: ["ignore", "ignore", "pipe"], signal: options.signal },
    );
    const stderr: Buffer[] = [];
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", resolve);
    });
    const output = code === 0 ? await readFile(target) : Buffer.alloc(0);
    if (code !== 0 || output.byteLength <= 44) {
      const errors = Buffer.concat(stderr).toString("utf8").trim().slice(0, 200);
      throw new AudioDecodeFailure(`Could not decode the voice note (ffmpeg ${code}): ${errors}`);
    }
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

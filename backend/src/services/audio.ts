import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Decodes any recorded voice note (m4a/AAC from iOS, WebM/Opus from browsers) to
// 16 kHz mono 16-bit WAV, the one format every audio-capable model accepts.
// Requires ffmpeg on PATH (installed in the Railway image, see railway.toml).
// The input goes through a temp file because iOS m4a keeps its index at the
// end, which ffmpeg cannot reach on a non-seekable pipe.
export async function transcodeAudioToWav(input: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "caloric-audio-"));
  try {
    const source = join(dir, "input");
    // Writing to a file (not a pipe) lets ffmpeg seek back and fill in the RIFF
    // and data chunk sizes; piped WAVs carry 0xFFFFFFFF, which some providers reject.
    const target = join(dir, "output.wav");
    await writeFile(source, input);
    const proc = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", target],
      { stdout: "ignore", stderr: "pipe", signal },
    );
    const [errors, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const output = code === 0 ? await Bun.file(target).arrayBuffer() : new ArrayBuffer(0);
    if (code !== 0 || output.byteLength <= 44) {
      throw new Error(`Could not decode the voice note (ffmpeg ${code}): ${errors.trim().slice(0, 200)}`);
    }
    return Buffer.from(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

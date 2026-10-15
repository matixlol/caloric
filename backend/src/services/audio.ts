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
    await writeFile(source, input);
    const proc = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
      { stdout: "pipe", stderr: "pipe", signal },
    );
    const [output, errors, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 || output.byteLength <= 44) {
      throw new Error(`Could not decode the voice note (ffmpeg ${code}): ${errors.trim().slice(0, 200)}`);
    }
    return Buffer.from(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

import { createParser } from "eventsource-parser";
import type { AgentEvent } from "../../mobile/src/ai/types";

export const maxAttachments = 4;
const maxImageEdge = 1600;

export type Attachment = { id: string; blob: Blob; url: string };

// Downscale photos before upload; the model gains nothing from 12 MP originals.
export async function prepareImage(file: Blob): Promise<Attachment> {
  let blob: Blob = file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxImageEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("encode"))), "image/jpeg", 0.82),
    );
  } catch {
    // Formats the browser cannot decode (e.g. HEIC outside Safari) go up as-is.
  }
  if (blob.size > 8 * 1024 * 1024) throw new Error("That photo is too large. Try a smaller one.");
  return { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob) };
}

export function imageFiles(items: Iterable<File> | null | undefined): File[] {
  return Array.from(items ?? []).filter((file) => file.type.startsWith("image/"));
}

// Streams one assistant turn, resuming from the last durable event when the
// connection drops. Mirrors the classic client's protocol handling.
export async function streamTurn({
  body,
  headers,
  signal,
  onEvent,
}: {
  body: BodyInit;
  headers?: HeadersInit;
  signal: AbortSignal;
  onEvent: (event: AgentEvent, durable: boolean) => void;
}) {
  let turnId: string | null = null;
  let seq = -1;
  let terminal = false;
  let failure: unknown;
  async function consume(response: Response) {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      terminal = true;
      throw new Error(payload.message || payload.error || "Assistant request failed.");
    }
    if (!response.body) throw new Error("The assistant returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createParser({
      onEvent: ({ data }) => {
        if (data === "[DONE]") return;
        const payload = JSON.parse(data);
        if (payload.type === "turn") turnId = payload.turnId;
        if (typeof payload.seq === "number") {
          if (payload.seq <= seq) return;
          seq = payload.seq;
        }
        if (payload.type === "event") onEvent(payload.event, typeof payload.seq === "number");
        if (payload.type === "error") {
          terminal = true;
          throw new Error(payload.message || "The assistant could not finish.");
        }
        if (payload.type === "status" && payload.status === "ready") {
          terminal = true;
          failure = undefined;
        }
      },
    });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          parser.feed(decoder.decode());
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel();
    }
  }
  try {
    await consume(await fetch("/ai/turn", { method: "POST", credentials: "same-origin", headers, body, signal }));
  } catch (error) {
    failure = error;
  }
  for (let retry = 0; !terminal && turnId && retry < 3 && !signal.aborted; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await consume(
        await fetch(`/ai/turn/${encodeURIComponent(turnId)}/stream?cursor=${seq}`, { credentials: "same-origin", signal }),
      );
    } catch (error) {
      failure = error;
    }
  }
  if (failure && terminal) throw failure;
  if (!terminal) throw new Error("The connection was interrupted. Check your journal before sending again.");
}

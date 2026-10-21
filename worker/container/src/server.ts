// HTTP surface of the container. The Worker reaches it through the
// MfpBrowser Durable Object (worker/src/container).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AudioDecodeFailure } from "./audio.ts";
import type { MfpLoginResult } from "./mfp/session.ts";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 60_000;

export type ServerDeps = {
  login: (signal: AbortSignal) => Promise<MfpLoginResult>;
  toWav: (audio: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  loginTimeoutMs?: number;
};

class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpFailure(413, `Audio is larger than ${limit} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) {
      throw new HttpFailure(413, `Audio is larger than ${limit} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function isAudioMediaType(value: string | undefined): boolean {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType.startsWith("audio/") || mediaType.startsWith("video/") || mediaType === "application/octet-stream";
}

export function makeServer(deps: ServerDeps): Server {
  const loginTimeoutMs = deps.loginTimeoutMs ?? 240_000;
  // One browser at a time: concurrent callers share the in-flight login.
  let inflightLogin: Promise<MfpLoginResult> | null = null;

  const login = () => {
    if (!inflightLogin) {
      const startedAt = Date.now();
      const signal = AbortSignal.timeout(loginTimeoutMs);
      inflightLogin = deps
        .login(signal)
        .then(
          (result) => {
            console.log(`mfp.login ok in ${Date.now() - startedAt}ms`);
            return result;
          },
          (error: unknown) => {
            console.error(`mfp.login failed in ${Date.now() - startedAt}ms`, error);
            throw error;
          },
        )
        .finally(() => {
          inflightLogin = null;
        });
    }
    return inflightLogin;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://container");
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /health":
        return sendJson(res, 200, { ok: true });

      case "POST /mfp/login": {
        req.resume();
        try {
          return sendJson(res, 200, await login());
        } catch (error) {
          return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      case "POST /audio/wav": {
        if (!isAudioMediaType(req.headers["content-type"])) {
          req.resume();
          throw new HttpFailure(415, "Content-Type must be an audio media type.");
        }
        const audio = await readBody(req, MAX_AUDIO_BYTES);
        if (audio.byteLength === 0) {
          throw new HttpFailure(400, "Audio body is empty.");
        }
        try {
          const wav = await deps.toWav(audio, AbortSignal.timeout(AUDIO_TIMEOUT_MS));
          res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.byteLength });
          return res.end(wav);
        } catch (error) {
          if (error instanceof AudioDecodeFailure) {
            throw new HttpFailure(422, error.message);
          }
          throw error;
        }
      }

      default:
        req.resume();
        if (["/health", "/mfp/login", "/audio/wav"].includes(url.pathname)) {
          throw new HttpFailure(405, "Method not allowed.");
        }
        throw new HttpFailure(404, "Not found.");
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpFailure) {
        // Drop the rest of an oversized upload instead of reading it.
        if (error.status === 413) res.setHeader("connection", "close");
        return sendJson(res, error.status, { error: error.message });
      }
      console.error(`${req.method} ${req.url} failed`, error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error" });
    });
  });
}

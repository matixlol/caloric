import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcodeAudioToWav } from "../container/src/audio.ts";
import { buildCookieHeader, findAuthorizationValue, getProxyConfig, normalize2CaptchaProxy, toLoginResult } from "../container/src/mfp/session.ts";
import { makeServer } from "../container/src/server.ts";

const ffmpeg = Bun.which("ffmpeg") ?? (await Bun.file("/opt/homebrew/bin/ffmpeg").exists() ? "/opt/homebrew/bin/ffmpeg" : null);

const json = (response: Response): Promise<any> => response.json();

const loginResult = {
  cookieHeader: "a=1",
  authorization: null,
  storageState: { cookies: [], origins: [] },
  sessionStorage: null,
};

describe("container server", () => {
  let logins = 0;
  let failLogin = false;
  const server = makeServer({
    login: async () => {
      logins += 1;
      await Bun.sleep(50);
      if (failLogin) throw new Error("Turnstile sitekey was not found.");
      return loginResult;
    },
    toWav: (audio, signal) => transcodeAudioToWav(audio, { signal, ...(ffmpeg ? { ffmpegPath: ffmpeg } : {}) }),
  });
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  test("health", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
  });

  test("unknown routes and methods", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/mfp/login`)).status).toBe(405);
  });

  test("concurrent logins share one browser run", async () => {
    logins = 0;
    const responses = await Promise.all([1, 2, 3].map(() => fetch(`${base}/mfp/login`, { method: "POST" })));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await json(responses[0]!)).toEqual(loginResult);
    expect(logins).toBe(1);
  });

  test("login failures are 502 with the message", async () => {
    failLogin = true;
    const response = await fetch(`${base}/mfp/login`, { method: "POST" });
    failLogin = false;
    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({ error: "Turnstile sitekey was not found." });
  });

  test("audio validation", async () => {
    const wrongType = await fetch(`${base}/audio/wav`, { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
    expect(wrongType.status).toBe(415);
    const empty = await fetch(`${base}/audio/wav`, { method: "POST", body: new Uint8Array(), headers: { "content-type": "audio/mp4" } });
    expect(empty.status).toBe(400);
  });

  test.skipIf(!ffmpeg)("undecodable audio is 422", async () => {
    const response = await fetch(`${base}/audio/wav`, {
      method: "POST",
      body: new TextEncoder().encode("definitely not audio"),
      headers: { "content-type": "audio/mp4" },
    });
    expect(response.status).toBe(422);
    expect((await json(response)).error).toContain("Could not decode the voice note");
  });

  test.skipIf(!ffmpeg)("m4a becomes 16 kHz mono WAV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "container-test-"));
    try {
      const m4a = join(dir, "note.m4a");
      const proc = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", m4a]);
      expect(await proc.exited).toBe(0);
      const response = await fetch(`${base}/audio/wav`, {
        method: "POST",
        body: await readFile(m4a),
        headers: { "content-type": "audio/mp4" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      const wav = new DataView(await response.arrayBuffer());
      expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe("RIFF");
      expect(wav.getUint16(22, true)).toBe(1);
      expect(wav.getUint32(24, true)).toBe(16000);
      expect(wav.getUint16(34, true)).toBe(16);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mfp session helpers", () => {
  const storageState = {
    cookies: [
      { name: "__Secure-next-auth.session-token", value: "tok", domain: ".myfitnesspal.com", expires: -1 },
      { name: "expired", value: "x", domain: "www.myfitnesspal.com", expires: 1 },
      { name: "other", value: "y", domain: ".example.com", expires: -1 },
    ],
    origins: [],
  };

  test("cookie header keeps live MFP cookies only", () => {
    expect(buildCookieHeader(storageState)).toBe("__Secure-next-auth.session-token=tok");
  });

  test("authorization is found in nested session payloads", () => {
    const jwt = "aaa.bbb.ccc";
    expect(findAuthorizationValue({ user: { accessToken: jwt } })).toBe(`Bearer ${jwt}`);
    expect(findAuthorizationValue(JSON.stringify({ token: "x".repeat(30) }))).toBe(`Bearer ${"x".repeat(30)}`);
    expect(findAuthorizationValue({ name: "short" })).toBeNull();
  });

  test("login result mirrors session.ts checks", () => {
    expect(toLoginResult({ authorization: "Bearer www.myfitnesspal.com", storageState, sessionStorage: { k: "v", n: 1 } })).toEqual({
      cookieHeader: "__Secure-next-auth.session-token=tok",
      authorization: null,
      storageState,
      sessionStorage: { k: "v" },
    });
    expect(() => toLoginResult({ authorization: null, storageState: { cookies: [] }, sessionStorage: null })).toThrow(
      "without storage state",
    );
    expect(() => toLoginResult({ authorization: null, storageState: { cookies: [], origins: [] }, sessionStorage: null })).toThrow(
      "without a cookie header",
    );
  });

  test("proxy urls", () => {
    expect(getProxyConfig("http://us%40er:p%3Ass@proxy.example:8000")).toEqual({
      server: "http://proxy.example:8000",
      username: "us@er",
      password: "p:ss",
    });
    expect(normalize2CaptchaProxy("https://u:p@proxy.example:8000")).toEqual({ proxy: "u:p@proxy.example:8000", proxyType: "HTTP" });
    expect(getProxyConfig(" ")).toBeUndefined();
  });
});

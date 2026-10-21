import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { normalizeAuthorization } from "../src/providers/myfitnesspal/authorization.ts";
import { buildBarcodeRequest, parseBarcodeResponse } from "../src/providers/myfitnesspal/barcodeProtocol.ts";
import { MfpBarcodeClient } from "../src/providers/myfitnesspal/MfpBarcodeClient.ts";
import { getMfpNetCarbs } from "../src/providers/myfitnesspal/nutrition.ts";
import { OpenFoodFactsClient } from "../src/providers/openFoodFacts/OpenFoodFactsClient.ts";
import { ProviderConfig } from "../src/providers/ProviderConfig.ts";

const fromHex = (value: string) =>
  Uint8Array.from(value.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));

const NUTELLA_RESPONSE = fromHex(`
  04 d3 00 00 00 1a 00 01 00 66 00 00 00 00 00 00 00 01 01 00 00 00 00 00 00 01
  04 d3 00 00 01 01 00 01 00 1f a1 cf af 38 00 0e 35 34 30 33 30 32 30 32 39 33 32 37 38 39
  0c a3 c2 91 0e c2 80 2c 00 0f 32 36 35 31 35 31 38 38 31 39 39 38 31 38 39 00 0f 4e 75
  74 65 6c 6c 61 20 46 65 72 72 65 72 6f 00 07 4e 75 74 65 6c 6c 61 00 00 00 00 00 01
  42 a0 00 00 40 a0 00 00 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3f 80 00 00
  40 c9 99 9a 00 00 00 00 41 10 00 00 00 00 00 00 41 00 00 00 3f 80 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 41 70 00 00 00 00 00 05 41 70 00 00 41 70 00 00
  00 01 67 00 00 3f 80 00 00 3f 80 00 00 00 01 67 00 00 3f 80 00 00 44 61 00 00 00 16
  63 6f 6e 74 61 69 6e 65 72 20 28 39 30 30 20 67 73 20 65 61 2e 29 00 00 3f 00 00 00
  41 62 cb 92 00 05 6f 75 6e 63 65 00 00 3f 80 00 00 41 e2 cb fb 00 05 6f 75 6e 63 65 00 00
`);

interface Recorded {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

const mockHttp = (respond: (url: URL) => Response) => {
  const calls: Array<Recorded> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        calls.push({ url, headers: request.headers });
        return HttpClientResponse.fromWeb(request, respond(url));
      }),
    ),
  );
  return { calls, layer };
};

const configLayer = (values: Record<string, string>) =>
  ProviderConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))));

describe("MFP barcode binary protocol", () => {
  test("builds information and barcode-search packets", () => {
    const request = buildBarcodeRequest("3017624010701", "00112233-4455-6677-8899-aabbccddeeff");
    expect(request[0]).toBe(0x04);
    expect(request[1]).toBe(0xd3);
    expect(new TextDecoder().decode(request)).toContain("3017624010701");
  });

  test("decodes a real MFP food response", () => {
    const result = parseBarcodeResponse(NUTELLA_RESPONSE);
    expect(result.resultCode).toBe(0x100);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0]).toMatchObject({
      name: "Nutella Ferrero",
      brand: "Nutella",
      serving: "15 g",
      nutrition: { calories: 80, fat: 5, carbs: 9, sugars: 8, protein: 1 },
    });
    // No undefined keys: the payload is cached as JSON and served as-is.
    expect(Object.values(result.foods[0]!.nutrition)).not.toContain(undefined);
  });

  test("rejects truncated responses", () => {
    expect(() => parseBarcodeResponse(NUTELLA_RESPONSE.subarray(0, 40))).toThrow();
  });
});

describe("MFP nutrition", () => {
  test("prefers explicit net carbs", () => {
    expect(getMfpNetCarbs(23, 8, 15)).toBe(15);
  });

  test("derives net carbs when MFP only provides totals", () => {
    expect(getMfpNetCarbs(23, 8)).toBe(15);
    expect(getMfpNetCarbs(9, undefined)).toBe(9);
  });
});

describe("MFP authorization", () => {
  const jwt = "eyJ_head.eyJ_body.sig_nature";
  test("normalizes bearer tokens", () => {
    expect(normalizeAuthorization(jwt)).toBe(`Bearer ${jwt}`);
    expect(normalizeAuthorization(`bearer  ${jwt}`)).toBe(`Bearer ${jwt}`);
    expect(normalizeAuthorization("www.myfitnesspal.com", true)).toBeNull();
    expect(normalizeAuthorization("x".repeat(30))).toBeNull();
    expect(normalizeAuthorization("x".repeat(30), true)).toBe(`Bearer ${"x".repeat(30)}`);
    expect(normalizeAuthorization("  ")).toBeNull();
  });
});

describe("MfpBarcodeClient", () => {
  test("posts the sync packet with the guest token and parses the reply", async () => {
    const http = mockHttp(() => new Response(NUTELLA_RESPONSE));
    const result = await Effect.gen(function* () {
      const client = yield* MfpBarcodeClient;
      return yield* client.lookup("5403020293278");
    }).pipe(
      Effect.provide(
        MfpBarcodeClient.layer.pipe(Layer.provide([configLayer({ MFP_GUEST_ACCESS_TOKEN: "guest" }), http.layer])),
      ),
      Effect.runPromise,
    );
    expect(result.status).toBe(200);
    expect(result.data?.foods[0]?.name).toBe("Nutella Ferrero");
    expect(http.calls[0]?.url.host).toBe("sync.myfitnesspal.com");
    expect(http.calls[0]?.headers["authorization"]).toBe("Bearer guest");
    expect(http.calls[0]?.headers["traceparent"]).toBeUndefined();
  });

  test("fails as not configured without a guest token", async () => {
    const http = mockHttp(() => new Response(""));
    const error = await Effect.gen(function* () {
      const client = yield* MfpBarcodeClient;
      return yield* client.lookup("5403020293278");
    }).pipe(
      Effect.flip,
      Effect.provide(MfpBarcodeClient.layer.pipe(Layer.provide([configLayer({}), http.layer]))),
      Effect.runPromise,
    );
    expect(error._tag).toBe("MfpBarcodeNotConfigured");
    expect(http.calls).toHaveLength(0);
  });
});

describe("OpenFoodFactsClient", () => {
  test("queries the search endpoint and keeps non-JSON bodies as text", async () => {
    const http = mockHttp((url) =>
      url.searchParams.get("page") === "1" ? Response.json({ products: [] }) : new Response("busy", { status: 503 }),
    );
    const [ok, busy] = await Effect.gen(function* () {
      const client = yield* OpenFoodFactsClient;
      return [
        yield* client.search({ query: "yogur", page: 1, pageSize: 8 }),
        yield* client.search({ query: "yogur", page: 2, pageSize: 8 }),
      ] as const;
    }).pipe(
      Effect.provide(
        OpenFoodFactsClient.layer.pipe(
          Layer.provide([
            configLayer({ OPEN_FOOD_FACTS_BASE_URL: "https://off.test/", OPEN_FOOD_FACTS_USER_EMAIL: "a@b.c" }),
            http.layer,
          ]),
        ),
      ),
      Effect.runPromise,
    );
    expect(ok).toMatchObject({ status: 200, json: { products: [] }, text: null });
    expect(busy).toMatchObject({ status: 503, json: null, text: "busy" });
    const url = http.calls[0]!.url;
    expect(url.origin + url.pathname).toBe("https://off.test/cgi/search.pl");
    expect(url.searchParams.get("search_terms")).toBe("yogur");
    expect(url.searchParams.get("page_size")).toBe("8");
    expect(http.calls[0]!.headers["from"]).toBe("a@b.c");
  });
});

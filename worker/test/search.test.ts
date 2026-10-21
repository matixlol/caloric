import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Authentication } from "../src/api/Authentication.ts";
import { Unauthorized } from "../src/api/Errors.ts";
import { InvalidRequest } from "../src/api/InvalidRequest.ts";
import { UnexpectedErrors } from "../src/api/UnexpectedErrors.ts";
import { Db } from "../src/db/Db.ts";
import { anmatProductDerivedData, anmatProducts, mfpAuthSessions } from "../src/db/schema.ts";
import { MfpGroup } from "../src/mfp/Api.ts";
import { MfpHandlers } from "../src/mfp/http.ts";
import { MfpLogin } from "../src/mfp/MfpLogin.ts";
import { SearchGroup } from "../src/search/Api.ts";
import { FoodSearch } from "../src/search/FoodSearch.ts";
import { FoodSearchLive } from "../src/search/FoodSearchLive.ts";
import { SearchHandlers } from "../src/search/http.ts";
import { ilikeContainsPattern } from "../src/search/SearchRepository.ts";
import { SearchService } from "../src/search/SearchService.ts";
import { mergeFoodResults, rankAnmatRows, scoreSearchField, type AnmatRow } from "../src/search/mapping.ts";
import { TestDb } from "./TestDb.ts";

// --- Mock upstreams -------------------------------------------------------------

type Respond = (url: URL) => Response | "network-error";

const mfpSearchBody = {
  items: [
    {
      item: {
        id: 1,
        version: "v1",
        description: "Apple",
        brand_name: "Farm",
        serving_sizes: [{ value: 1, unit: "medium" }],
        nutritional_contents: { energy: { value: 95 }, carbohydrates: 25, fiber: 4 },
      },
    },
    { item: { id: 2, version: "v2", description: "No nutrition anywhere" } },
    { item: { id: 1, version: "v1", description: "Apple duplicate" } },
  ],
};

const mfpDetailBody = {
  id: 1,
  version: "v1",
  description: "Apple (detail)",
  brand_name: "Farm",
  serving_sizes: [{ value: "1", unit: "large" }],
  nutritional_contents: { energy: { value: 110 }, protein: "0.5", carbohydrates: 29, fiber: 5, sodium: 2 },
};

const offBody = {
  count: 1,
  products: [
    {
      code: "123",
      product_name: "Apple juice",
      brands: "OFFCo",
      quantity: "1 L",
      nutriments: { "energy-kcal_100g": 46, carbohydrates_100g: 11, sodium_100g: 0.004, sodium_unit: "g" },
    },
    { code: "456", product_name: "No nutriments" },
  ],
};

const defaultRespond: Respond = (url) => {
  if (url.pathname === "/api/nutrition") return Response.json(mfpSearchBody);
  if (url.pathname === "/api/services/foods/1") return Response.json(mfpDetailBody);
  if (url.pathname === "/api/services/foods/2") return new Response("boom", { status: 500 });
  if (url.pathname === "/cgi/search.pl") return Response.json(offBody);
  return new Response("not found", { status: 404 });
};

const makeEnv = (respond: Respond = defaultRespond, config: Record<string, string> = {}) => {
  const calls: Array<URL> = [];
  const logins = { count: 0 };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.suspend(() => {
        calls.push(url);
        const response = respond(url);
        return response === "network-error"
          ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
          : Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );
  const login = Layer.succeed(
    MfpLogin,
    MfpLogin.of({
      login: () => Effect.sync(() => {
        logins.count += 1;
        return {
          cookieHeader: `session=${logins.count}`,
          authorization: "Bearer eyJ_head.eyJ_body.sig_nature",
          storageState: { cookies: [], origins: [] },
          sessionStorage: null,
        };
      }),
    }),
  );
  const configProvider = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ OPEN_FOOD_FACTS_BASE_URL: "https://off.test", ...config }),
  );
  const deps = Layer.mergeAll(TestDb, http, login, configProvider, Logger.layer([]));
  return { calls, logins, deps };
};

const runWith = <A, E>(
  env: ReturnType<typeof makeEnv>,
  effect: Effect.Effect<A, E, SearchService | FoodSearch | Db>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.mergeAll(SearchService.layer, FoodSearchLive).pipe(Layer.provideMerge(env.deps))),
    ),
  );

// --- Pure ranking ---------------------------------------------------------------

const anmatRow = (overrides: Partial<AnmatRow>): AnmatRow => ({
  productId: 1,
  ingestSource: "disk_import",
  detailKey: null,
  rnpa: null,
  denominacion: null,
  nombreFantasia: null,
  marca: null,
  titular: null,
  importedAt: new Date(0),
  nutritionFound: true,
  servingText: null,
  servingQuantity: null,
  servingUnit: null,
  calories: 100,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
  fiberGrams: null,
  sugarsGrams: null,
  sodiumMg: null,
  ...overrides,
});

describe("search ranking", () => {
  test("scores exact, prefix, all-token, substring and token matches", () => {
    const tokens = ["dulce", "leche"];
    expect(scoreSearchField("Dulce de Leche", "dulce de leche", tokens)).toBe(140);
    expect(scoreSearchField("dulce de leche clásico", "dulce de leche", tokens)).toBe(90);
    expect(scoreSearchField("leche y dulce", "dulce leche", tokens)).toBe(60);
    expect(scoreSearchField("super yogur", "yogur", ["yogur"])).toBe(40);
    expect(scoreSearchField("leche", "dulce leche", tokens)).toBe(8);
    expect(scoreSearchField(null, "x", ["x"])).toBe(0);
  });

  test("ranks ANMAT rows and keeps the best row per product", () => {
    const foods = rankAnmatRows(
      [
        anmatRow({ productId: 1, nombreFantasia: "Yogur entero", detailKey: "a" }),
        anmatRow({ productId: 2, nombreFantasia: "Yogur", detailKey: "b" }),
        anmatRow({ productId: 3, nombreFantasia: "Yogur", detailKey: "b", ingestSource: "live_search" }),
        anmatRow({ productId: 4, nombreFantasia: "Yogur sin datos", detailKey: "c", calories: null }),
      ],
      "yogur",
      10,
    );
    expect(foods.map((food) => food.id)).toEqual(["anmat:3", "anmat:1"]);
    expect(foods[0]).toEqual({
      id: "anmat:3",
      canonicalKey: "anmat:detail:b",
      source: "anmat",
      sourceLabel: "ANMAT",
      name: "Yogur",
      nutrition: { calories: 100 },
    });
  });

  test("merges sources in priority order without duplicates", () => {
    const food = (key: string) => ({ id: key, canonicalKey: key, source: "mfp" as const, sourceLabel: "MFP" as const, name: key });
    expect(mergeFoodResults([[food("a"), food("b")], [food("b"), food("c"), food("d")]], 3).map((f) => f.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("builds case-insensitive GLOB patterns like ILIKE", () => {
    expect(ilikeContainsPattern("Ñu*")).toBe("*[Ññ][uU][*]*");
    expect(ilikeContainsPattern("a%b_")).toBe("*[aA]*[bB]?*");
  });
});

// --- SearchService ----------------------------------------------------------------

describe("SearchService", () => {
  test("unified search lists MFP (details preferred) before Open Food Facts and caches responses", async () => {
    const env = makeEnv();
    const [first, second, stored] = await runWith(
      env,
      Effect.gen(function* () {
        const search = yield* FoodSearch;
        const first = yield* search.searchUnified("apple", 5);
        const second = yield* search.searchUnified("apple", 5);
        const db = yield* Db;
        const stored = yield* db.select().from(mfpAuthSessions);
        return [first, second, stored] as const;
      }),
    );

    expect(first).toEqual([
      {
        id: "mfp:1:v1",
        canonicalKey: "mfp:1:v1",
        source: "mfp",
        sourceLabel: "MFP",
        name: "Apple (detail)",
        brand: "Farm",
        serving: "1 large",
        nutrition: { calories: 110, protein: 0.5, carbs: 24, fiber: 5, sodiumMg: 2 },
      },
      {
        id: "off:123",
        canonicalKey: "off:123",
        source: "openfoodfacts",
        sourceLabel: "OFF",
        name: "Apple juice",
        brand: "OFFCo",
        serving: "1 L (per 100g)",
        nutrition: { calories: 46, carbs: 11, sodiumMg: 4 },
      },
    ]);
    expect(second).toEqual(first);
    // The second search is served from D1, except the detail that failed
    // (only 2xx responses are cache hits).
    expect(env.calls.map((url) => url.pathname).sort()).toEqual([
      "/api/nutrition",
      "/api/services/foods/1",
      "/api/services/foods/2",
      "/api/services/foods/2",
      "/cgi/search.pl",
    ]);
    const nutrition = env.calls.find((url) => url.pathname === "/api/nutrition")!;
    expect(Object.fromEntries(nutrition.searchParams)).toEqual({
      query: "apple",
      offset: "0",
      max_items: "10",
      country_code: "US",
      resource_type: "foods",
    });
    // No stored MFP session: one browser login, persisted for later requests.
    expect(env.logins.count).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ provider: "myfitnesspal", cookieHeader: "session=1" });
  });

  test("unified search survives one failing source and fails when both do", async () => {
    const offDown = makeEnv((url) => (url.host === "off.test" ? "network-error" : defaultRespond(url)));
    const foods = await runWith(offDown, Effect.flatMap(FoodSearch, (search) => search.searchUnified("apple", 5)));
    expect(foods.map((food) => food.id)).toEqual(["mfp:1:v1"]);

    const allDown = makeEnv(() => "network-error");
    const error = await runWith(
      allDown,
      Effect.flatMap(FoodSearch, (search) => Effect.flip(search.searchUnified("apple", 5))),
    );
    expect(error._tag).toBe("FoodSearchError");
  });

  test("paginates a single source with aligned windows", async () => {
    const env = makeEnv();
    const [mfp, off] = await runWith(
      env,
      Effect.gen(function* () {
        const search = yield* SearchService;
        return [
          yield* search.searchBySource("mfp", "apple", 20, 2),
          yield* search.searchBySource("openfoodfacts", "apple", 20, 2),
        ] as const;
      }),
    );
    const nutrition = env.calls.find((url) => url.pathname === "/api/nutrition")!;
    expect(nutrition.searchParams.get("offset")).toBe("20");
    expect(nutrition.searchParams.get("max_items")).toBe("20");
    expect(mfp.hasMore).toBe(false);
    const offCall = env.calls.find((url) => url.pathname === "/cgi/search.pl")!;
    expect(offCall.searchParams.get("page")).toBe("2");
    expect(offCall.searchParams.get("page_size")).toBe("20");
    expect(off.hasMore).toBe(false);
  });

  test("refreshes a rejected stored MFP session once and retries", async () => {
    let nutritionCalls = 0;
    const env = makeEnv((url) => {
      if (url.pathname === "/api/nutrition") {
        nutritionCalls += 1;
        return nutritionCalls === 1 ? new Response("expired", { status: 401 }) : Response.json({ items: [] });
      }
      return defaultRespond(url);
    });
    const foods = await runWith(
      env,
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(mfpAuthSessions).values({ provider: "myfitnesspal", cookieHeader: "session=old" });
        const search = yield* SearchService;
        return (yield* search.searchBySource("mfp", "apple", 20, 1)).foods;
      }),
    );
    expect(foods).toEqual([]);
    expect(nutritionCalls).toBe(2);
    expect(env.logins.count).toBe(1);
  });

  test("searches the ANMAT catalog case-insensitively, including accented letters", async () => {
    const foods = await runWith(
      makeEnv(),
      Effect.gen(function* () {
        const db = yield* Db;
        const products = yield* db
          .insert(anmatProducts)
          .values([
            { sourcePath: "a", runKey: "r", htmlSha256: "x", nombreFantasia: "Ñandú Light", marca: "Pampa" },
            { sourcePath: "b", runKey: "r", htmlSha256: "y", denominacion: "Galletitas", marca: "Ñandú" },
            { sourcePath: "c", runKey: "r", htmlSha256: "z", denominacion: "Otra cosa" },
          ])
          .returning({ id: anmatProducts.id });
        yield* db.insert(anmatProductDerivedData).values(
          products.map((product) => ({ productId: product.id, nutritionFound: true, calories: 50, proteinGrams: "1.5" })),
        );
        const search = yield* SearchService;
        return (yield* search.searchBySource("anmat", "ñANDÚ", 10, 1)).foods;
      }),
    );
    // An exact brand match (140 * 0.85) outranks a name prefix match (90 * 1.2).
    expect(foods.map((food) => food.name)).toEqual(["Galletitas", "Ñandú Light"]);
    expect(foods[0]).toMatchObject({ brand: "Ñandú", nutrition: { calories: 50, protein: 1.5 } });
  });
});

// --- HTTP wire format ---------------------------------------------------------------

const NUTELLA = Uint8Array.from(
  `04 d3 00 00 00 1a 00 01 00 66 00 00 00 00 00 00 00 01 01 00 00 00 00 00 00 01
  04 d3 00 00 01 01 00 01 00 1f a1 cf af 38 00 0e 35 34 30 33 30 32 30 32 39 33 32 37 38 39
  0c a3 c2 91 0e c2 80 2c 00 0f 32 36 35 31 35 31 38 38 31 39 39 38 31 38 39 00 0f 4e 75
  74 65 6c 6c 61 20 46 65 72 72 65 72 6f 00 07 4e 75 74 65 6c 6c 61 00 00 00 00 00 01
  42 a0 00 00 40 a0 00 00 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3f 80 00 00
  40 c9 99 9a 00 00 00 00 41 10 00 00 00 00 00 00 41 00 00 00 3f 80 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 41 70 00 00 00 00 00 05 41 70 00 00 41 70 00 00
  00 01 67 00 00 3f 80 00 00 3f 80 00 00 00 01 67 00 00 3f 80 00 00 44 61 00 00 00 16
  63 6f 6e 74 61 69 6e 65 72 20 28 39 30 30 20 67 73 20 65 61 2e 29 00 00 3f 00 00 00
  41 62 cb 92 00 05 6f 75 6e 63 65 00 00 3f 80 00 00 41 e2 cb fb 00 05 6f 75 6e 63 65 00 00`
    .trim()
    .split(/\s+/)
    .map((byte) => Number.parseInt(byte, 16)),
);
// The same packets with the status packet's result code set to "no matches"
// and no food packet.
const NO_MATCHES = NUTELLA.slice(0, 26).map((byte, index) => (index === 19 ? 0x01 : byte));

// Same API id as the app's, so the app's handler layers plug in.
class TestApi extends HttpApi.make("caloric").add(SearchGroup).add(MfpGroup).middleware(InvalidRequest).middleware(UnexpectedErrors) {}

const makeHandler = (env: ReturnType<typeof makeEnv>) => {
  const deny = Layer.succeed(Authentication, Authentication.of(() => Effect.fail(Unauthorized.instance())));
  const app = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide([SearchHandlers, MfpHandlers]),
    Layer.provide([deny, InvalidRequest.layer, UnexpectedErrors.layer]),
    Layer.provide(env.deps),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(app, { disableLogger: true });
};

const call = async (env: ReturnType<typeof makeEnv>, path: string, init?: RequestInit) => {
  const { handler, dispose } = makeHandler(env);
  try {
    const response = await handler(new Request(`http://worker.test${path}`, init));
    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    await dispose();
  }
};

describe("search HTTP API", () => {
  test("GET /search requires a query", async () => {
    expect(await call(makeEnv(), "/search")).toMatchObject({ status: 400, body: { error: "query is required" } });
  });

  test("GET /search returns the unified response envelope", async () => {
    const { status, body } = await call(makeEnv(), "/search?query=%20apple%20&maxItems=abc&provider=nope");
    expect(status).toBe(200);
    expect(body).toMatchObject({ query: "apple", provider: null, page: 1, hasMore: false });
    expect((body as { foods: Array<unknown> }).foods).toHaveLength(2);
  });

  test("GET /search?provider= returns one source page", async () => {
    const { body } = await call(makeEnv(), "/search?query=apple&provider=openfoodfacts&page=99");
    expect(body).toMatchObject({ query: "apple", provider: "openfoodfacts", page: 10, hasMore: false });
    expect((body as { foods: Array<{ id: string }> }).foods.map((food) => food.id)).toEqual(["off:123"]);
  });

  test("GET /search maps upstream failures to search_failed", async () => {
    expect(await call(makeEnv(() => "network-error"), "/search?query=apple")).toEqual({
      status: 502,
      body: expect.objectContaining({ error: "search_failed", message: "Unknown error." }),
    });
  });

  test("GET /search/barcode validates, looks up and caches", async () => {
    const env = makeEnv(() => new Response(NUTELLA), { MFP_GUEST_ACCESS_TOKEN: "guest" });
    expect(await call(env, "/search/barcode/123")).toMatchObject({
      status: 400,
      body: { error: "Barcode must be an EAN-8 or EAN-13 value." },
    });

    const { handler, dispose } = makeHandler(env);
    const responses = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handler(new Request("http://worker.test/search/barcode/5403020293278"));
      responses.push({ status: response.status, body: (await response.json()) as Record<string, unknown> });
    }
    await dispose();
    expect(responses[0]).toMatchObject({
      status: 200,
      body: {
        barcode: "5403020293278",
        provider: "mfp",
        cached: false,
        foods: [
          {
            id: "mfp:barcode:2714742584:54030202932789",
            source: "mfp",
            sourceLabel: "MFP",
            name: "Nutella Ferrero",
            brand: "Nutella",
            serving: "15 g",
          },
        ],
      },
    });
    expect(responses[1]).toMatchObject({ status: 200, body: { cached: true } });
    expect(env.calls).toHaveLength(1);
  });

  test("GET /search/barcode returns 404 with an empty food list for unknown barcodes", async () => {
    const env = makeEnv(() => new Response(NO_MATCHES), { MFP_GUEST_ACCESS_TOKEN: "guest" });
    expect(await call(env, "/search/barcode/12345678")).toEqual({
      status: 404,
      body: expect.objectContaining({ barcode: "12345678", provider: "mfp", cached: false, foods: [] }),
    });
  });

  test("GET /search/barcode is 503 without a guest token", async () => {
    expect(await call(makeEnv(), "/search/barcode/12345678")).toEqual({
      status: 503,
      body: expect.objectContaining({ error: "Barcode lookup is not configured." }),
    });
  });

  test("POST /search/anmat-live queues queries leniently", async () => {
    const env = makeEnv();
    expect(await call(env, "/search/anmat-live", { method: "POST", body: "not json" })).toMatchObject({
      status: 400,
      body: { error: "query is required" },
    });
    const { status, body } = await call(env, "/search/anmat-live", {
      method: "POST",
      body: JSON.stringify({ query: " yogur ", maxItems: 20 }),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ query: "yogur", foods: [], queued: true, searchRequestId: 1 });
    expect(typeof (body as { queuedAt: unknown }).queuedAt).toBe("string");
  });

  test("POST /mfp/session/refresh requires a signed-in user", async () => {
    const env = makeEnv();
    expect(await call(env, "/mfp/session/refresh", { method: "POST" })).toMatchObject({
      status: 401,
      body: { error: "Unauthorized" },
    });
    expect(env.logins.count).toBe(0);
  });
});

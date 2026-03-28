import { load } from "cheerio";

export const SEARCH_URL = "https://inal.sifega.anmat.gob.ar/consultadealimentos/";
export const SITE_ORIGIN = "https://inal.sifega.anmat.gob.ar";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/143.0.7499.4 Safari/537.36";
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type SearchMode = "registros" | "informacionNutricional";

export type SearchInput = {
  denominacion: string;
  fantasia: string;
  marca: string;
  mode?: SearchMode;
};

export type Product = {
  searchMode: SearchMode;
  province: string | null;
  rnpa: string;
  detailUrl: string | null;
  denominacion: string | null;
  nombreFantasia: string | null;
  marca: string | null;
  titular: string | null;
  estado: string | null;
  extra?: Record<string, string>;
  rawCells?: string[];
};

export type SearchResponse = {
  currentPage: number;
  totalPages: number;
  noResultsText: string;
  resultsHtml: string;
};

export type TextResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
};

export async function createSessionCookie(
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string> {
  const response = await fetch(SEARCH_URL, {
    headers: baseHeaders(),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`ANMAT session bootstrap failed with ${response.status}`);
  }

  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new Error("ANMAT did not return a session cookie");
  }

  return cookie;
}

export async function fetchSearchXml(
  cookie: string,
  input: SearchInput,
  page?: number,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<TextResponse> {
  const body = buildRequestBody(input, page);
  const response = await fetch(new URL("index.server.php", SEARCH_URL), {
    method: "POST",
    headers: {
      ...baseHeaders(),
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      Method: "POST index.server.php HTTP/1.1",
    },
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`ANMAT search failed with ${response.status}`);
  }

  return {
    status: response.status,
    url: response.url,
    headers: headersToObject(response.headers),
    text: await response.text(),
  };
}

export async function fetchText(
  url: string,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  extraHeaders: Record<string, string> = {},
): Promise<TextResponse> {
  try {
    return await fetchTextOnce(url, requestTimeoutMs, extraHeaders, false);
  } catch (error) {
    if (!shouldRetryWithoutTlsVerification(error)) {
      throw error;
    }

    return fetchTextOnce(url, requestTimeoutMs, extraHeaders, true);
  }
}

export function parseSearchResponse(xml: string): SearchResponse {
  const $ = load(xml, { xmlMode: true });
  const commandValues = new Map<string, string>();

  $("cmd").each((_, element) => {
    const command = $(element).attr("n");
    const target = $(element).attr("t");
    const property = $(element).attr("p");

    if (!command || !target || !property || command !== "as") {
      return;
    }

    commandValues.set(`${target}:${property}`, $(element).text());
  });

  const currentPage = parsePageNumber(commandValues.get("page:value")) ?? 1;
  const totalPages = Math.max(
    currentPage,
    parsePageNumber(commandValues.get("actualPageSearchAdd:innerHTML")) ?? 0,
    parsePageNumber(commandValues.get("actualPageSearchSub:innerHTML")) ?? 0,
    parsePageNumber(commandValues.get("lastPageSearch:innerHTML")) ?? 0,
  );

  return {
    currentPage,
    totalPages: totalPages || 1,
    noResultsText: normalizeText(commandValues.get("no:innerHTML")) ?? "",
    resultsHtml: commandValues.get("table-result2:innerHTML") ?? "",
  };
}

export function parseProductsFromHtml(html: string, mode: SearchMode = "registros"): Product[] {
  if (!html.trim()) {
    return [];
  }

  return mode === "informacionNutricional"
    ? parseNutritionProductsFromHtml(html)
    : parseRegistroProductsFromHtml(html);
}

export function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

export function extractDetailToken(detailUrl: string | null): string | null {
  if (!detailUrl) {
    return null;
  }

  const url = new URL(detailUrl, SEARCH_URL);
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const [firstChunk = ""] = raw.split("&");
  const token = firstChunk.trim();
  return token ? decodeURIComponent(token) : null;
}

export function buildDetailWrapperUrl(detailUrl: string | null): string | null {
  if (!detailUrl) {
    return null;
  }

  return new URL(detailUrl, SEARCH_URL).toString();
}

export function buildDetailContentUrl(detailUrl: string | null): string | null {
  const token = extractDetailToken(detailUrl);
  if (!token) {
    return null;
  }

  return new URL(`consultaProducto/index.php?${encodeURIComponent(token)}`, SITE_ORIGIN).toString();
}

async function fetchTextOnce(
  url: string,
  requestTimeoutMs: number,
  extraHeaders: Record<string, string>,
  insecureTls: boolean,
): Promise<TextResponse> {
  const response = await fetch(url, {
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
    redirect: "follow",
    ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} for ${url}`);
  }

  return {
    status: response.status,
    url: response.url,
    headers: headersToObject(response.headers),
    text: await response.text(),
  };
}

function parseRegistroProductsFromHtml(html: string): Product[] {
  const $ = load(`<div id="root">${html}</div>`);
  const products: Product[] = [];
  let province: string | null = null;

  $("#root")
    .children()
    .each((_, element) => {
      const node = $(element);

      if (node.is("div.row.justify-content-between")) {
        province = normalizeText(node.find(".text-monospace").first().text());
        return;
      }

      if (!node.is("table")) {
        return;
      }

      node.find("tbody tr").each((_, row) => {
        const cells = $(row).find("td");
        const anchor = cells.eq(0).find("a").first();
        const rnpa = normalizeText(anchor.text() || cells.eq(0).text()) ?? "";

        products.push({
          searchMode: "registros",
          province,
          rnpa,
          detailUrl: normalizeUrl(anchor.attr("href")),
          denominacion: normalizeText(cells.eq(1).text()),
          nombreFantasia: normalizeText(cells.eq(2).text()),
          marca: normalizeText(cells.eq(3).text()),
          titular: normalizeText(cells.eq(4).text()),
          estado: normalizeText(cells.eq(5).text()),
          rawCells: cells.toArray().map((cell) => normalizeText($(cell).text()) ?? ""),
        });
      });
    });

  return products;
}

function parseNutritionProductsFromHtml(html: string): Product[] {
  const $ = load(`<div id="root">${html}</div>`);
  const products: Product[] = [];
  let province: string | null = null;

  $("#root")
    .children()
    .each((_, element) => {
      const node = $(element);

      if (node.is("div.row.justify-content-between")) {
        province = normalizeText(node.find(".text-monospace").first().text());
        return;
      }

      if (!node.is("table")) {
        return;
      }

      const headerTexts = node
        .find("thead th")
        .toArray()
        .map((header) => normalizeText($(header).text()) ?? "")
        .filter((header) => header.length > 0);
      const disambiguatedHeaders = disambiguateHeaders(headerTexts);

      node.find("tbody tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length === 0) {
          return;
        }

        const anchor = cells.eq(0).find("a").first();
        const rawCells = cells.toArray().map((cell) => normalizeText($(cell).text()) ?? "");
        const rnpa = normalizeText(anchor.text() || rawCells[0]) ?? "";
        const extra: Record<string, string> = {};

        for (let index = 0; index < disambiguatedHeaders.length && index < rawCells.length; index += 1) {
          extra[disambiguatedHeaders[index]] = rawCells[index];
        }

        products.push({
          searchMode: "informacionNutricional",
          province,
          rnpa,
          detailUrl: normalizeUrl(anchor.attr("href")),
          denominacion: normalizeText(rawCells[1]),
          marca: normalizeText(rawCells[2]),
          nombreFantasia: normalizeText(rawCells[3]),
          titular: null,
          estado: null,
          extra,
          rawCells,
        });
      });
    });

  return products;
}

function disambiguateHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();

  return headers.map((header) => {
    const normalized = normalizeText(header) ?? "columna";
    const count = (counts.get(normalized) ?? 0) + 1;
    counts.set(normalized, count);
    return count === 1 ? normalized : `${normalized} (${count})`;
  });
}

function parsePageNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const numeric = Number.parseInt(value.trim(), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function baseHeaders(): Record<string, string> {
  return {
    accept: "*/*",
    origin: SITE_ORIGIN,
    referer: SEARCH_URL,
    "user-agent": DEFAULT_USER_AGENT,
    "x-requested-with": "XMLHttpRequest",
  };
}

function buildRequestBody(input: SearchInput, page?: number): URLSearchParams {
  const query = new URLSearchParams();
  query.set("tipo-busqueda", input.mode ?? "registros");
  query.set("options", "3");
  query.set("rb", "");
  query.set("id1", "");
  query.set("arrTipo", "");
  query.set("pagina", "");
  query.set("codigo", "0");
  query.set("codigo_pais", "0");
  query.set("rnpa", "");
  query.set("denominacion", input.denominacion);
  query.set("fantasia", input.fantasia);
  query.set("marca", input.marca);
  query.set("vigencia", "0");
  query.set("rne_titular", "");
  query.set("razon_social_titular", "");
  query.set("rne_elaborador", "");
  query.set("razon_social_elaborador", "");
  query.set("rne_participe", "");
  query.set("razon_social_participe", "");
  query.set("producto", "0");
  query.set("pais", "0");
  query.set("pais-destino", "0");
  query.set("pais-procedencia", "0");
  query.set("rubro", "0");
  query.set("categoria-producto", "0");
  query.set("comercializacion_inal", "0");
  query.set("poblacion_destino_inal", "0");
  query.set("condicion_inal", "0");
  query.set("clave_inal", "0");
  query.set("atributo_inal", "0");

  const params = new URLSearchParams();
  params.set("xajax", "search");
  params.set("xajaxr", String(Date.now()));
  params.append("xajaxargs[]", `<xjxquery><q>${query.toString()}</q></xjxquery>`);

  if (page != null) {
    params.append("xajaxargs[]", String(page));
  }

  return params;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }

  return result;
}

function shouldRetryWithoutTlsVerification(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /certificate|tls|ssl|self[- ]signed|unable to verify|unable to get issuer/i.test(message);
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed, SEARCH_URL).toString();
  } catch {
    return trimmed;
  }
}

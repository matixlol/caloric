import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProductFieldFallback = {
  searchMode?: string | null;
  province?: string | null;
  rnpa?: string | null;
  denominacion?: string | null;
  nombreFantasia?: string | null;
  marca?: string | null;
  titular?: string | null;
  estado?: string | null;
};

export type NutritionParseResult = {
  nutritionFound: boolean;
  servingText: string | null;
  servingQuantity: number | null;
  servingUnit: string | null;
  calories: number | null;
  proteinGrams: string | null;
  carbsGrams: string | null;
  fatGrams: string | null;
  fiberGrams: string | null;
  sugarsGrams: string | null;
  sodiumMg: number | null;
};

export function decodeEntities(input: string): string {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${input}`, "text/html");
    return doc.documentElement.textContent ?? input;
  }
  return input;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

export function normalizeTextValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const repaired = Buffer.from(trimmed, "latin1").toString("utf8").trim();
  const score = (input: string) => (input.match(/Ã.|Â.|â.|¤|�/g) ?? []).length;
  const preferred = score(repaired) < score(trimmed) ? repaired : trimmed;

  return preferred
    .normalize("NFC")
    .replace(/(?<=[A-ZÁÉÍÓÚÜÑ])[áéíóúñü](?=[^a-záéíóúñü]|$)/g, (char) => char.toUpperCase());
}

export function extractField(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }

  return normalizeTextValue(match[1]);
}

export function extractProductMetadataFromHtml(
  htmlText: string,
  fallback: ProductFieldFallback = {},
): ProductFieldFallback {
  return {
    searchMode: normalizeTextValue(fallback.searchMode),
    province:
      extractField(htmlText, /Provincia:\s*(.+?)\s*Localidad:/i) ||
      normalizeTextValue(fallback.province),
    rnpa:
      extractField(htmlText, /RNPA\s+N\S*:\s*([0-9-]+)/i) ||
      normalizeTextValue(fallback.rnpa),
    denominacion:
      extractField(htmlText, /Denominaci[oó]n:\s*(.+?)\s*Modo de Comercializaci[oó]n:/i) ||
      normalizeTextValue(fallback.denominacion),
    nombreFantasia:
      extractField(htmlText, /Nombre de Fantas[ií]a:\s*(.+?)\s*Denominaci[oó]n:/i) ||
      normalizeTextValue(fallback.nombreFantasia),
    marca:
      extractField(htmlText, /Marca:\s*(.+?)\s*Nombre de Fantas[ií]a:/i) ||
      normalizeTextValue(fallback.marca),
    titular:
      extractField(htmlText, /Raz[oó]n Social:\s*(.+?)\s*Provincia:/i) ||
      normalizeTextValue(fallback.titular),
    estado: normalizeTextValue(fallback.estado),
  };
}

export function parseNutritionFromHtml(html: string): NutritionParseResult {
  const section = extractNutritionSection(html);
  if (!section) {
    return {
      nutritionFound: false,
      servingText: null,
      servingQuantity: null,
      servingUnit: null,
      calories: null,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
      fiberGrams: null,
      sugarsGrams: null,
      sodiumMg: null,
    };
  }

  const servingText = parseServingText(section);
  const serving = parseServingQuantityAndUnit(servingText);

  return {
    nutritionFound: true,
    servingText,
    servingQuantity: serving.quantity,
    servingUnit: serving.unit,
    calories: parseIntegerValue(matchValue(section, /Valor energ(?:é|e)tico:\s*([0-9.,]+)\s*kcal/i)),
    carbsGrams: parseLocalizedNumber(matchValue(section, /Carbohidratos:\s*([0-9.,]+)\s*g/i)),
    sugarsGrams: parseLocalizedNumber(matchValue(section, /Az[uú]cares:\s*([0-9.,]+)\s*g/i)),
    proteinGrams: parseLocalizedNumber(matchValue(section, /Prote(?:í|i)nas:\s*([0-9.,]+)\s*g/i)),
    fatGrams: parseLocalizedNumber(matchValue(section, /Grasas Totales:\s*([0-9.,]+)\s*g/i)),
    fiberGrams: parseLocalizedNumber(matchValue(section, /Fibra Alimentaria:\s*([0-9.,]+)\s*g/i)),
    sodiumMg: parseIntegerValue(matchValue(section, /Sodio:\s*([0-9.,]+)\s*mg/i)),
  };
}

export async function compressHtmlWithZstd(html: string): Promise<Uint8Array> {
  const tempDir = await mkdtemp(join(tmpdir(), "anmat-html-zstd-"));
  const inputPath = join(tempDir, "input.html");

  try {
    await Bun.write(inputPath, html);
    const proc = Bun.spawn(["zstd", "-q", "-19", "-c", "--", inputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`zstd failed with exit code ${exitCode}: ${stderrText.trim()}`);
    }

    return new Uint8Array(stdoutBuffer);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function extractNutritionSection(html: string): string | null {
  const match = html.match(
    /<h2>\s*INFORMACI(?:Ó|&Oacute;|O)N NUTRICIONAL\s*<\/h2>[\s\S]*?(?=<div id="tin-2"|<\/body>)/i,
  );
  if (!match) {
    return null;
  }

  return stripTags(match[0]);
}

function matchValue(section: string, labelPattern: RegExp): string | null {
  const match = labelPattern.exec(section);
  if (!match) {
    return null;
  }

  const value = normalizeWhitespace(match[1] ?? "");
  return value.length > 0 ? value : null;
}

function parseLocalizedNumber(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const match = raw.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) {
    return null;
  }

  return match[0].replace(",", ".");
}

function parseIntegerValue(raw: string | null): number | null {
  const parsed = parseLocalizedNumber(raw);
  if (!parsed) {
    return null;
  }

  const value = Number(parsed);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

function parseServingText(section: string): string | null {
  const match = section.match(/Porci[oó]n\s+(.+?)(?=Cantidad por Porci[oó]n)/i);
  if (!match) {
    return null;
  }

  return normalizeWhitespace(match[1]);
}

function parseServingQuantityAndUnit(servingText: string | null): { quantity: number | null; unit: string | null } {
  if (!servingText) {
    return { quantity: null, unit: null };
  }

  const match = servingText.match(/(\d+(?:[.,]\d+)?)\s*(g|mg|ml|kg|l)\b/i);
  if (!match) {
    return { quantity: null, unit: null };
  }

  const quantity = Number(match[1].replace(",", "."));
  return {
    quantity: Number.isFinite(quantity) ? Math.round(quantity) : null,
    unit: match[2].toLowerCase(),
  };
}

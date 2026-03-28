import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEansFromHtmlText } from "./anmat-ean-parser";
import { anmatProductDerivedData, anmatProductHtmlBlobs } from "./db/schema";

type CliArgs = {
  batchSize: number;
  limit: number;
};

type NutritionParseResult = {
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

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    batchSize: 250,
    limit: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--batch-size" && argv[index + 1]) {
      args.batchSize = Math.max(1, Number(argv[index + 1]) || 250);
      index += 1;
      continue;
    }
    if (arg === "--limit" && argv[index + 1]) {
      args.limit = Math.max(0, Number(argv[index + 1]) || 0);
      index += 1;
      continue;
    }
  }

  return args;
}

async function decompressZstd(bytes: Uint8Array): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "anmat-html-zstd-"));
  const inputPath = join(tempDir, "input.zst");

  try {
    await Bun.write(inputPath, bytes);
    const proc = Bun.spawn(["zstd", "-d", "-q", "-c", "--", inputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`zstd failed with exit code ${exitCode}: ${stderrText.trim()}`);
    }

    return stdoutText;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function decodeEntities(input: string): string {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${input}`, "text/html");
    return doc.documentElement.textContent ?? input;
  }
  return input;
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
  const match = html.match(/<h2>\s*INFORMACI(?:Ó|&Oacute;|O)N NUTRICIONAL\s*<\/h2>[\s\S]*?(?=<div id="tin-2"|<\/body>)/i);
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

function parseNutritionFromHtml(html: string): NutritionParseResult {
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
  const calories = parseIntegerValue(matchValue(section, /Valor energ(?:é|e)tico:\s*([0-9.,]+)\s*kcal/i));
  const carbsGrams = parseLocalizedNumber(matchValue(section, /Carbohidratos:\s*([0-9.,]+)\s*g/i));
  const sugarsGrams = parseLocalizedNumber(matchValue(section, /Azucares:\s*([0-9.,]+)\s*g/i));
  const proteinGrams = parseLocalizedNumber(matchValue(section, /Prote(?:í|i)nas:\s*([0-9.,]+)\s*g/i));
  const fatGrams = parseLocalizedNumber(matchValue(section, /Grasas Totales:\s*([0-9.,]+)\s*g/i));
  const fiberGrams = parseLocalizedNumber(matchValue(section, /Fibra Alimentaria:\s*([0-9.,]+)\s*g/i));
  const sodiumMg = parseIntegerValue(matchValue(section, /Sodio:\s*([0-9.,]+)\s*mg/i));

  return {
    nutritionFound: true,
    servingText,
    servingQuantity: serving.quantity,
    servingUnit: serving.unit,
    calories,
    proteinGrams,
    carbsGrams,
    fatGrams,
    fiberGrams,
    sugarsGrams,
    sodiumMg,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  const db = drizzle(client);

  let imported = 0;
  let lastId = 0;

  try {
    while (true) {
      const rows = await db
        .select({
          id: anmatProductHtmlBlobs.id,
          htmlZstd: anmatProductHtmlBlobs.htmlZstd,
        })
        .from(anmatProductHtmlBlobs)
        .where(gt(anmatProductHtmlBlobs.id, lastId))
        .orderBy(asc(anmatProductHtmlBlobs.id))
        .limit(args.batchSize);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const html = await decompressZstd(row.htmlZstd);
        const nutrition = parseNutritionFromHtml(html);
        const ean = parseEansFromHtmlText(html, { includeHtmlAny: true });

        await db
          .insert(anmatProductDerivedData)
          .values({
            htmlBlobId: row.id,
            nutritionFound: nutrition.nutritionFound,
            servingText: nutrition.servingText,
            servingQuantity: nutrition.servingQuantity,
            servingUnit: nutrition.servingUnit,
            calories: nutrition.calories,
            proteinGrams: nutrition.proteinGrams,
            carbsGrams: nutrition.carbsGrams,
            fatGrams: nutrition.fatGrams,
            fiberGrams: nutrition.fiberGrams,
            sugarsGrams: nutrition.sugarsGrams,
            sodiumMg: nutrition.sodiumMg,
            ean: ean.bestEan,
            eanSource: ean.bestSource,
            eanCandidates: ean.candidates,
          })
          .onConflictDoUpdate({
            target: anmatProductDerivedData.htmlBlobId,
            set: {
              nutritionFound: nutrition.nutritionFound,
              servingText: nutrition.servingText,
              servingQuantity: nutrition.servingQuantity,
              servingUnit: nutrition.servingUnit,
              calories: nutrition.calories,
              proteinGrams: nutrition.proteinGrams,
              carbsGrams: nutrition.carbsGrams,
              fatGrams: nutrition.fatGrams,
              fiberGrams: nutrition.fiberGrams,
              sugarsGrams: nutrition.sugarsGrams,
              sodiumMg: nutrition.sodiumMg,
              ean: ean.bestEan,
              eanSource: ean.bestSource,
              eanCandidates: ean.candidates,
              parsedAt: new Date(),
            },
          });

        imported += 1;
        lastId = row.id;
        if (imported % 250 === 0) {
          console.log(`imported=${imported}`);
        }
        if (args.limit > 0 && imported >= args.limit) {
          console.log(`imported=${imported}`);
          return;
        }
      }
    }

    console.log(`imported=${imported}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();

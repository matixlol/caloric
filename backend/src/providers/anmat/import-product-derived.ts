import { asc, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import zstd from "@foxglove/wasm-zstd";
import postgres from "postgres";
import { anmatProductDerivedData, anmatProductHtmlBlobs } from "../../db/schema";
import { parseEansFromHtmlText } from "./ean-parser";
import { parseNutritionFromHtml } from "./html";

type CliArgs = {
  batchSize: number;
  limit: number;
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

async function decompressZstd(bytes: Uint8Array, uncompressedBytes: number): Promise<string | null> {
  if (uncompressedBytes <= 0) {
    return null;
  }

  await zstd.isLoaded;
  const decompressed = zstd.decompress(bytes, uncompressedBytes);
  return new TextDecoder().decode(decompressed);
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
          uncompressedBytes: anmatProductHtmlBlobs.uncompressedBytes,
        })
        .from(anmatProductHtmlBlobs)
        .where(gt(anmatProductHtmlBlobs.id, lastId))
        .orderBy(asc(anmatProductHtmlBlobs.id))
        .limit(args.batchSize);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const html = await decompressZstd(row.htmlZstd, row.uncompressedBytes);
        if (!html) {
          lastId = row.id;
          continue;
        }
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
            eanAttempted: true,
            eanStatus: "html_parsed",
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
              eanAttempted: true,
              eanStatus: "html_parsed",
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

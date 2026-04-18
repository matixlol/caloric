import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { anmatProductHtmlBlobs } from "../../db/schema";
import {
  compressHtmlWithZstd,
  extractProductMetadataFromHtml,
  htmlToText,
  normalizeTextValue,
  sha256Hex,
} from "./html";

type CliArgs = {
  rootDir: string;
  limit: number;
};

type MetadataShape = {
  savedAt?: string;
  detailKey?: string;
  token?: string;
  query?: string;
  queryIndex?: number;
  page?: number;
  wrapperUrl?: string;
  contentUrl?: string;
  product?: {
    searchMode?: string;
    province?: string;
    rnpa?: string;
    denominacion?: string;
    nombreFantasia?: string;
    marca?: string;
    titular?: string;
    estado?: string;
  };
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    rootDir: "/Users/user/dev/super/downloads/anmat-scrape",
    limit: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" && argv[index + 1]) {
      args.rootDir = argv[index + 1];
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

async function walkFiles(rootDir: string): Promise<string[]> {
  const pending = [rootDir];
  const files: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "content.html") {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

async function readMetadata(htmlPath: string): Promise<MetadataShape> {
  const metadataPath = join(resolve(htmlPath, ".."), "metadata.json");
  try {
    const raw = await readFile(metadataPath, "utf8");
    return JSON.parse(raw) as MetadataShape;
  } catch {
    return {};
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getRunKey(rootDir: string, htmlPath: string): string {
  const relativePath = relative(rootDir, htmlPath);
  const [runKey = "unknown-run"] = relativePath.split(sep);
  return runKey;
}

function getDetailKeyFromPath(htmlPath: string): string | null {
  const parentDir = resolve(htmlPath, "..").split(sep).pop();
  return parentDir?.trim() ? parentDir : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  const rootDir = resolve(args.rootDir);
  const htmlFiles = await walkFiles(rootDir);
  const selectedFiles = args.limit > 0 ? htmlFiles.slice(0, args.limit) : htmlFiles;

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  const db = drizzle(client);

  let imported = 0;

  try {
    console.log(`root_dir=${rootDir}`);
    console.log(`html_files=${selectedFiles.length}`);

    for (const htmlPath of selectedFiles) {
      const [htmlBytes, metadata] = await Promise.all([
        readFile(htmlPath),
        readMetadata(htmlPath),
      ]);
      const relativePath = relative(rootDir, htmlPath);
      const htmlText = htmlToText(new TextDecoder("utf-8").decode(htmlBytes));
      const compressed = await compressHtmlWithZstd(new TextDecoder("utf-8").decode(htmlBytes));
      const product = metadata.product ?? {};
      const extractedProduct = extractProductMetadataFromHtml(htmlText, product);
      const normalizedToken = normalizeTextValue(metadata.token);
      const normalizedQuery = normalizeTextValue(metadata.query);
      const normalizedWrapperUrl = normalizeTextValue(metadata.wrapperUrl);
      const normalizedContentUrl = normalizeTextValue(metadata.contentUrl);
      const normalizedSearchMode = normalizeTextValue(product.searchMode);
      const normalizedProvince = extractedProduct.province ?? null;
      const normalizedRnpa = extractedProduct.rnpa ?? null;
      const normalizedDenominacion = extractedProduct.denominacion ?? null;
      const normalizedNombreFantasia = extractedProduct.nombreFantasia ?? null;
      const normalizedMarca = extractedProduct.marca ?? null;
      const normalizedTitular = extractedProduct.titular ?? null;
      const normalizedEstado = extractedProduct.estado ?? null;

      await db
        .insert(anmatProductHtmlBlobs)
        .values({
          sourcePath: relativePath,
          ingestSource: "disk_import",
          runKey: getRunKey(rootDir, htmlPath),
          detailKey: normalizeTextValue(metadata.detailKey) || getDetailKeyFromPath(htmlPath),
          token: normalizedToken,
          query: normalizedQuery,
          queryIndex: metadata.queryIndex ?? null,
          page: metadata.page ?? null,
          wrapperUrl: normalizedWrapperUrl,
          contentUrl: normalizedContentUrl,
          searchMode: normalizedSearchMode,
          province: normalizedProvince,
          rnpa: normalizedRnpa,
          denominacion: normalizedDenominacion,
          nombreFantasia: normalizedNombreFantasia,
          marca: normalizedMarca,
          titular: normalizedTitular,
          estado: normalizedEstado,
          compressionAlgo: "zstd",
          htmlZstd: compressed,
          htmlSha256: sha256Hex(htmlBytes),
          uncompressedBytes: htmlBytes.byteLength,
          compressedBytes: compressed.byteLength,
          savedAt: parseDate(metadata.savedAt),
        })
        .onConflictDoUpdate({
          target: anmatProductHtmlBlobs.sourcePath,
          set: {
            ingestSource: "disk_import",
            runKey: getRunKey(rootDir, htmlPath),
            detailKey: normalizeTextValue(metadata.detailKey) || getDetailKeyFromPath(htmlPath),
            token: normalizedToken,
            query: normalizedQuery,
            queryIndex: metadata.queryIndex ?? null,
            page: metadata.page ?? null,
            wrapperUrl: normalizedWrapperUrl,
            contentUrl: normalizedContentUrl,
            searchMode: normalizedSearchMode,
            province: normalizedProvince,
            rnpa: normalizedRnpa,
            denominacion: normalizedDenominacion,
            nombreFantasia: normalizedNombreFantasia,
            marca: normalizedMarca,
            titular: normalizedTitular,
            estado: normalizedEstado,
            compressionAlgo: "zstd",
            htmlZstd: compressed,
            htmlSha256: sha256Hex(htmlBytes),
            uncompressedBytes: htmlBytes.byteLength,
            compressedBytes: compressed.byteLength,
            savedAt: parseDate(metadata.savedAt),
            importedAt: new Date(),
          },
        });

      imported += 1;
      if (imported % 250 === 0 || imported === selectedFiles.length) {
        console.log(`imported=${imported}`);
      }
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { anmatProductHtmlBlobs } from "./db/schema";

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

async function compressWithZstd(filePath: string): Promise<Uint8Array> {
  const proc = Bun.spawn(["zstd", "-q", "-19", "-c", "--", filePath], {
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
}

function decodeEntities(input: string): string {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${input}`, "text/html");
    return doc.documentElement.textContent ?? input;
  }
  return input;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeTextValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const repaired = Buffer.from(trimmed, "latin1").toString("utf8").trim();
  const score = (input: string) => {
    const mojibakeMatches = input.match(/Ã.|Â.|â.|¤|�/g) ?? [];
    return mojibakeMatches.length;
  };

  const preferred = score(repaired) < score(trimmed) ? repaired : trimmed;
  return preferred
    .normalize("NFC")
    .replace(/(?<=[A-ZÁÉÍÓÚÜÑ])[áéíóúñü](?=[^a-záéíóúñü]|$)/g, (char) => char.toUpperCase());
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

function extractField(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  return normalizeTextValue(match[1]);
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
      const compressed = await compressWithZstd(htmlPath);
      const relativePath = relative(rootDir, htmlPath);
      const htmlText = htmlToText(new TextDecoder("utf-8").decode(htmlBytes));
      const product = metadata.product ?? {};
      const normalizedToken = normalizeTextValue(metadata.token);
      const normalizedQuery = normalizeTextValue(metadata.query);
      const normalizedWrapperUrl = normalizeTextValue(metadata.wrapperUrl);
      const normalizedContentUrl = normalizeTextValue(metadata.contentUrl);
      const normalizedSearchMode = normalizeTextValue(product.searchMode);
      const normalizedProvince =
        extractField(htmlText, /Provincia:\s*(.+?)\s*Localidad:/i) || normalizeTextValue(product.province);
      const normalizedRnpa =
        extractField(htmlText, /RNPA\s+N\S*:\s*([0-9-]+)/i) || normalizeTextValue(product.rnpa);
      const normalizedDenominacion =
        extractField(htmlText, /Denominaci[oó]n:\s*(.+?)\s*Modo de Comercializaci[oó]n:/i) ||
        normalizeTextValue(product.denominacion);
      const normalizedNombreFantasia =
        extractField(htmlText, /Nombre de Fantas[ií]a:\s*(.+?)\s*Denominaci[oó]n:/i) ||
        normalizeTextValue(product.nombreFantasia);
      const normalizedMarca =
        extractField(htmlText, /Marca:\s*(.+?)\s*Nombre de Fantas[ií]a:/i) || normalizeTextValue(product.marca);
      const normalizedTitular =
        extractField(htmlText, /Raz[oó]n Social:\s*(.+?)\s*Provincia:/i) || normalizeTextValue(product.titular);
      const normalizedEstado = normalizeTextValue(product.estado);

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
          htmlSha256: createHash("sha256").update(htmlBytes).digest("hex"),
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
            htmlSha256: createHash("sha256").update(htmlBytes).digest("hex"),
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

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export type CandidateSource =
  | "asset_zbar"
  | "html_label"
  | "json_label"
  | "html_any"
  | "json_any";

export type EanCandidate = {
  code: string;
  source: CandidateSource;
  evidence?: string;
  file?: string;
};

export type ProductEanParseResult = {
  rnpa: string;
  detailKey: string;
  bestEan: string | null;
  bestSource: CandidateSource | null;
  candidates: EanCandidate[];
};

export type ParseOptions = {
  rootDir: string;
  scanAssets?: boolean;
  scanAssetLimitPerProduct?: number; // 0 = all
  includeHtmlAny?: boolean;
  includeJsonAny?: boolean;
  preferPrefix779?: boolean;
  productConcurrency?: number;
  pdfConcurrency?: number;
  productLimit?: number;
};

type ProductContext = {
  rnpa: string;
  detailKey: string;
  dirPath: string;
  contentHtmlPath?: string;
  contentJsonPath?: string;
  assetPdfPaths: string[];
};

type MetadataShape = {
  detailKey?: string;
  product?: {
    rnpa?: string;
  };
};

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const BARCODE_LABEL_RE =
  /(?:c[oó]digo\s+de\s+barras?|barcode|ean(?:-?13|-?8)?|gtin(?:-?14)?|upc(?:-?a)?)/giu;
const DIGIT_SEQ_RE = /(?:\d[\s-]*){8,14}/g;

const DUMMY_CODES = new Set([
  "0123456789012",
  "12345670",
  "1234567890128",
  "5901234123457",
]);

function digitsOnly(input: string): string {
  let out = "";
  for (const ch of input) {
    if (ch >= "0" && ch <= "9") out += ch;
  }
  return out;
}

function isObviousFake(code: string): boolean {
  if (DUMMY_CODES.has(code)) return true;
  if (code.includes("123456")) return true;
  if (code.includes("0123456")) return true;
  if (/^(\d)\1+$/.test(code)) return true;
  if (/^0{6,}/.test(code)) return true;
  return false;
}

function checksumOk(code: string): boolean {
  const n = digitsOnly(code);
  if (n.length === 8) {
    const body = n.slice(0, 7);
    const check = Number(n[7]);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
    return ((10 - (sum % 10)) % 10) === check;
  }
  if (n.length === 12) {
    const body = n.slice(0, 11);
    const check = Number(n[11]);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 1 ? 3 : 1);
    return ((10 - (sum % 10)) % 10) === check;
  }
  if (n.length === 13) {
    const body = n.slice(0, 12);
    const check = Number(n[12]);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 1 ? 3 : 1);
    return ((10 - (sum % 10)) % 10) === check;
  }
  if (n.length === 14) {
    const body = n.slice(0, 13);
    const check = Number(n[13]);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
    return ((10 - (sum % 10)) % 10) === check;
  }
  return false;
}

function normalizeCandidate(raw: string): string | null {
  const d = digitsOnly(raw);
  if (![8, 12, 13, 14].includes(d.length)) return null;
  if (!checksumOk(d)) return null;
  if (isObviousFake(d)) return null;
  return d;
}

function sourceRank(source: CandidateSource): number {
  switch (source) {
    case "asset_zbar":
      return 0;
    case "html_label":
      return 1;
    case "json_label":
      return 2;
    case "html_any":
      return 3;
    case "json_any":
      return 4;
    default:
      return 99;
  }
}

export function extractAroundLabels(text: string): string[] {
  const snippets: string[] = [];
  for (const match of text.matchAll(BARCODE_LABEL_RE)) {
    const idx = match.index ?? 0;
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + 220);
    snippets.push(text.slice(start, end));
  }
  return snippets;
}

export function extractDigitCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(DIGIT_SEQ_RE)) {
    const normalized = normalizeCandidate(m[0]);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseEansFromHtmlText(
  html: string,
  options: {
    includeHtmlAny?: boolean;
    preferPrefix779?: boolean;
  } = {},
): {
  bestEan: string | null;
  bestSource: CandidateSource | null;
  candidates: EanCandidate[];
} {
  const includeHtmlAny = options.includeHtmlAny ?? false;
  const preferPrefix779 = options.preferPrefix779 ?? true;

  const candidates: EanCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: EanCandidate) => {
    const key = `${candidate.code}|${candidate.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const snippet of extractAroundLabels(html)) {
    for (const code of extractDigitCandidates(snippet)) {
      push({ code, source: "html_label" });
    }
  }

  if (includeHtmlAny) {
    for (const code of extractDigitCandidates(html)) {
      push({ code, source: "html_any" });
    }
  }

  const ranked = [...candidates].sort((a, b) => {
    const bySource = sourceRank(a.source) - sourceRank(b.source);
    if (bySource !== 0) return bySource;

    if (preferPrefix779) {
      const a779 = a.code.startsWith("779") ? 1 : 0;
      const b779 = b.code.startsWith("779") ? 1 : 0;
      if (a779 !== b779) return b779 - a779;
    }

    return a.code.localeCompare(b.code);
  });

  return {
    bestEan: ranked[0]?.code ?? null,
    bestSource: ranked[0]?.source ?? null,
    candidates: ranked,
  };
}

async function runCommand(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\nTIMEOUT` });
    }, timeoutMs);

    proc.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    proc.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
  });
}

async function decodePdfWithZbar(pdfPath: string): Promise<string[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "anmat-ean-"));
  try {
    const outPrefix = join(tempDir, "page");
    const render = await runCommand(
      "pdftoppm",
      ["-f", "1", "-singlefile", "-r", "220", "-png", pdfPath, outPrefix],
      20000,
    );
    if (render.code !== 0) return [];

    const pngPath = `${outPrefix}.png`;
    const zbar = await runCommand("zbarimg", ["-q", pngPath], 15000);
    if (zbar.code !== 0 && zbar.code !== 4) return [];
    const raw = zbar.stdout.trim();
    if (!raw) return [];

    const codes = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const payload = line.includes(":") ? line.split(":").slice(1).join(":") : line;
      const normalized = normalizeCandidate(payload);
      if (normalized) codes.add(normalized);
    }
    return [...codes];
  } catch {
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mapConcurrent<T, R>(
  input: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(input.length);
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= input.length) return;
      out[idx] = await worker(input[idx], idx);
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runOne());
  await Promise.all(workers);
  return out;
}

async function collectProducts(rootDir: string): Promise<ProductContext[]> {
  const out = new Map<string, ProductContext>();
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name !== "metadata.json") continue;

      let parsed: MetadataShape | null = null;
      try {
        parsed = JSON.parse(await readFile(full, "utf8")) as MetadataShape;
      } catch {
        parsed = null;
      }
      if (!parsed) continue;

      const detailKey = parsed.detailKey?.trim();
      const rnpa = parsed.product?.rnpa?.trim();
      if (!detailKey || !rnpa) continue;
      if (out.has(rnpa)) continue;

      const dirPath = dirname(full);
      const assetsDir = join(dirPath, "assets");
      let assetPdfPaths: string[] = [];
      try {
        const assets = await readdir(assetsDir, { withFileTypes: true });
        assetPdfPaths = assets
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
          .map((e) => join(assetsDir, e.name))
          .sort();
      } catch {
        assetPdfPaths = [];
      }

      out.set(rnpa, {
        rnpa,
        detailKey,
        dirPath,
        contentHtmlPath: join(dirPath, "content.html"),
        contentJsonPath: join(dirPath, "content.json"),
        assetPdfPaths,
      });
    }
  }
  return [...out.values()];
}

export async function parseGoodEnoughEans(options: ParseOptions): Promise<ProductEanParseResult[]> {
  const scanAssets = options.scanAssets ?? true;
  const scanAssetLimitPerProduct = options.scanAssetLimitPerProduct ?? 0;
  const includeHtmlAny = options.includeHtmlAny ?? false;
  const includeJsonAny = options.includeJsonAny ?? false;
  const preferPrefix779 = options.preferPrefix779 ?? true;
  const productConcurrency = options.productConcurrency ?? 12;
  const pdfConcurrency = options.pdfConcurrency ?? 6;

  let products = await collectProducts(options.rootDir);
  if (options.productLimit && options.productLimit > 0) {
    products = products.slice(0, options.productLimit);
  }

  const rows = await mapConcurrent(products, productConcurrency, async (product) => {
    const candidates: EanCandidate[] = [];
    const seen = new Set<string>();
    const push = (candidate: EanCandidate) => {
      const key = `${candidate.code}|${candidate.source}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    if (scanAssets && product.assetPdfPaths.length > 0) {
      const pdfs =
        scanAssetLimitPerProduct > 0
          ? product.assetPdfPaths.slice(0, scanAssetLimitPerProduct)
          : product.assetPdfPaths;
      const pdfResults = await mapConcurrent(pdfs, pdfConcurrency, async (pdfPath) => {
        return await decodePdfWithZbar(pdfPath);
      });
      for (let i = 0; i < pdfs.length; i += 1) {
        for (const code of pdfResults[i]) {
          push({
            code,
            source: "asset_zbar",
            file: pdfs[i],
            evidence: basename(pdfs[i]),
          });
        }
      }
    }

    try {
      const html = await readFile(product.contentHtmlPath ?? "", "utf8");
      for (const snippet of extractAroundLabels(html)) {
        for (const code of extractDigitCandidates(snippet)) {
          push({ code, source: "html_label", file: product.contentHtmlPath });
        }
      }
      if (includeHtmlAny) {
        for (const code of extractDigitCandidates(html)) {
          push({ code, source: "html_any", file: product.contentHtmlPath });
        }
      }
    } catch {
      // ignore
    }

    try {
      const jsonText = await readFile(product.contentJsonPath ?? "", "utf8");
      for (const snippet of extractAroundLabels(jsonText)) {
        for (const code of extractDigitCandidates(snippet)) {
          push({ code, source: "json_label", file: product.contentJsonPath });
        }
      }
      if (includeJsonAny) {
        for (const code of extractDigitCandidates(jsonText)) {
          push({ code, source: "json_any", file: product.contentJsonPath });
        }
      }
    } catch {
      // ignore
    }

    return { product, candidates };
  });

  const freqByCode = new Map<string, number>();
  for (const row of rows) {
    for (const code of new Set(row.candidates.map((c) => c.code))) {
      freqByCode.set(code, (freqByCode.get(code) ?? 0) + 1);
    }
  }

  const results: ProductEanParseResult[] = rows.map(({ product, candidates }) => {
    const ranked = [...candidates].sort((a, b) => {
      const bySource = sourceRank(a.source) - sourceRank(b.source);
      if (bySource !== 0) return bySource;

      if (preferPrefix779) {
        const a779 = a.code.startsWith("779") ? 1 : 0;
        const b779 = b.code.startsWith("779") ? 1 : 0;
        if (a779 !== b779) return b779 - a779;
      }

      const aFreq = freqByCode.get(a.code) ?? 1;
      const bFreq = freqByCode.get(b.code) ?? 1;
      if (aFreq !== bFreq) return aFreq - bFreq;

      return a.code.localeCompare(b.code);
    });

    const best = ranked[0];
    return {
      rnpa: product.rnpa,
      detailKey: product.detailKey,
      bestEan: best?.code ?? null,
      bestSource: best?.source ?? null,
      candidates: ranked,
    };
  });

  return results.sort((a, b) => a.rnpa.localeCompare(b.rnpa));
}

function parseCliArgs(argv: string[]): {
  rootDir: string;
  outJson?: string;
  scanAssets: boolean;
  scanLimit: number;
  includeHtmlAny: boolean;
  includeJsonAny: boolean;
  productConcurrency: number;
  pdfConcurrency: number;
  productLimit: number;
} {
  const args = {
    rootDir: "",
    outJson: undefined as string | undefined,
    scanAssets: true,
    scanLimit: 0,
    includeHtmlAny: false,
    includeJsonAny: false,
    productConcurrency: 12,
    pdfConcurrency: 6,
    productLimit: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      args.rootDir = argv[++i];
      continue;
    }
    if (arg === "--out-json" && argv[i + 1]) {
      args.outJson = argv[++i];
      continue;
    }
    if (arg === "--no-scan-assets") {
      args.scanAssets = false;
      continue;
    }
    if (arg === "--scan-limit" && argv[i + 1]) {
      args.scanLimit = Number(argv[++i]) || 0;
      continue;
    }
    if (arg === "--include-html-any") {
      args.includeHtmlAny = true;
      continue;
    }
    if (arg === "--include-json-any") {
      args.includeJsonAny = true;
      continue;
    }
    if (arg === "--product-concurrency" && argv[i + 1]) {
      args.productConcurrency = Math.max(1, Number(argv[++i]) || 12);
      continue;
    }
    if (arg === "--pdf-concurrency" && argv[i + 1]) {
      args.pdfConcurrency = Math.max(1, Number(argv[++i]) || 6);
      continue;
    }
    if (arg === "--product-limit" && argv[i + 1]) {
      args.productLimit = Math.max(0, Number(argv[++i]) || 0);
      continue;
    }
  }
  return args;
}

async function runCli(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.rootDir) {
    console.error(
      "Usage: bun src/anmat-ean-parser.ts --root <run_dir> [--out-json <path>] [--scan-limit N] [--include-html-any] [--product-concurrency N] [--pdf-concurrency N]",
    );
    process.exit(1);
  }

  const results = await parseGoodEnoughEans({
    rootDir: args.rootDir,
    scanAssets: args.scanAssets,
    scanAssetLimitPerProduct: args.scanLimit,
    includeHtmlAny: args.includeHtmlAny,
    includeJsonAny: args.includeJsonAny,
    productConcurrency: args.productConcurrency,
    pdfConcurrency: args.pdfConcurrency,
    productLimit: args.productLimit,
  });

  const withBest = results.filter((r) => r.bestEan).length;
  const bySource = new Map<CandidateSource, number>();
  for (const row of results) {
    if (!row.bestSource) continue;
    bySource.set(row.bestSource, (bySource.get(row.bestSource) ?? 0) + 1);
  }

  console.log(`products=${results.length}`);
  console.log(`with_best_ean=${withBest}`);
  console.log(
    `best_source_counts=${JSON.stringify({
      asset_zbar: bySource.get("asset_zbar") ?? 0,
      html_label: bySource.get("html_label") ?? 0,
      json_label: bySource.get("json_label") ?? 0,
      html_any: bySource.get("html_any") ?? 0,
      json_any: bySource.get("json_any") ?? 0,
    })}`,
  );

  if (args.outJson) {
    await Bun.write(args.outJson, JSON.stringify(results, null, 2));
    console.log(`out_json=${args.outJson}`);
  }
}

if (import.meta.main) {
  void runCli();
}

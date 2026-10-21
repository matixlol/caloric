// One-way import of backend/'s Postgres database into a stage's D1 database.
//
//   DATABASE_URL=postgres://... bun scripts/import-postgres.ts --stage dev [--profile caloric]
//     [--with-caches] [--dry-run <file.sql>]
//
// Rows are upserted (INSERT OR REPLACE), so re-running refreshes the copy.
// Better Auth's tables use its camelCase D1 columns (ISO dates, 0/1 booleans);
// app tables store epoch milliseconds and JSON text. Provider response caches
// are skipped unless --with-caches is passed; they refill on demand.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";

const { values: args } = parseArgs({
  options: {
    stage: { type: "string" },
    profile: { type: "string", default: "caloric" },
    "with-caches": { type: "boolean", default: false },
    "dry-run": { type: "string" },
  },
});
if (!args.stage) throw new Error("--stage is required (e.g. dev, prod)");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL (source Postgres) is required");

type Value = string | number | boolean | null | Date | Uint8Array | object;
type Row = Record<string, Value>;

// --- Target: D1 over the Cloudflare API, or a SQL file for --dry-run --------

const dryRunStatements: string[] = [];

const credentials = () => {
  const file = join(homedir(), ".alchemy", "profiles", args.profile!, "cloudflare.json");
  const find = (value: unknown): { apiToken: string; accountId: string } | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.apiToken === "string" && typeof record.accountId === "string") {
      return { apiToken: record.apiToken, accountId: record.accountId };
    }
    for (const nested of Object.values(record)) {
      const found = find(nested);
      if (found) return found;
    }
    return undefined;
  };
  const found =
    process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID
      ? { apiToken: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
      : find(JSON.parse(readFileSync(file, "utf8")));
  if (!found) throw new Error(`No Cloudflare API token in ${file}`);
  return found;
};

const cloudflare = args["dry-run"] ? undefined : credentials();

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflare!.accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cloudflare!.apiToken}`, "Content-Type": "application/json" },
  });
  const body = (await response.json()) as { success: boolean; errors?: unknown; result: unknown };
  if (!body.success) throw new Error(`Cloudflare API ${path} failed: ${JSON.stringify(body.errors)}`);
  return body.result;
};

const databaseId = cloudflare
  ? await (async () => {
      const prefix = `Caloric-Database-${args.stage}-`;
      const databases = (await api(`/d1/database?per_page=100`)) as Array<{ uuid: string; name: string }>;
      const matches = databases.filter((database) => database.name.startsWith(prefix));
      if (matches.length !== 1) throw new Error(`Expected one D1 database named ${prefix}*, found ${matches.length}`);
      console.log(`Target D1: ${matches[0]!.name}`);
      return matches[0]!.uuid;
    })()
  : undefined;

const execute = async (statements: string[]) => {
  if (statements.length === 0) return;
  if (!databaseId) {
    dryRunStatements.push(...statements);
    return;
  }
  await api(`/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: statements.join(";\n") }),
  });
};

// --- SQL literals ------------------------------------------------------------

const literal = (value: Value | undefined): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (value instanceof Date) throw new Error("Convert dates explicitly before building SQL");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
};

const iso = (value: Value): string | null => (value instanceof Date ? value.toISOString() : null);
const millis = (value: Value): number | null => (value instanceof Date ? value.getTime() : null);
const json = (value: Value): string | null => (value === null ? null : JSON.stringify(value));

// D1 caps a request at ~100 KB of SQL; keep batches comfortably below that.
const MAX_BATCH_BYTES = 90_000;

const copy = async (options: {
  source: string;
  target: string;
  query: postgres.PendingQuery<Row[]>;
  map: (row: Row) => Record<string, Value>;
}) => {
  let batch: string[] = [];
  let batchBytes = 0;
  let copied = 0;
  const flush = async () => {
    await execute(batch);
    batch = [];
    batchBytes = 0;
  };
  for await (const rows of options.query.cursor(500)) {
    for (const row of rows) {
      const mapped = options.map(row);
      const columns = Object.keys(mapped);
      const statement = `INSERT OR REPLACE INTO "${options.target}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map((column) => literal(mapped[column]))
        .join(", ")})`;
      if (statement.length > MAX_BATCH_BYTES) throw new Error(`A ${options.target} row exceeds the D1 statement size limit`);
      if (batchBytes + statement.length > MAX_BATCH_BYTES) await flush();
      batch.push(statement);
      batchBytes += statement.length + 2;
      copied += 1;
    }
  }
  await flush();
  console.log(`${options.source} → ${options.target}: ${copied} rows`);
};

// --- Tables ------------------------------------------------------------------

const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 15 });

try {
  await copy({
    source: "user",
    target: "user",
    query: sql`SELECT * FROM "user" ORDER BY id`,
    map: (row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.email_verified,
      image: row.image,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }),
  });
  await copy({
    source: "account",
    target: "account",
    query: sql`SELECT * FROM account ORDER BY id`,
    map: (row) => ({
      id: row.id,
      accountId: row.account_id,
      providerId: row.provider_id,
      userId: row.user_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      idToken: row.id_token,
      accessTokenExpiresAt: iso(row.access_token_expires_at),
      refreshTokenExpiresAt: iso(row.refresh_token_expires_at),
      scope: row.scope,
      password: row.password,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }),
  });
  // Live sessions carry over so signed-in iOS users stay signed in (the prod
  // Worker must use the same BETTER_AUTH_SECRET that signed their cookies).
  await copy({
    source: "session",
    target: "session",
    query: sql`SELECT * FROM session WHERE expires_at > now() ORDER BY id`,
    map: (row) => ({
      id: row.id,
      expiresAt: iso(row.expires_at),
      token: row.token,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      userId: row.user_id,
    }),
  });

  for (const table of ["user_food_entries", "user_recipes"]) {
    await copy({
      source: table,
      target: table,
      query: sql`SELECT * FROM ${sql(table)} ORDER BY user_id, id`,
      map: (row) => ({
        user_id: row.user_id,
        id: row.id,
        data: json(row.data),
        updated_at: millis(row.updated_at),
        deleted_at: millis(row.deleted_at),
      }),
    });
  }
  await copy({
    source: "user_settings",
    target: "user_settings",
    query: sql`SELECT * FROM user_settings ORDER BY user_id`,
    map: (row) => ({ user_id: row.user_id, data: json(row.data), updated_at: millis(row.updated_at) }),
  });

  await copy({
    source: "social_profiles",
    target: "social_profiles",
    query: sql`SELECT * FROM social_profiles ORDER BY user_id`,
    map: (row) => ({
      user_id: row.user_id,
      display_name: row.display_name,
      friend_code: row.friend_code,
      created_at: millis(row.created_at),
      updated_at: millis(row.updated_at),
    }),
  });
  await copy({
    source: "friendships",
    target: "friendships",
    query: sql`SELECT * FROM friendships ORDER BY id`,
    map: (row) => ({
      id: row.id,
      requester_user_id: row.requester_user_id,
      recipient_user_id: row.recipient_user_id,
      user_a_id: row.user_a_id,
      user_b_id: row.user_b_id,
      status: row.status,
      created_at: millis(row.created_at),
      updated_at: millis(row.updated_at),
    }),
  });

  await copy({
    source: "ai_sessions",
    target: "ai_sessions",
    query: sql`SELECT * FROM ai_sessions ORDER BY id`,
    map: (row) => ({
      id: row.id,
      user_id: row.user_id,
      conversation: json(row.conversation),
      search_result_counter: row.search_result_counter,
      search_results_by_local_id: json(row.search_results_by_local_id),
      pending_approvals: json(row.pending_approvals),
      created_at: millis(row.created_at),
      updated_at: millis(row.updated_at),
    }),
  });

  // The stored MyFitnessPal session saves a slow, captcha-paid browser login.
  await copy({
    source: "mfp_auth_sessions",
    target: "mfp_auth_sessions",
    query: sql`SELECT * FROM mfp_auth_sessions ORDER BY id`,
    map: (row) => ({
      id: row.id,
      provider: row.provider,
      storage_state: json(row.storage_state),
      session_storage: json(row.session_storage),
      authorization: row.authorization,
      cookie_header: row.cookie_header,
      refreshed_at: millis(row.refreshed_at),
      created_at: millis(row.created_at),
      updated_at: millis(row.updated_at),
    }),
  });

  // ANMAT catalog: metadata only (the compressed HTML stays out of D1).
  await copy({
    source: "anmat_product_html_blobs",
    target: "anmat_products",
    query: sql`
      SELECT id, source_path, ingest_source, run_key, detail_key, token, query, query_index, page,
        wrapper_url, content_url, search_mode, province, rnpa, denominacion, nombre_fantasia, marca,
        titular, estado, html_sha256, saved_at, imported_at
      FROM anmat_product_html_blobs ORDER BY id`,
    map: (row) => ({
      id: row.id,
      source_path: row.source_path,
      ingest_source: row.ingest_source,
      run_key: row.run_key,
      detail_key: row.detail_key,
      token: row.token,
      query: row.query,
      query_index: row.query_index,
      page: row.page,
      wrapper_url: row.wrapper_url,
      content_url: row.content_url,
      search_mode: row.search_mode,
      province: row.province,
      rnpa: row.rnpa,
      denominacion: row.denominacion,
      nombre_fantasia: row.nombre_fantasia,
      marca: row.marca,
      titular: row.titular,
      estado: row.estado,
      html_key: null,
      html_sha256: row.html_sha256,
      saved_at: millis(row.saved_at),
      imported_at: millis(row.imported_at),
    }),
  });
  await copy({
    source: "anmat_product_derived_data",
    target: "anmat_product_derived_data",
    query: sql`SELECT * FROM anmat_product_derived_data ORDER BY id`,
    map: (row) => ({
      id: row.id,
      product_id: row.html_blob_id,
      nutrition_found: row.nutrition_found,
      serving_text: row.serving_text,
      serving_quantity: row.serving_quantity,
      serving_unit: row.serving_unit,
      calories: row.calories,
      protein_grams: row.protein_grams,
      carbs_grams: row.carbs_grams,
      fat_grams: row.fat_grams,
      fiber_grams: row.fiber_grams,
      sugars_grams: row.sugars_grams,
      sodium_mg: row.sodium_mg,
      ean_attempted: row.ean_attempted,
      ean_status: row.ean_status,
      ean: row.ean,
      ean_source: row.ean_source,
      ean_candidates: json(row.ean_candidates),
      parsed_at: millis(row.parsed_at),
    }),
  });

  if (args["with-caches"]) {
    await copy({
      source: "mfp_search_responses",
      target: "mfp_search_responses",
      query: sql`SELECT * FROM mfp_search_responses ORDER BY id`,
      map: (row) => ({
        id: row.id,
        query: row.query,
        offset: row.offset,
        max_items: row.max_items,
        country_code: row.country_code,
        resource_type: row.resource_type,
        mfp_url: row.mfp_url,
        mfp_status: row.mfp_status,
        response_json: json(row.response_json),
        response_text: row.response_text,
        created_at: millis(row.created_at),
      }),
    });
    await copy({
      source: "mfp_food_detail_responses",
      target: "mfp_food_detail_responses",
      query: sql`SELECT * FROM mfp_food_detail_responses ORDER BY id`,
      map: (row) => ({
        id: row.id,
        search_response_id: row.search_response_id,
        food_id: row.food_id,
        version: row.version,
        mfp_url: row.mfp_url,
        mfp_status: row.mfp_status,
        response_json: json(row.response_json),
        response_text: row.response_text,
        created_at: millis(row.created_at),
      }),
    });
    await copy({
      source: "mfp_barcode_responses",
      target: "mfp_barcode_responses",
      query: sql`SELECT * FROM mfp_barcode_responses ORDER BY id`,
      map: (row) => ({
        id: row.id,
        barcode: row.barcode,
        mfp_url: row.mfp_url,
        mfp_status: row.mfp_status,
        result_code: row.result_code,
        response_body: row.response_body,
        response_json: json(row.response_json),
        created_at: millis(row.created_at),
      }),
    });
    await copy({
      source: "open_food_facts_search_responses",
      target: "open_food_facts_search_responses",
      query: sql`SELECT * FROM open_food_facts_search_responses ORDER BY id`,
      map: (row) => ({
        id: row.id,
        query: row.query,
        page: row.page,
        page_size: row.page_size,
        off_url: row.off_url,
        off_status: row.off_status,
        response_json: json(row.response_json),
        response_text: row.response_text,
        created_at: millis(row.created_at),
      }),
    });
  }
} finally {
  await sql.end({ timeout: 5 });
}

if (args["dry-run"]) {
  writeFileSync(args["dry-run"], dryRunStatements.join(";\n") + ";\n");
  console.log(`Wrote ${dryRunStatements.length} statements to ${args["dry-run"]}`);
}

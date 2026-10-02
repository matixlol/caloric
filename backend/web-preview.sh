#!/usr/bin/env bash
set -euo pipefail

# One-command real-backend web preview. The database is deliberately isolated
# from every configured environment and is reachable only over loopback.
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Refusing inherited DATABASE_URL. Run with: env -u DATABASE_URL ./web-preview.sh [public-origin]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$ROOT/../.cache/web-preview"
DATA="$CACHE/postgres"
ENV_FILE="$CACHE/runtime.env"
PORT="${WEB_PREVIEW_PORT:-8787}"
PG_PORT="${WEB_PREVIEW_POSTGRES_PORT:-55432}"
DATABASE_URL="postgres://preview@127.0.0.1:${PG_PORT}/caloric_web_preview"

validate_port() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[0-9]{1,5}$ ]] || (( 10#$value < 1 || 10#$value > 65535 )); then
    echo "$name must be an integer from 1 to 65535." >&2
    exit 2
  fi
}

validate_origin() {
  bun -e '
    const input = process.argv[1];
    let url;
    try { url = new URL(input); } catch { process.exit(1); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || input !== url.origin && input !== `${url.origin}/`) process.exit(1);
    process.stdout.write(url.origin);
  ' "$1"
}

if (( $# > 1 )); then
  echo "Usage: $0 [public-origin]" >&2
  exit 2
fi
validate_port WEB_PREVIEW_PORT "$PORT"
validate_port WEB_PREVIEW_POSTGRES_PORT "$PG_PORT"
if [[ "$PG_PORT" != "55432" && -z "${WEB_PREVIEW_ALLOW_CUSTOM_PG_PORT:-}" ]]; then
  echo "Refusing a custom PostgreSQL port unless WEB_PREVIEW_ALLOW_CUSTOM_PG_PORT=1 is set." >&2
  exit 2
fi
ORIGIN_EXPLICIT=0
ORIGIN_INPUT="http://localhost:$PORT"
if [[ -n "${1:-}" ]]; then
  ORIGIN_EXPLICIT=1
  ORIGIN_INPUT="$1"
elif [[ -n "${WEB_PREVIEW_ORIGIN:-}" ]]; then
  ORIGIN_EXPLICIT=1
  ORIGIN_INPUT="$WEB_PREVIEW_ORIGIN"
fi
if ! ORIGIN="$(validate_origin "$ORIGIN_INPUT")"; then
  echo "Public origin must be a canonical http(s) origin with no credentials, query, fragment, or path (for example https://preview.example.test)." >&2
  exit 2
fi

mkdir -p "$DATA"
chmod 700 "$CACHE" "$DATA"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
fi

if [[ ! -x "$ROOT/../node_modules/.bin/drizzle-kit" && ! -x "$ROOT/node_modules/.bin/drizzle-kit" ]]; then
  echo "Installing workspace dependencies..."
  (cd "$ROOT/.." && pnpm install)
fi

echo "Building the checked-in web client..."
(cd "$ROOT" && bun web/build.ts)

find_pg_bin() {
  local postgres
  postgres="$(find /usr/lib/postgresql -mindepth 3 -maxdepth 3 -type f -name postgres 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$postgres" ]] && dirname "$postgres"
}
PG_BIN="$(find_pg_bin || true)"
if [[ -z "$PG_BIN" ]]; then
  if command -v apt-get >/dev/null && sudo -n true 2>/dev/null; then
    echo "Installing native PostgreSQL (one-time orb prerequisite)..."
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql
    PG_BIN="$(find_pg_bin || true)"
  else
    echo "Native PostgreSQL is required. Install it, then rerun this script (Docker CLI alone is insufficient without a daemon)." >&2
    exit 1
  fi
fi

echo "Starting dedicated PostgreSQL service (database: caloric_web_preview)..."
amp orb service start caloric-web-preview-db --cwd "$ROOT" --port "$PG_PORT" --command \
  "if [ ! -f '$DATA/PG_VERSION' ]; then '$PG_BIN/initdb' -D '$DATA' -U preview --auth=trust --no-instructions; fi; exec '$PG_BIN/postgres' -D '$DATA' -h 127.0.0.1 -p '$PG_PORT' -k '$DATA'"

for _ in $(seq 1 60); do
  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U preview >/dev/null 2>&1; then break; fi
  sleep 1
done
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U preview >/dev/null
if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U preview -d postgres -Atqc \
  "select 1 from pg_database where datname = 'caloric_web_preview'" | grep -qx 1; then
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U preview caloric_web_preview
fi

echo "Applying backend migrations and seeding (normal restarts preserve edits)..."
(cd "$ROOT" && DATABASE_URL="$DATABASE_URL" bunx drizzle-kit migrate)
(cd "$ROOT" && set -a && source "$ENV_FILE" && set +a && \
  DATABASE_URL="$DATABASE_URL" BETTER_AUTH_URL="$ORIGIN" AUTH_TRUSTED_ORIGINS="$ORIGIN" WEB_ORIGINS="$ORIGIN" \
  WEB_PREVIEW_RESET="${WEB_PREVIEW_RESET:-0}" bun seed-web.local.ts)

echo "Starting actual backend on port $PORT. Disposable login: preview@caloric.local / CaloricPreview123!"
printf -v ENV_FILE_Q %q "$ENV_FILE"
printf -v DATABASE_URL_Q %q "$DATABASE_URL"
printf -v PORT_Q %q "$PORT"
printf -v ORIGIN_Q %q "$ORIGIN"
if (( ORIGIN_EXPLICIT )); then
  SERVICE_ORIGIN="$ORIGIN_Q"
else
  SERVICE_ORIGIN='${PUBLIC_URL:-'"$ORIGIN_Q"'}'
fi
SERVICE_COMMAND="set -a; source $ENV_FILE_Q; set +a; unset RESEND_API_KEY; export DATABASE_URL=$DATABASE_URL_Q PORT=$PORT_Q; PREVIEW_ORIGIN=$SERVICE_ORIGIN; export BETTER_AUTH_URL=\"\$PREVIEW_ORIGIN\" AUTH_TRUSTED_ORIGINS=\"\$PREVIEW_ORIGIN\" WEB_ORIGINS=\"\$PREVIEW_ORIGIN\"; exec bun src/server.ts"
if [[ "${WEB_PREVIEW_NO_PORTAL:-0}" == "1" ]]; then
  amp orb service start caloric-web-preview --cwd "$ROOT" --port "$PORT" --command "$SERVICE_COMMAND"
else
  amp orb service start caloric-web-preview --cwd "$ROOT" --port "$PORT" --portal --title "Caloric web preview" --command "$SERVICE_COMMAND"
fi
# Also load backend edits on subsequent runs; service start reuses a live process.
amp orb service restart caloric-web-preview

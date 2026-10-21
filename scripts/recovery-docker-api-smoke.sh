#!/usr/bin/env bash
# Exercise a real listening API inside a disposable, network-isolated Docker
# container restored from the separately protected SQLite checkpoint.
# Usage: bash scripts/recovery-docker-api-smoke.sh data/backups/verified-checkpoints/<snapshot>.db
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 data/backups/verified-checkpoints/<snapshot>.db" >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
protected_dir="$repo_dir/data/backups/verified-checkpoints"
source_dir="$(cd "$(dirname "$1")" && pwd -P)"
source_file="$source_dir/$(basename "$1")"

if [[ ! -f "$source_file" || "$source_dir" != "$protected_dir" || "$source_file" != *.db ]]; then
  echo 'Recovery source must be an existing protected .db checkpoint.' >&2
  exit 2
fi

# Resolve the file itself as well, so a symlink cannot escape the protected dir.
if [[ -L "$source_file" ]]; then
  echo 'Symlink checkpoints are not accepted.' >&2
  exit 2
fi

image_name="${HOMEASY_RECOVERY_IMAGE:-homeasy-backup}"
source_hash="$(shasum -a 256 "$source_file" | awk '{print $1}')"

for read_path in legacy canonical; do
  docker run --rm --interactive \
    --network none --read-only --tmpfs /tmp:rw,nosuid,size=192m \
    --memory 350m --pids-limit 100 \
    --volume "$source_file:/recovery/source.db:ro" \
    --env BOT_TOKEN=1234567890:OfflineRestorationDummyTokenOnly \
    --env BOT_DELIVERY_MODE=polling \
    --env CANONICAL_ALERTS_ENABLED=false \
    --env CANONICAL_READ_CANARY_TELEGRAM_IDS= \
    --env SHADOW_INGESTION=false \
    --env LISTING_READ_SHADOW=false \
    --env LISTING_READ_PATH="$read_path" \
    --env POSTHOG_API_KEY= \
    --env NODE_ENV=test \
    --env DATABASE_PATH=/tmp/restored.db \
    --env API_HOST=127.0.0.1 \
    --env API_PORT=37999 \
    --entrypoint /bin/sh "$image_name" -s -- "$read_path" <<'CONTAINER_SCRIPT'
set -eu
mode="$1"
cp /recovery/source.db /tmp/restored.db
node dist/api.js > /tmp/restored-api.log 2>&1 &
api_pid=$!
cleanup() {
  kill "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! node -e '
const assert = require("node:assert/strict");
const mode = process.argv[1];
const base = "http://127.0.0.1:37999";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function get(url, expected = 200) {
  const result = await fetch(base + url, { signal: AbortSignal.timeout(2000) });
  assert.equal(result.status, expected, `${url}: unexpected HTTP status ${result.status}`);
  return result.json();
}
(async () => {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await get("/health")).status === "ok") { ready = true; break; } }
    catch { await sleep(250); }
  }
  assert.ok(ready, "API did not start within 10 seconds");
  const list = await get("/api/v1/properties?limit=5");
  assert.ok(list.total > 0 && list.items.length > 0, "empty restored catalog");
  const first = list.items[0];
  const id = mode === "canonical" ? first.publicRef : String(first.id);
  if (mode === "canonical") assert.match(id, /^lst_[a-f0-9]{32}$/);
  assert.ok(id, "missing first listing identity");
  const detail = await get(`/api/v1/properties/${id}`);
  assert.equal(detail.id, first.id, "detail/list identity mismatch");
  const map = await get("/api/v1/properties/map");
  assert.equal(map.count, map.markers.length, "map count mismatch");
  const metadata = await get("/api/v1/filters/metadata");
  assert.ok(Array.isArray(metadata.locations), "missing filter metadata");
  await get("/api/v1/properties/invalid-id", 400);
  await get("/api/v1/properties/lst_00000000000000000000000000000000", 404);
  process.stdout.write(JSON.stringify({ status: "pass", mode, listeningApi: true,
    network: "none", catalogCount: list.total, mapMarkers: map.count,
    detail: "ok", filters: "ok", invalidId: 400, missingId: 404 }) + "\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
' "$mode"; then
  cat /tmp/restored-api.log >&2
  exit 1
fi
CONTAINER_SCRIPT
done

if [[ "$(shasum -a 256 "$source_file" | awk '{print $1}')" != "$source_hash" ]]; then
  echo 'Protected snapshot checksum changed during isolated recovery smoke.' >&2
  exit 1
fi
echo "Protected checkpoint SHA-256 unchanged: $source_hash"

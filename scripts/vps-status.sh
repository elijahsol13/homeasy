#!/usr/bin/env bash
# Read-only, one-shot host/container health report. Execute on the VPS from any directory.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
status=0

echo '=== Host memory / disk ==='
free -h || status=1
df -h . data || status=1
disk_used="$(df -Pk data | awk 'END { gsub(/%/, "", $5); print $5 }')"
if [[ "$disk_used" =~ ^[0-9]+$ ]] && (( disk_used >= 85 )); then
  echo "WARN: data disk usage ${disk_used}% (threshold 85%)"
  status=1
fi

echo '=== Compose services ==='
docker compose ps || exit 1
ids=()
for service in api bot scraper backup tunnel; do
  id="$(docker compose ps -q "$service" 2>/dev/null)"
  if [[ -z "$id" ]]; then
    echo "FAIL: $service is missing"
    status=1
    continue
  fi
  ids+=("$id")
  state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$id" 2>/dev/null)"
  echo "$service: $state (health: $health)"
  if [[ "$state" != running || "$health" == unhealthy ]]; then status=1; fi
done

echo '=== Container resource usage ==='
if (( ${#ids[@]} > 0 )); then
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' "${ids[@]}" || status=1
fi

echo '=== Local API / independent snapshot freshness ==='
if curl -fsS --max-time 5 http://127.0.0.1:3000/health > /dev/null; then
  echo 'API: healthy'
else
  echo 'FAIL: local API /health'
  status=1
fi
if docker compose exec -T backup node dist/database/backup-worker.js --health; then
  echo 'Backup: verified snapshot younger than 24h'
else
  echo 'FAIL: no fresh verified snapshot or backup container unavailable'
  status=1
fi

echo "=== Status: $([[ "$status" -eq 0 ]] && echo OK || echo CHECK) ==="
exit "$status"

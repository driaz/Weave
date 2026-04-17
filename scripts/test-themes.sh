#!/usr/bin/env bash
# Fetch the latest snapshot_id and run theme extraction against it.
set -euo pipefail

# Source .env for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
set -a
source .env
set +a

SNAP_ID=$(curl -s "${SUPABASE_URL}/rest/v1/weave_profile_snapshots?select=id&order=created_at.desc&limit=1" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  | node -e 'process.stdin.resume();let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d)[0].id))')

echo "Latest snapshot: $SNAP_ID"
echo "Extracting themes..."
echo ""

curl -s -X POST http://localhost:8888/api/extract-snapshot-themes \
  -H 'Content-Type: application/json' \
  -d "{\"snapshot_id\":\"$SNAP_ID\"}" \
  | node -e 'process.stdin.resume();let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d),null,2)))'

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# READ-ONLY inspection of the dev adminapi loads schema.
# Opens a temporary SSM tunnel to the private Aurora DB, runs
# ONLY SELECT / catalog queries, then closes the tunnel.
#
# It CANNOT change data — there are no INSERT/UPDATE/DELETE/ALTER
# statements anywhere in this file. Read it yourself to confirm.
#
# Run:   bash inspect-schema.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

export AWS_PROFILE=platform-dev
PSQL=/opt/homebrew/opt/libpq/bin/psql
PGISREADY=/opt/homebrew/opt/libpq/bin/pg_isready
RDS=dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com
NODE=i-068b194a186ea7bda
LOCAL_PORT=15432

echo "Reading DB password from SSM (value is not printed)..."
PW=$(aws ssm get-parameter --name /ofload/db/masterpassword --with-decryption \
      --region ap-southeast-2 --query 'Parameter.Value' --output text)
[ -n "$PW" ] || { echo "Could not read password"; exit 1; }

echo "Opening SSM tunnel via $NODE -> localhost:$LOCAL_PORT ..."
aws ssm start-session --target "$NODE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS,portNumber=5432,localPortNumber=$LOCAL_PORT" \
  > /tmp/ssm_tunnel.log 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT

for i in $(seq 1 25); do
  "$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 && break
  sleep 1
done
"$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 || {
  echo "Tunnel didn't come up:"; cat /tmp/ssm_tunnel.log; exit 1; }
echo "Tunnel up. Running READ-ONLY queries..."
echo

export PGPASSWORD="$PW"

# Connect to the default maintenance DB first, list databases,
# then auto-find the one that actually contains a "loads" table.
qadmin() { "$PSQL" -h 127.0.0.1 -p $LOCAL_PORT -U postgres -d postgres -X -A -t -c "$1"; }

echo "===== 0. Databases on this cluster ====="
"$PSQL" -h 127.0.0.1 -p $LOCAL_PORT -U postgres -d postgres -X -c \
  "SELECT datname FROM pg_database WHERE datistemplate=false AND datname NOT IN ('rdsadmin') ORDER BY 1;"

# Focused inspection of a target DB (default Ofload_site; override: DB=eos bash inspect-schema.sh)
# NOTE: errors are tolerated (|| true) so one bad query doesn't abort the run.
TARGET="${DB:-Ofload_site}"
run() { "$PSQL" -h 127.0.0.1 -p $LOCAL_PORT -U postgres -d "$TARGET" -X -c "$1" || true; }
echo ">>> Inspecting database: $TARGET"
echo

echo "===== A1. assignment tables — row counts (active) ====="
run "SELECT 'team_assign' AS tbl, count(*) AS rows, count(*) FILTER (WHERE deleted_at IS NULL) AS active FROM team_assign
     UNION ALL
     SELECT 'fleet_assign', count(*), count(*) FILTER (WHERE deleted_at IS NULL) FROM fleet_assign;"

echo "===== A2. shipment manifest/link id columns ====="
run "SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name='shipment' AND table_schema='public'
       AND (column_name ILIKE '%manifest%' OR column_name ILIKE '%master%') ORDER BY ordinal_position;"

echo "===== A3. does shipment link to team_assign via master_ship_id or manifest_id? (join test) ====="
run "SELECT 'via master_ship_id' AS link, count(*) FROM shipment s
       JOIN team_assign ta ON ta.master_manifest_id = s.master_ship_id AND ta.deleted_at IS NULL
     UNION ALL
     SELECT 'via manifest_id', count(*) FROM shipment s
       JOIN team_assign ta ON ta.master_manifest_id = s.manifest_id AND ta.deleted_at IS NULL;"

echo "===== A4. TARGET set: can we resolve a SPECIFIC assigned team member w/ phone? ====="
run "WITH allocated AS (
       SELECT DISTINCT sm.shipment_id
       FROM shipment_milestones sm
       WHERE sm.type='Allocated'
         AND sm.shipment_id NOT IN (SELECT shipment_id FROM shipment_milestones WHERE type='On The Road')
     )
     SELECT
       EXISTS (SELECT 1 FROM fleet_assign fa JOIN fleet f ON f.id=fa.fleet_id
               JOIN team t ON t.id=f.team_id
               WHERE fa.shipment_id=s.id AND fa.deleted_at IS NULL AND NULLIF(t.phone,'') IS NOT NULL) AS via_fleet_driver,
       EXISTS (SELECT 1 FROM team_assign ta JOIN team t ON t.id=ta.team_id
               WHERE ta.master_manifest_id=s.master_ship_id AND ta.deleted_at IS NULL AND NULLIF(t.phone,'') IS NOT NULL) AS via_manifest_team,
       count(*)
     FROM allocated a JOIN shipment s ON s.id=a.shipment_id
     GROUP BY 1,2 ORDER BY 3 DESC;"

echo
echo "Done. Tunnel closing."

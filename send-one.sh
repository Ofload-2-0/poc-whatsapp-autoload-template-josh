#!/usr/bin/env bash
# Manual single-load send. Opens the read-only tunnel for the DB read, loads HubSpot
# config from .env, then runs send-one.js. DRY_RUN unless you pass live.
#
#   bash send-one.sh AUSTV83RHGQ            # dry-run (logs, sends nothing)
#   bash send-one.sh AUSTV83RHGQ live       # ACTUALLY sends the WhatsApp
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:?usage: bash send-one.sh <REFERENCE> [live]}"
MODE="${2:-dry}"

# HubSpot config from .env (HUBSPOT_TOKEN, HUBSPOT_WEBHOOK_CONFIRM)
set -a; [ -f .env ] && . ./.env; set +a

export AWS_PROFILE=platform-dev
PGISREADY=/opt/homebrew/opt/libpq/bin/pg_isready
RDS=dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com
NODE=i-068b194a186ea7bda
LOCAL_PORT=15432

PW=$(aws ssm get-parameter --name /ofload/db/masterpassword --with-decryption --region ap-southeast-2 --query 'Parameter.Value' --output text)
aws ssm start-session --target "$NODE" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS,portNumber=5432,localPortNumber=$LOCAL_PORT" > /tmp/ssm_tunnel.log 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 25); do "$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 && break; sleep 1; done

ENCPW=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PW")
export DATABASE_URL="postgres://postgres:${ENCPW}@127.0.0.1:${LOCAL_PORT}/eos"

if [ "$MODE" = "live" ]; then export WA_DRY_RUN=false; echo "⚠️  LIVE SEND MODE"; else export WA_DRY_RUN=true; echo "DRY_RUN (no send)"; fi
node send-one.js "$REF"

#!/usr/bin/env bash
# READ-ONLY: opens the SSM tunnel to dev, then runs validate.js (the real phone
# waterfall) against a carrier's real data. Sends nothing, writes nothing.
#
#   bash validate-carrier.sh "THE FREIGHT COMP PTY LTD"
set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-THE FREIGHT COMP PTY LTD}"
export AWS_PROFILE=platform-dev
PGISREADY=/opt/homebrew/opt/libpq/bin/pg_isready
RDS=dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com
NODE=i-068b194a186ea7bda
LOCAL_PORT=15432

echo "Reading DB password from SSM (not printed)..."
PW=$(aws ssm get-parameter --name /ofload/db/masterpassword --with-decryption \
      --region ap-southeast-2 --query 'Parameter.Value' --output text)
[ -n "$PW" ] || { echo "could not read password"; exit 1; }

echo "Opening read-only SSM tunnel via $NODE → localhost:$LOCAL_PORT ..."
aws ssm start-session --target "$NODE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS,portNumber=5432,localPortNumber=$LOCAL_PORT" \
  > /tmp/ssm_tunnel.log 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT

for i in $(seq 1 25); do "$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 && break; sleep 1; done
"$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 || { echo "tunnel failed"; cat /tmp/ssm_tunnel.log; exit 1; }

# URL-encode the password minimally for the connection string
ENCPW=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PW")
DB_NAME="${DB:-Ofload_site}"     # override with:  DB=eos bash validate-carrier.sh ...
export DATABASE_URL="postgres://postgres:${ENCPW}@127.0.0.1:${LOCAL_PORT}/${DB_NAME}"
export WA_DRY_RUN=true

echo "Running phone-waterfall validation (db=${DB_NAME}) for: $NAME"
echo "──────────────────────────────────────────────"
node validate.js "$NAME"
echo "──────────────────────────────────────────────"
echo "(read-only — nothing sent, nothing written)"

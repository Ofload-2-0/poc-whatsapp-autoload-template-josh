#!/usr/bin/env bash
# REAL write test: mark a load On The Road via the EOS API. Opens the tunnel for the
# manifest/team lookup; the EOS API calls go to dev.app.ofload.com over the internet.
#   bash apply-onroad.sh AUSTV83RHGQ
set -euo pipefail
cd "$(dirname "$0")"
REF="${1:?usage: bash apply-onroad.sh <REFERENCE>}"
set -a; [ -f .env ] && . ./.env; set +a
[ -n "${EOS_CLIENT_ID:-}" ] || { echo "No EOS_CLIENT_ID in .env — run:  DB=eos bash validate-carrier.sh EOS-CRED"; exit 1; }

export AWS_PROFILE=platform-dev
PGISREADY=/opt/homebrew/opt/libpq/bin/pg_isready
RDS=dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com
NODE=i-068b194a186ea7bda; LOCAL_PORT=15432
PW=$(aws ssm get-parameter --name /ofload/db/masterpassword --with-decryption --region ap-southeast-2 --query 'Parameter.Value' --output text)
aws ssm start-session --target "$NODE" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS,portNumber=5432,localPortNumber=$LOCAL_PORT" > /tmp/ssm_tunnel.log 2>&1 &
TUNNEL_PID=$!; trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 25); do "$PGISREADY" -h 127.0.0.1 -p $LOCAL_PORT -U postgres >/dev/null 2>&1 && break; sleep 1; done
ENCPW=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PW")
export DATABASE_URL="postgres://postgres:${ENCPW}@127.0.0.1:${LOCAL_PORT}/eos"
export WA_DRY_RUN=false WA_EOS_DRY_RUN=false     # ← real write
echo "⚠️  REAL EOS WRITE"
node apply-onroad.js "$REF"

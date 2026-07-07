#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — stand up the WA pickup-confirmation tool in platform-dev.
#
# SAFE BY DEFAULT: deploys in DRY_RUN (sends nothing), EOS writes off, MAX_SENDS=1,
# recipient locked to your number, cron schedule DISABLED (manual trigger only).
# You widen it later by updating env vars.
#
# ⚠️ Review before running. Creates: DynamoDB table, IAM role, 2 Lambdas, a
# Function URL, and a DISABLED EventBridge rule, in platform-dev. Reads HubSpot/EOS
# creds from .env. Run:  AWS_PROFILE=platform-dev bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a

# ── config (platform-dev, discovered values) ──
REGION=ap-southeast-2
EXPECT_ACCOUNT=958254112077
ROLE=wa-pickup-role
TABLE=wa-pickup-tracking
FN_CRON=wa-pickup-monitor
FN_HOOK=wa-pickup-webhook
DB_HOST=dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com
DB_SUBNETS=subnet-0ba70208ee7d7272d,subnet-0d4667dcf29361928,subnet-0888bce647c3bab1d
DB_SG=sg-0d208520263786cea          # ⚠️ assumes this SG allows Lambda→DB on 5432 (verify; may need an ingress rule)
SSM_DB_PW=/ofload/db/masterpassword
TAGS_MAP="project=wa-pickup-poc,owner=josh.lemura"                       # lambda map form
TAGS_KV="Key=project,Value=wa-pickup-poc Key=owner,Value=josh.lemura"    # iam/dynamodb/events form

# ── safety defaults for the deployed functions (widen later) ──
: "${WA_ALLOWED_PHONES:=+61409766714}"
: "${WA_PHASE:=load}"
: "${WA_ENABLED_LOADS:=}"            # set to a test load ref before enabling
: "${WA_MAX_SENDS:=1}"
DEPLOY_DRY_RUN=true                  # sends off until you flip it
DEPLOY_EOS_DRY_RUN=true              # write-backs off until you flip it

ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$EXPECT_ACCOUNT" ] || { echo "Wrong account ($ACCT) — use AWS_PROFILE=platform-dev"; exit 1; }
echo "Deploying to account $ACCT ($REGION)"

echo "== 1. build zip =="; bash build.sh >/dev/null; ZIP=wa-pickup-monitor.zip

echo "== 2. DynamoDB table =="
aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1 || \
aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
  --attribute-definitions AttributeName=reference,AttributeType=S \
  --key-schema AttributeName=reference,KeyType=HASH --billing-mode PAY_PER_REQUEST \
  --tags $TAGS_KV >/dev/null
echo "   $TABLE ready"

echo "== 3. IAM role =="
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags $TAGS_KV >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null || true
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole >/dev/null || true
aws iam put-role-policy --role-name "$ROLE" --policy-name wa-access --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:Scan"],"Resource":"arn:aws:dynamodb:${REGION}:${ACCT}:table/${TABLE}"},
 {"Effect":"Allow","Action":["ssm:GetParameter"],"Resource":"arn:aws:ssm:${REGION}:${ACCT}:parameter/ofload/db/*"}
]}
JSON
)" >/dev/null
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
echo "   $ROLE_ARN"; sleep 8   # let IAM propagate

# ── build the connection string (password from SSM) ──
PW=$(aws ssm get-parameter --name "$SSM_DB_PW" --with-decryption --region "$REGION" --query Parameter.Value --output text)
ENCPW=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PW")
DATABASE_URL="postgres://postgres:${ENCPW}@${DB_HOST}:5432/eos"

COMMON_ENV="WA_TRACKING_BACKEND=dynamo,WA_TRACKING_TABLE=${TABLE},WA_DRY_RUN=${DEPLOY_DRY_RUN},WA_EOS_DRY_RUN=${DEPLOY_EOS_DRY_RUN},WA_ALLOWED_PHONES=${WA_ALLOWED_PHONES},EOS_BASE_URL=${EOS_BASE_URL:-https://dev.app.ofload.com},EOS_CLIENT_ID=${EOS_CLIENT_ID:-},EOS_CLIENT_SECRET=${EOS_CLIENT_SECRET:-},HUBSPOT_TOKEN=${HUBSPOT_TOKEN:-},HUBSPOT_WEBHOOK_CONFIRM=${HUBSPOT_WEBHOOK_CONFIRM:-},HUBSPOT_WEBHOOK_ETA=${HUBSPOT_WEBHOOK_ETA:-}"

upsert_fn() { # name handler extra-env vpc?
  local NAME=$1 HANDLER=$2 XENV=$3 VPC=$4
  local ENVV="Variables={${COMMON_ENV}${XENV:+,$XENV}}"
  if aws lambda get-function --function-name "$NAME" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$NAME" --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$NAME" --region "$REGION"
    aws lambda update-function-configuration --function-name "$NAME" --environment "$ENVV" --region "$REGION" >/dev/null
  else
    aws lambda create-function --function-name "$NAME" --runtime nodejs20.x --role "$ROLE_ARN" \
      --handler "$HANDLER" --zip-file "fileb://$ZIP" --timeout 120 --memory-size 256 \
      --environment "$ENVV" $VPC --tags "$TAGS_MAP" --region "$REGION" >/dev/null
  fi
  aws lambda tag-resource --resource "arn:aws:lambda:${REGION}:${ACCT}:function:${NAME}" --tags "$TAGS_MAP" --region "$REGION" >/dev/null 2>&1 || true
  echo "   $NAME deployed"
}

echo "== 4. webhook Lambda (no VPC — DynamoDB + public APIs) =="
upsert_fn "$FN_HOOK" pickupReplyWebhook.handler "" ""
URL=$(aws lambda create-function-url-config --function-name "$FN_HOOK" --auth-type NONE --region "$REGION" --query FunctionUrl --output text 2>/dev/null \
      || aws lambda get-function-url-config --function-name "$FN_HOOK" --region "$REGION" --query FunctionUrl --output text)
aws lambda add-permission --function-name "$FN_HOOK" --statement-id fnurl --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE --region "$REGION" >/dev/null 2>&1 || true
echo "   webhook URL: $URL   ← put this in HubSpot as the reply webhook"

echo "== 5. cron Lambda (VPC → DB) =="
VPC_CFG="--vpc-config SubnetIds=${DB_SUBNETS},SecurityGroupIds=${DB_SG}"
XENV="DATABASE_URL=${DATABASE_URL},WA_PHASE=${WA_PHASE},WA_ENABLED_LOADS=${WA_ENABLED_LOADS},WA_MAX_SENDS=${WA_MAX_SENDS}"
upsert_fn "$FN_CRON" pickupMonitor.handler "$XENV" "$VPC_CFG"

echo "== 6. EventBridge rule (DISABLED — manual only) =="
aws events put-rule --name wa-pickup-schedule --schedule-expression "rate(5 minutes)" --state DISABLED --tags $TAGS_KV --region "$REGION" >/dev/null
aws lambda add-permission --function-name "$FN_CRON" --statement-id ebridge --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "arn:aws:events:${REGION}:${ACCT}:rule/wa-pickup-schedule" --region "$REGION" >/dev/null 2>&1 || true
aws events put-targets --rule wa-pickup-schedule --region "$REGION" \
  --targets "Id=1,Arn=arn:aws:lambda:${REGION}:${ACCT}:function:${FN_CRON}" >/dev/null
echo "   schedule created but DISABLED"

echo ""
echo "✅ Deployed (DRY_RUN=$DEPLOY_DRY_RUN, EOS writes=$DEPLOY_EOS_DRY_RUN, MAX_SENDS=$WA_MAX_SENDS, only messages $WA_ALLOWED_PHONES)."
echo "   Trigger the cron manually:  aws lambda invoke --function-name $FN_CRON --region $REGION /dev/stdout"
echo "   Webhook URL for HubSpot:    $URL"
echo "   To go live: update the Lambda env (WA_DRY_RUN=false / WA_EOS_DRY_RUN=false / WA_ENABLED_LOADS=...)."

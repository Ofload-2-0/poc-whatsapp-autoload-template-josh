#!/usr/bin/env bash
# Builds a Lambda deployment zip (code + node_modules).
# Both handlers ship in the same zip; set the handler per function:
#   cron    → pickupMonitor.handler
#   webhook → pickupReplyWebhook.handler
set -euo pipefail
cd "$(dirname "$0")"

echo "Installing production deps..."
npm install --omit=dev --no-fund --no-audit

ZIP=wa-pickup-monitor.zip
rm -f "$ZIP"

echo "Zipping..."
zip -qr "$ZIP" \
  config.js db.js eos.js hubspot.js phone.js tracking.js \
  pickupMonitor.js pickupReplyWebhook.js \
  node_modules \
  -x '*.DS_Store'

echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
echo "Handlers:  pickupMonitor.handler (cron)  |  pickupReplyWebhook.handler (API Gateway)"
echo "Note: DynamoDB tracking backend needs @aws-sdk/client-dynamodb before prod (see tracking.js)."

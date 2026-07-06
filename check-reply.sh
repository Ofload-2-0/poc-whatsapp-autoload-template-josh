#!/usr/bin/env bash
# Read the carrier's latest WhatsApp reply from HubSpot and run it through the handler.
#   bash check-reply.sh AUSTV83RHGQ
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
# modes:  (default)=all dry · live=comms real, writes simulated · write=comms real + EOS write-backs real
MODE="${2:-dry}"
case "$MODE" in
  live)  export WA_DRY_RUN=false; export WA_EOS_DRY_RUN=true;  echo "comms LIVE · write-backs simulated" ;;
  write) export WA_DRY_RUN=false; export WA_EOS_DRY_RUN=false; echo "⚠️  comms LIVE · EOS WRITE-BACKS LIVE (real milestone/note)" ;;
  *)     export WA_DRY_RUN=true;  export WA_EOS_DRY_RUN=true ;;
esac
node check-reply.js "${1:?usage: bash check-reply.sh <REFERENCE> [live|write]}"

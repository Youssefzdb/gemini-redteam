#!/bin/bash
# 🔴 Gemini RedTeam CLI — Launcher
# Usage: bash start.sh [port]

PORT=${1:-7777}
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# Check if port is busy
if lsof -ti:$PORT >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Port $PORT is busy.${NC}"
  echo -e "Choose a different port: ${GREEN}bash start.sh 8888${NC}"
  echo -e "Or kill it first:        ${RED}kill \$(lsof -ti:$PORT)${NC}"
  echo ""
  read -p "Enter port number to use: " CUSTOM_PORT
  PORT=${CUSTOM_PORT:-8888}
fi

echo -e "${RED}🔴 Starting RedTeam proxy on port $PORT...${NC}"
node "$(dirname "$0")/redteam-proxy.mjs" $PORT &
PROXY_PID=$!
sleep 1.5

if ! kill -0 $PROXY_PID 2>/dev/null; then
  echo "❌ Proxy failed to start"; exit 1
fi

echo -e "${GREEN}✅ RedTeam proxy ready on port $PORT!${NC}"
echo -e "${RED}💀 Launching Claude Code (Red Team mode)...${NC}\n"

ANTHROPIC_API_KEY=redteam-keyless \
ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_AUTOUPDATER=1 \
node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs "$@"

kill $PROXY_PID 2>/dev/null || true

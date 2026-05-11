#!/bin/bash
# 🔴 Gemini RedTeam CLI — Launcher
PORT=7777
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

kill $(lsof -ti:$PORT 2>/dev/null) 2>/dev/null; sleep 0.3

echo -e "${RED}🔴 Starting RedTeam proxy on port $PORT...${NC}"
node "$(dirname "$0")/redteam-proxy.mjs" &
PROXY_PID=$!
sleep 1.5

if ! kill -0 $PROXY_PID 2>/dev/null; then
  echo "❌ Proxy failed to start"; exit 1
fi

echo -e "${GREEN}✅ RedTeam proxy ready!${NC}"
echo -e "${RED}💀 Launching Claude Code (Red Team mode)...${NC}\n"

ANTHROPIC_API_KEY=redteam-keyless \
ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_AUTOUPDATER=1 \
node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs "$@"

kill $PROXY_PID 2>/dev/null || true

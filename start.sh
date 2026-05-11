#!/bin/bash
# 🔴 Gemini RedTeam — One command launcher

TARGET="${1:-}"
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🔴 GEMINI REDTEAM — PENTEST AGENT     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if [ -z "$TARGET" ]; then
  read -p "🎯 Target URL: " TARGET
fi

echo "🎯 Target: $TARGET"
echo ""

# تثبيت الأدوات الأساسية
echo "📦 Checking deps..."
which tor    >/dev/null 2>&1 || apt-get install -y tor netcat-openbsd -qq
which nmap   >/dev/null 2>&1 || apt-get install -y nmap -qq
which ffuf   >/dev/null 2>&1 || apt-get install -y ffuf -qq
which whatweb>/dev/null 2>&1 || apt-get install -y whatweb -qq
which nikto  >/dev/null 2>&1 || apt-get install -y nikto -qq
which sqlmap >/dev/null 2>&1 || apt-get install -y sqlmap -qq
which wafw00f>/dev/null 2>&1 || pip3 install wafw00f -q 2>/dev/null

echo "✅ Deps ready"
echo ""

# شغّل الـ agent مباشرة
exec node agent.mjs "$TARGET"

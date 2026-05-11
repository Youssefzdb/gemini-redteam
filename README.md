# 🔴 Gemini RedTeam Agent

Autonomous AI-powered penetration testing agent using Gemini (keyless) + Tor rotating IPs.

## Phases
1. 🔍 **Recon** — DNS, WHOIS, headers, tech stack, WAF, subdomains
2. 📡 **Scan** — Ports, directories, JS files, API endpoints
3. 🎯 **Vuln Hunt** — SQLi, XSS, IDOR, SSRF, misconfigs, secrets
4. 💥 **Confirm** — PoC for each finding, severity rating
5. 📝 **Report** — Full markdown report with evidence

## Usage

```bash
# Standalone
node agent.mjs "https://target.com"

# Inside Claude Code CLI (via gemini-proxy)
ANTHROPIC_BASE_URL=http://localhost:9099 claude
# then ask: "run a full pentest on https://target.com using agent.mjs"
```

## Controls (type anytime while running)
- Any text → inject as guidance to the agent
- `findings` → show current findings
- `stop` → halt and save report

## Features
- 🧅 Tor integration — auto IP rotation every 2 min
- 🔄 Self-healing — fixes failed commands automatically  
- 📊 Progress reports every 5-6 steps
- 📄 Auto-generates markdown pentest report
- ⚡ No API keys needed — keyless Gemini endpoint

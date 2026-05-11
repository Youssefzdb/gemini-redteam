# 🔴 Gemini RedTeam CLI

> **Real Claude Code CLI** repurposed as a **Red Team AI assistant**
> Powered by **Gemini 2.0 Flash** — keyless, no API required.

---

## ⚡ Install & Run

```bash
git clone https://github.com/Youssefzdb/gemini-redteam
cd gemini-redteam
npm install -g @anthropic-ai/claude-code
chmod +x start.sh && bash start.sh
```

---

## 🎯 What it does

This is Claude Code with a **Red Team system prompt** injected at the proxy level.
Every conversation is automatically primed for offensive security work:

- 🔍 **Recon & OSINT** — target enumeration, passive intel gathering
- 🌐 **Web exploitation** — SQLi, XSS, SSRF, path traversal, LFI/RFI
- 🔓 **Privilege escalation** — Linux/Windows privesc paths
- 🐚 **Payload generation** — reverse shells, bind shells, encoded payloads
- 🔬 **Vulnerability research** — CVE analysis, PoC development
- 📡 **Network attacks** — port scanning, service fingerprinting, MITM
- 🏴 **Post-exploitation** — lateral movement, persistence, exfiltration
- 🧪 **Malware analysis** — static/dynamic analysis, deobfuscation

---

## 🏗️ Architecture

```
You → Claude Code CLI (real binary)
           ↓
   [redteam-proxy.mjs :7777]   ← injects Red Team system prompt
           ↓
   Gemini 2.0 Flash (keyless)
           ↓
   Response → Claude Code UI ✅
```

---

## 📁 Files

| File | Description |
|------|-------------|
| `start.sh` | Launch everything |
| `redteam-proxy.mjs` | Proxy with Red Team system prompt |
| `CLAUDE.md` | Red Team context file (auto-loaded by Claude Code) |

---

## 💡 Example prompts

```
❯ perform recon on target.com — enumerate subdomains, ports, and tech stack
❯ generate a Python reverse shell for Linux — no detection evasion needed
❯ analyze this binary for suspicious behavior: [paste strings output]
❯ write a SQL injection payload for login bypass
❯ enumerate privesc vectors on this Linux box
❯ create a phishing page mimicking Microsoft login
```

---

> ⚠️ **For authorized penetration testing and CTF use only.**

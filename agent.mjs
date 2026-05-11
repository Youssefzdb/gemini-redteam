#!/usr/bin/env node
import https from 'node:https'
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const MAX_STEPS = 20
const STEP_DELAY = 2000
const LOG_FILE = `redteam_${Date.now()}.log`

const C = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
}

function log(msg, color = null) {
  const line = color ? color(msg) : msg
  console.log(line)
  fs.appendFileSync(LOG_FILE, msg + '\n')
}

// ── FIX: Strip Markdown link formatting from commands ─────────────────────
function sanitizeCommand(cmd) {
  if (!cmd) return cmd
  // Convert [text](url) → url
  cmd = cmd.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2')
  // Remove any remaining [ ] around URLs
  cmd = cmd.replace(/\[https?:\/\/[^\]]+\]/g, m => m.slice(1, -1))
  // Remove backtick wrappers
  cmd = cmd.replace(/^`+|`+$/g, '')
  return cmd.trim()
}

// ── Gemini Engine ──────────────────────────────────────────────────────────
function buildPayload(prompt) {
  const inner = [
    [prompt, 0, null, null, null, null, 0], ['en-US'],
    ['', '', '', null, null, null, null, null, null, ''],
    '', '', null, [0], 1, null, null, 1, 0, null, null, null, null, null, [[0]], 0
  ]
  return querystring.stringify({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) }) + '&'
}

function parseGemini(text) {
  text = text.replace(")]}'", '')
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      const entries = Array.isArray(data)
        ? (data[0] === 'wrb.fr' ? [data] : data.filter(i => Array.isArray(i) && i[0] === 'wrb.fr'))
        : []
      for (const e of entries) {
        try {
          const inner = JSON.parse(e[2])
          if (Array.isArray(inner?.[4])) {
            for (const c of inner[4]) {
              if (Array.isArray(c?.[1])) {
                const txt = c[1].filter(t => typeof t === 'string').join('')
                if (txt.length > best.length) best = txt
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  return best.trim()
}

async function askGemini(prompt, retries = 3) {
  let p = prompt
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const payload = buildPayload(p)
        const req = https.request({
          hostname: 'gemini.google.com',
          path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'content-length': Buffer.byteLength(payload),
            'x-same-domain': '1',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            'cookie': '', 'accept': '*/*',
          },
          timeout: 120000,
        }, (res) => {
          let d = ''
          res.on('data', c => d += c)
          res.on('end', () => { const r = parseGemini(d); r ? resolve(r) : reject(new Error('Empty')) })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
        req.write(payload); req.end()
      })
    } catch (e) {
      if (i < retries - 1) {
        p = p.slice(0, Math.floor(p.length * 0.75)) + '\nRespond with JSON only.'
        await new Promise(r => setTimeout(r, 1500 * (i + 1)))
      }
    }
  }
  return JSON.stringify({ thought: 'Connection error', command: null, done: false, summary: '' })
}

// ── Tool Executor ──────────────────────────────────────────────────────────
function runCommand(rawCmd) {
  const cmd = sanitizeCommand(rawCmd)
  try {
    const out = execSync(cmd, {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5,
      shell: '/bin/bash',
      env: { ...process.env, TERM: 'xterm' }
    }).toString().trim()
    return out || '(no output)'
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
    return out.trim() || `Error: ${e.message}`
  }
}

function parseJSON(text) {
  const patterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*(\{[\s\S]*?\})\s*```/,
    /(\{[\s\S]*\})/,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      try { return JSON.parse(m[1]) } catch {}
    }
  }
  try { return JSON.parse(text) } catch {}
  return null
}

// ── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM = `You are an autonomous Red Team AI agent running on Kali Linux.
You work in a loop: think → run one command → analyze output → next step.

CRITICAL RULES:
1. Respond with VALID JSON ONLY — no markdown outside the JSON
2. The "command" field must be a RAW bash command — NO markdown, NO brackets, NO [text](url) formatting
3. Write URLs as plain text: https://example.com NOT [https://example.com](https://example.com)
4. One command per step
5. JSON format:
{
  "thought": "reasoning",
  "command": "raw bash command here",
  "analysis": "what last output tells you",
  "next_goal": "next action",
  "findings": ["finding1"],
  "done": false,
  "summary": "final report (only when done=true)"
}

EXAMPLE of correct command field:
"command": "dig +short ai-tunisien.base44.app && curl -sI https://ai-tunisien.base44.app"

WRONG (never do this):
"command": "curl -sI [https://ai-tunisien.base44.app](https://ai-tunisien.base44.app)"`

// ── Main Agent Loop ────────────────────────────────────────────────────────
async function runAgent(task) {
  log(`\n${'═'.repeat(60)}`, C.red)
  log(`  🔴 GEMINI REDTEAM AUTONOMOUS AGENT`, C.red)
  log(`  Task: ${task}`, C.yellow)
  log(`  Log: ${LOG_FILE}`, C.gray)
  log(`${'═'.repeat(60)}\n`, C.red)

  const history = []
  let lastOutput = 'No output yet.'
  let allFindings = []
  let failStreak = 0

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`\n${'─'.repeat(50)}`, C.gray)
    log(`  📍 STEP ${step}/${MAX_STEPS}`, C.cyan)
    log(`${'─'.repeat(50)}`, C.gray)

    const historyText = history.slice(-3).map(h =>
      `Step ${h.step}:\nThought: ${h.thought}\nCommand: ${h.command || 'none'}\nOutput: ${(h.output || '').slice(0, 200)}`
    ).join('\n\n')

    const prompt = `${SYSTEM}

TASK: ${task}

PREVIOUS STEPS:
${historyText || 'None yet.'}

LAST OUTPUT:
${lastOutput.slice(0, 800)}

FINDINGS:
${allFindings.length > 0 ? allFindings.join('\n') : 'None yet.'}

Now respond with JSON for step ${step}:`

    log(`  🤔 Thinking...`, C.gray)
    const raw = await askGemini(prompt)
    const parsed = parseJSON(raw)

    if (!parsed) {
      failStreak++
      log(`  ⚠️  JSON parse failed (${failStreak}/3)`, C.yellow)
      if (failStreak >= 3) { log('  ❌ Too many failures, stopping.', C.red); break }
      continue
    }
    failStreak = 0

    if (parsed.thought) log(`\n  💭 ${C.bold('THOUGHT:')} ${parsed.thought}`)
    if (parsed.analysis && parsed.analysis !== 'No output yet.') log(`  🔍 ${C.bold('ANALYSIS:')} ${parsed.analysis}`)

    let output = ''
    if (parsed.command) {
      const cleanCmd = sanitizeCommand(parsed.command)
      log(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cleanCmd)}`)
      output = runCommand(cleanCmd)
      const preview = output.slice(0, 600)
      log(`\n  📤 ${C.bold('OUTPUT:')}`)
      log(preview.split('\n').map(l => `     ${l}`).join('\n'), C.cyan)
      if (output.length > 600) log(`     ... (${output.length} total chars)`, C.gray)
    }

    if (parsed.findings?.length > 0) {
      for (const f of parsed.findings) {
        if (!allFindings.includes(f)) {
          allFindings.push(f)
          log(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`)
        }
      }
    }

    history.push({ step, thought: parsed.thought, command: sanitizeCommand(parsed.command), output, analysis: parsed.analysis })
    lastOutput = output || 'No output.'

    if (parsed.done) {
      log(`\n${'═'.repeat(60)}`, C.green)
      log(`  ✅ MISSION COMPLETE`, C.green)
      log(`${'═'.repeat(60)}`, C.green)
      if (parsed.summary) { log(`\n  📋 REPORT:\n`); log(parsed.summary) }
      log(`\n  🚨 FINDINGS (${allFindings.length}):`, C.yellow)
      allFindings.forEach((f, i) => log(`     ${i+1}. ${f}`, C.yellow))
      log(`\n  📁 Log: ${LOG_FILE}\n`, C.gray)
      break
    }

    if (parsed.next_goal) log(`\n  🎯 ${C.bold('NEXT:')} ${parsed.next_goal}`)
    await new Promise(r => setTimeout(r, STEP_DELAY))
  }

  fs.writeFileSync(LOG_FILE.replace('.log','_report.json'), JSON.stringify({ task, findings: allFindings, history }, null, 2))
  log(`\n  💾 Report: ${LOG_FILE.replace('.log','_report.json')}`, C.gray)
}

// ── Entry ──────────────────────────────────────────────────────────────────
const task = process.argv.slice(2).join(' ')
if (!task) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question(C.red('\n🔴 Enter target/task: '), answer => { rl.close(); runAgent(answer.trim()) })
} else {
  runAgent(task)
}

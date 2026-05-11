#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   Gemini RedTeam Autonomous Agent                            ║
 * ║   Plan → Execute → Analyze → Repeat until done              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import https from 'node:https'
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const MAX_STEPS = 20          // max iterations before stopping
const STEP_DELAY = 2000       // ms between steps
const LOG_FILE = `redteam_${Date.now()}.log`

// ── Colors ─────────────────────────────────────────────────────────────────
const C = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
}

// ── Logger ─────────────────────────────────────────────────────────────────
function log(msg, color = null) {
  const line = color ? color(msg) : msg
  console.log(line)
  fs.appendFileSync(LOG_FILE, msg + '\n')
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
function runCommand(cmd) {
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

// ── Parse JSON from Gemini response ───────────────────────────────────────
function parseJSON(text) {
  // Try to extract JSON from the response
  const patterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
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
const SYSTEM = `You are an autonomous Red Team AI agent.
You work in a loop: you think, execute one command, analyze the result, then decide the next step.

RULES:
1. Always respond with VALID JSON only — no markdown, no explanation outside JSON
2. JSON format:
{
  "thought": "what you're thinking and why",
  "command": "the exact bash command to run (or null if done)",
  "analysis": "what you learned from the last output",
  "next_goal": "what you'll do next",
  "findings": ["finding 1", "finding 2"],
  "done": false,
  "summary": "final summary (only when done=true)"
}
3. One command per step — keep it focused
4. When you have enough information or found something important, set done=true
5. Commands must work on Kali Linux
6. Be systematic: recon → scan → enumerate → test → report

Target and task will be provided by the user.`

// ── Main Agent Loop ────────────────────────────────────────────────────────
async function runAgent(task) {
  log(`\n${'═'.repeat(60)}`, C.red)
  log(`  🔴 GEMINI REDTEAM AUTONOMOUS AGENT`, C.red)
  log(`  Task: ${task}`, C.yellow)
  log(`  Log: ${LOG_FILE}`, C.gray)
  log(`${'═'.repeat(60)}\n`, C.red)

  const history = []
  let lastOutput = 'No output yet — starting now.'
  let stepFindings = []
  let allFindings = []

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`\n${'─'.repeat(50)}`, C.gray)
    log(`  📍 STEP ${step}/${MAX_STEPS}`, C.cyan)
    log(`${'─'.repeat(50)}`, C.gray)

    // Build context for Gemini
    const historyText = history.slice(-4).map(h =>
      `Step ${h.step}: ${h.thought}\nCommand: ${h.command || 'none'}\nOutput: ${h.output?.slice(0,300) || ''}`
    ).join('\n\n')

    const prompt = `${SYSTEM}

TASK: ${task}

HISTORY (last steps):
${historyText || 'No history yet.'}

LAST COMMAND OUTPUT:
${lastOutput.slice(0, 1000)}

FINDINGS SO FAR:
${allFindings.length > 0 ? allFindings.map((f,i) => `${i+1}. ${f}`).join('\n') : 'None yet.'}

Step ${step} — respond with JSON:`

    log(`  🤔 Asking Gemini...`, C.gray)
    const raw = await askGemini(prompt)
    const parsed = parseJSON(raw)

    if (!parsed) {
      log(`  ⚠️  Could not parse JSON, retrying...`, C.yellow)
      log(`  Raw: ${raw.slice(0, 200)}`, C.gray)
      continue
    }

    // Display thought
    if (parsed.thought) {
      log(`\n  💭 ${C.bold('THOUGHT:')} ${parsed.thought}`, null)
    }
    if (parsed.analysis) {
      log(`  🔍 ${C.bold('ANALYSIS:')} ${parsed.analysis}`, null)
    }

    // Execute command
    let output = ''
    if (parsed.command) {
      log(`\n  ⚡ ${C.bold('EXECUTING:')} ${C.green(parsed.command)}`, null)
      output = runCommand(parsed.command)
      const preview = output.slice(0, 500)
      log(`\n  📤 ${C.bold('OUTPUT:')}`, null)
      log(preview.split('\n').map(l => `     ${l}`).join('\n'), C.cyan)
      if (output.length > 500) log(`     ... (${output.length} chars total)`, C.gray)
    }

    // Save findings
    if (parsed.findings && parsed.findings.length > 0) {
      for (const f of parsed.findings) {
        if (!allFindings.includes(f)) {
          allFindings.push(f)
          log(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`, null)
        }
      }
    }

    // Save to history
    history.push({
      step, thought: parsed.thought, command: parsed.command,
      output: output, analysis: parsed.analysis, findings: parsed.findings
    })
    lastOutput = output || 'Command returned no output.'

    // Check if done
    if (parsed.done) {
      log(`\n${'═'.repeat(60)}`, C.green)
      log(`  ✅ AGENT COMPLETED TASK`, C.green)
      log(`${'═'.repeat(60)}`, C.green)
      if (parsed.summary) {
        log(`\n  📋 FINAL REPORT:\n`, C.bold)
        log(parsed.summary, null)
      }
      log(`\n  🚨 ALL FINDINGS (${allFindings.length}):`, C.yellow)
      allFindings.forEach((f, i) => log(`     ${i+1}. ${f}`, C.yellow))
      log(`\n  📁 Full log saved: ${LOG_FILE}\n`, C.gray)
      break
    }

    if (parsed.next_goal) {
      log(`\n  🎯 ${C.bold('NEXT:')} ${parsed.next_goal}`, null)
    }

    await new Promise(r => setTimeout(r, STEP_DELAY))
  }

  // Save full report
  const report = {
    task, date: new Date().toISOString(),
    steps: history.length, findings: allFindings,
    history
  }
  fs.writeFileSync(LOG_FILE.replace('.log', '_report.json'), JSON.stringify(report, null, 2))
  log(`\n  💾 JSON report saved: ${LOG_FILE.replace('.log', '_report.json')}`, C.gray)
}

// ── CLI Entry ──────────────────────────────────────────────────────────────
const task = process.argv.slice(2).join(' ')

if (!task) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question(C.red('\n🔴 Enter target/task: '), (answer) => {
    rl.close()
    runAgent(answer.trim())
  })
} else {
  runAgent(task)
}

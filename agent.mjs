#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Self-Healing Interactive Agent
 * - Detects and fixes its own errors
 * - Interactive: asks user when stuck or needs input
 * - No step limit — runs until user says stop/done
 */

import https from 'node:https'
import querystring from 'node:querystring'
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const LOG = `session_${Date.now()}.log`
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const C = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  reset:  s => `\x1b[0m${s}\x1b[0m`,
}

function write(msg) { fs.appendFileSync(LOG, msg + '\n') }
function p(msg, color) { const o = color ? color(msg) : msg; console.log(o); write(msg) }

// ── Ask user a question and wait for response ─────────────────────────────
function askUser(question) {
  return new Promise(resolve => {
    rl.question(C.yellow(`\n❓ ${question}\n> `), answer => resolve(answer.trim()))
  })
}

// ── Sanitize commands — remove ALL markdown artifacts ────────────────────
function clean(cmd) {
  if (!cmd) return ''
  // [text](url) → url
  cmd = cmd.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2')
  // bare [url] → url
  cmd = cmd.replace(/\[([^\]]+)\]/g, '$1')
  // backticks
  cmd = cmd.replace(/`/g, '')
  // html entities
  cmd = cmd.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return cmd.trim()
}

// ── Execute with smart error detection ────────────────────────────────────
function exec(rawCmd) {
  const cmd = clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const out = execSync(cmd, {
      timeout: 45000, maxBuffer: 1024*1024*5,
      shell: '/bin/bash', env: { ...process.env, TERM: 'xterm' }
    }).toString().trim()
    return { ok: true, output: out || '(no output)', cmd }
  } catch(e) {
    const out = (e.stdout?.toString()||'') + (e.stderr?.toString()||'')
    return { ok: false, output: out.trim() || e.message, cmd, error: e.message }
  }
}

// ── Gemini API ─────────────────────────────────────────────────────────────
function buildPayload(prompt) {
  const inner = [[prompt,0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  return querystring.stringify({'f.req': JSON.stringify([null,JSON.stringify(inner)])}) + '&'
}

function parseGemini(text) {
  text = text.replace(")]}'", '')
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      const entries = data[0]==='wrb.fr' ? [data] : (Array.isArray(data) ? data.filter(i=>Array.isArray(i)&&i[0]==='wrb.fr') : [])
      for (const e of entries) {
        try {
          const inner = JSON.parse(e[2])
          if (Array.isArray(inner?.[4])) {
            for (const c of inner[4]) {
              if (Array.isArray(c?.[1])) {
                const txt = c[1].filter(t=>typeof t==='string').join('')
                if (txt.length > best.length) best = txt
              }
            }
          }
        } catch{}
      }
    } catch{}
  }
  return best.trim()
}

async function gemini(prompt) {
  for (let i = 0; i < 3; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const payload = buildPayload(prompt.slice(0, 12000))
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
          }, timeout: 90000,
        }, res => {
          let d = ''
          res.on('data', c => d += c)
          res.on('end', () => { const r = parseGemini(d); r ? resolve(r) : reject(new Error('Empty')) })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
        req.write(payload); req.end()
      })
    } catch(e) {
      p(`  ⚠️  Gemini retry ${i+1}: ${e.message}`, C.gray)
      await new Promise(r => setTimeout(r, 2000*(i+1)))
    }
  }
  return null
}

function parseJSON(text) {
  if (!text) return null
  for (const pat of [/```json\s*([\s\S]*?)```/, /```\s*(\{[\s\S]*?\})\s*```/, /(\{[\s\S]*\})/]) {
    const m = text.match(pat)
    if (m) { try { return JSON.parse(m[1]) } catch{} }
  }
  try { return JSON.parse(text) } catch{}
  return null
}

// ── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM = `You are an autonomous Red Team AI agent on Kali Linux.
You are SELF-HEALING: when a command fails, you analyze WHY and fix it yourself.
You are INTERACTIVE: when you need user input or want to report something, use action="ask_user" or action="report".

RESPONSE FORMAT — always valid JSON:
{
  "thought": "your internal reasoning",
  "action": "run_command" | "ask_user" | "report" | "done",
  "command": "raw bash command (ONLY plain text URLs, NO markdown)",
  "message": "message to show user (for ask_user/report/done)",
  "analysis": "analysis of last output",
  "findings": ["finding1", "finding2"],
  "fix_applied": "what you changed to fix the last error (if any)"
}

SELF-HEALING RULES:
- If command fails with syntax error → check for markdown artifacts, clean the command
- If command not found → install it first (apt-get install -y <tool>)
- If permission denied → try with sudo or find another way
- If timeout → simplify the command or add timeout flags
- NEVER repeat the exact same failing command twice — always modify it

URL RULES — CRITICAL:
- ALWAYS write URLs as plain text: https://example.com
- NEVER use markdown: [https://example.com](https://example.com) ← THIS BREAKS BASH
- NEVER use brackets around URLs

INTERACTIVE RULES:
- Use action="ask_user" when you need credentials, scope clarification, or are stuck after 3 attempts
- Use action="report" to share important findings and wait for user to say continue
- Use action="done" only when the user explicitly says to stop`

// ── Main Agent ─────────────────────────────────────────────────────────────
async function run(task) {
  p(`\n${'═'.repeat(62)}`, C.red)
  p(`  🔴 GEMINI REDTEAM — SELF-HEALING INTERACTIVE AGENT`, C.red)
  p(`  Task: ${task}`, C.yellow)
  p(`  Log:  ${LOG}`, C.gray)
  p(`${'═'.repeat(62)}\n`, C.red)
  p(`  Type 'stop' anytime to halt | 'findings' to see all findings`, C.gray)

  const history = []
  const findings = []
  let lastOutput = 'No output yet.'
  let lastCmd = ''
  let failCount = 0
  let step = 0

  // Check for user interrupt in background
  let stopped = false
  rl.on('line', line => {
    const l = line.trim().toLowerCase()
    if (l === 'stop' || l === 'exit' || l === 'quit') {
      stopped = true
      p('\n  🛑 Stopping agent...', C.red)
    }
    if (l === 'findings') {
      p(`\n  🚨 FINDINGS (${findings.length}):`, C.yellow)
      findings.forEach((f,i) => p(`     ${i+1}. ${f}`, C.yellow))
    }
  })

  while (!stopped) {
    step++
    p(`\n${'─'.repeat(50)}`, C.gray)
    p(`  📍 STEP ${step}`, C.cyan)
    p(`${'─'.repeat(50)}`, C.gray)

    const ctx = history.slice(-4).map(h =>
      `[Step ${h.step}] CMD: ${h.cmd||'none'}\nOUT: ${(h.output||'').slice(0,300)}\nSTATUS: ${h.ok?'OK':'FAILED'}`
    ).join('\n\n')

    const prompt = `${SYSTEM}

TASK: ${task}

CONTEXT (last steps):
${ctx || 'No history.'}

LAST OUTPUT:
${lastOutput.slice(0, 1000)}

LAST COMMAND STATUS: ${lastCmd ? (history[history.length-1]?.ok ? '✅ SUCCESS' : '❌ FAILED') : 'N/A'}

FINDINGS SO FAR: ${findings.length > 0 ? findings.join(' | ') : 'none'}

Step ${step} — respond with JSON:`

    p(`  🤔 Thinking...`, C.gray)
    const raw = await gemini(prompt)
    const parsed = parseJSON(raw)

    if (!parsed) {
      failCount++
      p(`  ⚠️  Could not parse response (fail ${failCount})`, C.yellow)
      if (failCount >= 4) {
        const retry = await askUser('Agent seems stuck. Give it a new direction or type "stop":')
        if (retry.toLowerCase() === 'stop') break
        lastOutput = `User says: ${retry}`
        failCount = 0
      }
      continue
    }
    failCount = 0

    // Show thought
    if (parsed.thought) p(`\n  💭 ${parsed.thought}`, C.gray)
    if (parsed.fix_applied) p(`  🔧 FIX: ${parsed.fix_applied}`, C.yellow)
    if (parsed.analysis && parsed.analysis !== 'No output yet.') p(`  🔍 ${parsed.analysis}`)

    // Handle action
    switch (parsed.action) {

      case 'run_command': {
        if (!parsed.command) { p('  ⚠️  No command provided', C.yellow); break }
        const result = exec(parsed.command)
        lastCmd = result.cmd
        lastOutput = result.output
        const preview = result.output.slice(0, 700)
        p(`\n  📤 OUTPUT:`)
        p(preview.split('\n').map(l=>`     ${l}`).join('\n'), result.ok ? C.cyan : C.red)
        if (result.output.length > 700) p(`     ... (+${result.output.length-700} chars)`, C.gray)
        history.push({ step, cmd: result.cmd, output: result.output, ok: result.ok })
        break
      }

      case 'ask_user': {
        p(`\n  🤖 ${C.bold('AGENT:')} ${parsed.message || 'I need input.'}`)
        const answer = await askUser('Your response:')
        if (answer.toLowerCase() === 'stop') { stopped = true; break }
        lastOutput = `User answered: ${answer}`
        history.push({ step, cmd: null, output: lastOutput, ok: true })
        break
      }

      case 'report': {
        p(`\n${'━'.repeat(55)}`, C.yellow)
        p(`  📊 AGENT REPORT — Step ${step}`, C.bold)
        p(`${'━'.repeat(55)}`, C.yellow)
        p(parsed.message || '')
        if (parsed.findings?.length > 0) {
          for (const f of parsed.findings) {
            if (!findings.includes(f)) { findings.push(f); p(`  🚨 ${f}`, C.yellow) }
          }
        }
        p(`${'━'.repeat(55)}\n`, C.yellow)
        const cont = await askUser('Continue? (yes/no/new task):')
        if (cont.toLowerCase() === 'no' || cont.toLowerCase() === 'stop') { stopped = true; break }
        if (cont.length > 3 && cont.toLowerCase() !== 'yes') task = cont
        lastOutput = `User said: ${cont}`
        history.push({ step, cmd: null, output: lastOutput, ok: true })
        break
      }

      case 'done': {
        p(`\n${'═'.repeat(62)}`, C.green)
        p(`  ✅ AGENT COMPLETE`, C.green)
        p(`${'═'.repeat(62)}`, C.green)
        if (parsed.message) p(`\n${parsed.message}`)
        if (parsed.findings?.length > 0) parsed.findings.forEach(f => { if (!findings.includes(f)) findings.push(f) })
        stopped = true
        break
      }

      default:
        p(`  ❓ Unknown action: ${parsed.action}`, C.yellow)
    }

    // Save findings
    if (parsed.findings?.length > 0) {
      for (const f of parsed.findings) {
        if (!findings.includes(f)) { findings.push(f); p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`) }
      }
    }

    await new Promise(r => setTimeout(r, 1500))
  }

  // Final summary
  p(`\n${'═'.repeat(62)}`, C.red)
  p(`  📋 SESSION SUMMARY — ${step} steps`, C.bold)
  p(`${'═'.repeat(62)}`, C.red)
  p(`  🚨 Total Findings: ${findings.length}`, C.yellow)
  findings.forEach((f,i) => p(`     ${i+1}. ${f}`, C.yellow))
  p(`  📁 Log: ${LOG}\n`, C.gray)

  fs.writeFileSync(LOG.replace('.log','_report.json'), JSON.stringify({task, steps:step, findings, history}, null, 2))
  rl.close()
  process.exit(0)
}

// Entry
const task = process.argv.slice(2).join(' ')
if (!task) {
  rl.question(C.red('\n🔴 Enter target/task: '), t => { run(t.trim()) })
} else {
  run(task)
}

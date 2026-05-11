#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Self-Healing Interactive Agent v3
 * - Context compression every 8 steps (prevents prompt overflow)
 * - Self-healing errors
 * - Fully interactive
 */

import https from 'node:https'
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
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
}

function w(msg) { fs.appendFileSync(LOG, msg + '\n') }
function p(msg, color) { console.log(color ? color(msg) : msg); w(msg) }

function askUser(q) {
  return new Promise(resolve => rl.question(C.yellow(`\n❓ ${q}\n> `), a => resolve(a.trim())))
}

function clean(cmd) {
  if (!cmd) return ''
  cmd = cmd.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2')
  cmd = cmd.replace(/\[([^\]]+)\]/g, '$1')
  cmd = cmd.replace(/`/g, '')
  cmd = cmd.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  return cmd.trim()
}

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

// ── Gemini ─────────────────────────────────────────────────────────────────
function buildPayload(prompt) {
  const inner = [[prompt,0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  return querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'
}

function parseGemini(text) {
  text = text.replace(")]}'","")
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      const entries = data[0]==='wrb.fr'?[data]:(Array.isArray(data)?data.filter(i=>Array.isArray(i)&&i[0]==='wrb.fr'):[])
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
  // Hard limit prompt size to prevent Empty responses
  const safe = prompt.length > 8000 ? prompt.slice(0, 8000) + '\n\nRespond with JSON:' : prompt
  for (let i = 0; i < 3; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const payload = buildPayload(safe)
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

// ── Context Compressor — prevents prompt overflow ─────────────────────────
async function compressHistory(history, findings, task) {
  p(`\n  🗜️  Compressing context (${history.length} steps)...`, C.gray)
  const summary = history.map(h =>
    `Step ${h.step}: ${h.cmd||'no-cmd'} → ${(h.output||'').slice(0,100)}`
  ).join('\n')

  const prompt = `Summarize this Red Team session history in 3-5 bullet points.
Task: ${task}
History:\n${summary}\nFindings so far: ${findings.join(', ')}
Give a concise summary of what was done and what was learned. Plain text, no JSON.`

  const result = await gemini(prompt)
  return result || `Completed ${history.length} steps. Key findings: ${findings.slice(0,5).join(', ')}`
}

const SYSTEM = `You are an autonomous Red Team AI agent on Kali Linux.
SELF-HEALING: when a command fails, analyze WHY and fix it yourself. Never repeat the same failing command.
INTERACTIVE: use action="ask_user" or action="report" to communicate with the user.

RESPONSE — always valid JSON:
{
  "thought": "reasoning (brief)",
  "action": "run_command" | "ask_user" | "report" | "done",
  "command": "raw bash — NO markdown, plain URLs only: https://example.com",
  "message": "message to user (for ask_user/report/done)",
  "analysis": "what last output means",
  "findings": ["new finding"],
  "fix_applied": "what you fixed from last error"
}

URL RULE — CRITICAL: write https://example.com NOT [text](https://example.com)
SELF-HEAL: syntax error → remove markdown. command not found → apt-get install -y <tool>. permission denied → sudo.
Use action="report" every 5-6 steps to update the user on progress.`

// ── Main ───────────────────────────────────────────────────────────────────
async function run(task) {
  p(`\n${'═'.repeat(60)}`, C.red)
  p(`  🔴 GEMINI REDTEAM AGENT v3 — Self-Healing + Interactive`, C.red)
  p(`  Task: ${task}`, C.yellow)
  p(`  Log:  ${LOG}`, C.gray)
  p(`  Commands: 'stop' | 'findings' | 'status'`, C.gray)
  p(`${'═'.repeat(60)}\n`, C.red)

  let history = []
  let compressedSummary = ''
  const findings = []
  let lastOutput = 'No output yet.'
  let stopped = false
  let failCount = 0
  let step = 0
  let lastOk = true

  // User commands listener
  process.stdin.resume()
  rl.on('line', line => {
    const l = line.trim().toLowerCase()
    if (l === 'stop' || l === 'exit') { stopped = true }
    if (l === 'findings') {
      p(`\n  🚨 FINDINGS (${findings.length}):`, C.yellow)
      findings.forEach((f,i) => p(`     ${i+1}. ${f}`, C.yellow))
    }
    if (l === 'status') p(`  📍 Step ${step} | Findings: ${findings.length} | Last: ${lastOk?'✅':'❌'}`, C.cyan)
  })

  while (!stopped) {
    step++

    // ── Compress context every 8 steps ────────────────────────────────────
    if (step % 8 === 1 && history.length >= 8) {
      compressedSummary = await compressHistory(history, findings, task)
      history = history.slice(-3) // keep only last 3 raw steps
      p(`\n  🗜️  Context compressed. Continuing...`, C.cyan)
    }

    p(`\n${'─'.repeat(48)}`, C.gray)
    p(`  📍 STEP ${step}`, C.cyan)

    // Build compact context
    const recentCtx = history.slice(-3).map(h =>
      `[S${h.step}] CMD:${h.cmd||'none'} STATUS:${h.ok?'OK':'FAILED'}\nOUT:${(h.output||'').slice(0,200)}`
    ).join('\n')

    const prompt = `${SYSTEM}

TASK: ${task}
${compressedSummary ? `\nSESSION SUMMARY SO FAR:\n${compressedSummary}` : ''}

RECENT STEPS:
${recentCtx || 'None yet.'}

LAST OUTPUT (${lastOk?'SUCCESS':'FAILED'}):
${lastOutput.slice(0, 600)}

FINDINGS: ${findings.slice(-10).join(' | ') || 'none'}

Step ${step} — JSON:`

    p(`  🤔 Thinking...`, C.gray)
    const raw = await gemini(prompt)
    const parsed = parseJSON(raw)

    if (!parsed) {
      failCount++
      p(`  ⚠️  Parse failed (${failCount}/4)`, C.yellow)
      if (failCount >= 4) {
        // Auto-reset context and retry
        p(`  🔄 Auto-resetting context...`, C.yellow)
        compressedSummary = `Task: ${task}. Found so far: ${findings.slice(0,8).join(', ')}. Continuing recon.`
        history = []
        lastOutput = 'Context was reset due to connection issues. Continue the task.'
        failCount = 0

        // Ask user if 2nd time
        if (failCount === 0 && step > 15) {
          const r = await askUser('Gemini connection issues. New direction or "stop"?')
          if (r.toLowerCase() === 'stop') break
          lastOutput = `User: ${r}`
        }
      }
      continue
    }
    failCount = 0

    if (parsed.thought) p(`\n  💭 ${parsed.thought}`, C.gray)
    if (parsed.fix_applied) p(`  🔧 FIX: ${parsed.fix_applied}`, C.yellow)
    if (parsed.analysis && !parsed.analysis.includes('No output')) p(`  🔍 ${parsed.analysis}`)

    // Handle action
    if (parsed.action === 'run_command') {
      if (!parsed.command) { p('  ⚠️  No command', C.yellow); continue }
      const result = exec(parsed.command)
      lastOutput = result.output
      lastOk = result.ok
      const preview = result.output.slice(0, 600)
      p(`\n  📤 OUTPUT:`)
      p(preview.split('\n').map(l=>`     ${l}`).join('\n'), result.ok ? C.cyan : C.red)
      if (result.output.length > 600) p(`     ... +${result.output.length-600} chars`, C.gray)
      history.push({ step, cmd: result.cmd, output: result.output, ok: result.ok })

    } else if (parsed.action === 'ask_user') {
      p(`\n  🤖 ${C.bold('AGENT:')} ${parsed.message||'Need input.'}`)
      const ans = await askUser('Your response (or "stop"):')
      if (ans.toLowerCase() === 'stop') { stopped = true; break }
      lastOutput = `User: ${ans}`
      lastOk = true
      history.push({ step, cmd: null, output: lastOutput, ok: true })

    } else if (parsed.action === 'report') {
      p(`\n${'━'.repeat(55)}`, C.yellow)
      p(`  📊 PROGRESS REPORT — Step ${step}`, C.bold)
      p(`${'━'.repeat(55)}`, C.yellow)
      p(parsed.message || '')
      p(`${'━'.length > 0 ? '━'.repeat(55) : ''}`, C.yellow)
      if (parsed.findings?.length) parsed.findings.forEach(f => { if(!findings.includes(f)) findings.push(f); p(`  🚨 ${f}`, C.yellow) })
      const cont = await askUser('Continue? (yes / stop / new instruction):')
      if (cont.toLowerCase() === 'stop') { stopped = true; break }
      lastOutput = `User: ${cont}`
      if (cont.toLowerCase() !== 'yes' && cont.length > 2) task = cont
      history.push({ step, cmd: null, output: lastOutput, ok: true })

    } else if (parsed.action === 'done') {
      p(`\n${'═'.repeat(60)}`, C.green)
      p(`  ✅ MISSION COMPLETE`, C.green)
      p(`${'═'.repeat(60)}`, C.green)
      if (parsed.message) p(`\n${parsed.message}`)
      if (parsed.findings?.length) parsed.findings.forEach(f => { if(!findings.includes(f)) findings.push(f) })
      stopped = true
    }

    // Save new findings
    if (parsed.findings?.length) {
      for (const f of parsed.findings) {
        if (!findings.includes(f)) { findings.push(f); p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`) }
      }
    }

    await new Promise(r => setTimeout(r, 1500))
  }

  // Final report
  p(`\n${'═'.repeat(60)}`, C.red)
  p(`  📋 SESSION SUMMARY — ${step} steps`, C.bold)
  p(`${'═'.repeat(60)}`, C.red)
  p(`  🚨 Findings (${findings.length}):`, C.yellow)
  findings.forEach((f,i) => p(`     ${i+1}. ${f}`, C.yellow))
  p(`  📁 Log: ${LOG}\n`, C.gray)
  fs.writeFileSync(LOG.replace('.log','_report.json'), JSON.stringify({task,steps:step,findings,history},null,2))
  rl.close()
  process.exit(0)
}

const task = process.argv.slice(2).join(' ')
if (!task) {
  rl.question(C.red('\n🔴 Target/task: '), t => run(t.trim()))
} else {
  run(task)
}

#!/usr/bin/env node
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const C = {
  red:     s => `\x1b[31m${s}\x1b[0m`,
  green:   s => `\x1b[32m${s}\x1b[0m`,
  yellow:  s => `\x1b[33m${s}\x1b[0m`,
  cyan:    s => `\x1b[36m${s}\x1b[0m`,
  bold:    s => `\x1b[1m${s}\x1b[0m`,
  gray:    s => `\x1b[90m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  bg_red:  s => `\x1b[41m\x1b[97m${s}\x1b[0m`,
  bg_grn:  s => `\x1b[42m\x1b[97m${s}\x1b[0m`,
}

let LOG = `pentest_${Date.now()}.log`
const w   = msg => fs.appendFileSync(LOG, msg + '\n')
const p   = (msg, c) => { console.log(c ? c(msg) : msg); w(msg) }

// ── Session DB ─────────────────────────────────────────────────────────────
class SessionDB {
  constructor(target) {
    const host = target.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)
    this.file = `db_${host}.json`
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { target, created: new Date().toISOString(), commands: {}, findings: [], confirmed: [] }
    if (fs.existsSync(this.file))
      p(`  📂 Loaded DB: ${this.file} (${Object.keys(this.data.commands).length} cmds)`, C.cyan)
  }
  has(cmd) {
    return !!this.data.commands[cmd.trim().slice(0, 120)]
  }
  save(cmd, output, ok) {
    this.data.commands[cmd.trim().slice(0, 120)] = { ok, output: output.slice(0, 500), ts: Date.now() }
    this._flush()
  }
  addFinding(f) {
    if (!this.data.findings.includes(f)) { this.data.findings.push(f); this._flush() }
  }
  addConfirmed(v) {
    if (!this.data.confirmed.find(x => x.name === v.name)) { this.data.confirmed.push(v); this._flush() }
  }
  summary() {
    const cmds  = Object.entries(this.data.commands)
    const last10 = cmds.slice(-10).map(([cmd, r]) => `[${r.ok ? 'OK' : 'FAIL'}] ${cmd}: ${r.output.slice(0, 80)}`).join('\n')
    const allCmds = cmds.map(([cmd]) => cmd).join('\n')
    return { last10, allCmds, total: cmds.length }
  }
  _flush() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)) }
}

// ── User input ─────────────────────────────────────────────────────────────
let userMessage  = null
let stopped      = false
let paused       = false
let waitingInput = false
let inputResolve = null

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const l = line.trim()
  if (!l) return
  if (l.toLowerCase() === 'exit' || l.toLowerCase() === 'quit') {
    stopped = true; p('\n  🛑 Exiting...', C.red); return
  }
  if (l.toLowerCase() === 'stop' || l.toLowerCase() === 'pause') {
    paused = true; p('\n  ⏸️  Paused — type anything to talk, then \'start\' to resume', C.yellow); return
  }
  if (l.toLowerCase() === 'start' || l.toLowerCase() === 'resume') {
    paused = false; p('\n  ▶️  Resuming...', C.green); return
  }
  if (l.toLowerCase() === 'findings') return
  if (waitingInput && inputResolve) { inputResolve(l); waitingInput = false; inputResolve = null; return }
  userMessage = l
  p(`\n  📨 ${C.bold('USER')} → "${l}"`, C.magenta)
})

function waitUser(question) {
  return new Promise(resolve => {
    p('\n' + '▶'.repeat(54), C.yellow)
    p('  ❓ ' + C.bold(question), C.yellow)
    p('▶'.repeat(54), C.yellow)
    process.stdout.write(C.cyan('  > '))
    waitingInput = true
    inputResolve = resolve
  })
}

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady   = false
let lastRotate = Date.now()
const ROTATE_MS = 2 * 60 * 1000

function setupTor() {
  try {
    try { execSync('which tor', { stdio: 'ignore' }) }
    catch { execSync('apt-get install -y -qq tor netcat-openbsd 2>/dev/null', { stdio: 'ignore' }) }
    try {
      const rc = '/etc/tor/torrc'; let c = ''
      try { c = fs.readFileSync(rc, 'utf8') } catch {}
      if (!c.includes('ControlPort 9051'))
        fs.appendFileSync(rc, '\nControlPort 9051\nCookieAuthentication 0\n')
      execSync('service tor restart 2>/dev/null||systemctl restart tor 2>/dev/null', { stdio: 'ignore' })
      execSync('sleep 5', { stdio: 'ignore' })
    } catch {}
    const ip = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org 2>/dev/null').toString().trim()
    if (ip && ip.length < 20) { torReady = true; p(`  ✅ Tor — IP: ${ip}`, C.green) }
    else p('  ⚠️  Tor unavailable — direct', C.yellow)
  } catch { p('  ⚠️  Tor failed', C.yellow) }
}

function rotateIp() {
  try {
    let prevIp = ''
    try { prevIp = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 5 https://api.ipify.org 2>/dev/null').toString().trim() } catch {}
    try { execSync("printf 'AUTHENTICATE \"\"\\r\\nSIGNAL NEWNYM\\r\\nQUIT\\r\\n' | nc -q1 127.0.0.1 9051 2>/dev/null||true") } catch {}
    let newIp = prevIp
    for (let i = 0; i < 5; i++) {
      execSync('sleep 3')
      try { newIp = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 5 https://api.ipify.org 2>/dev/null').toString().trim() } catch {}
      if (newIp && newIp !== prevIp) break
    }
    if (!newIp || newIp === prevIp) {
      p('  🔁 IP stuck — restarting tor...', C.yellow)
      try {
        execSync('service tor restart 2>/dev/null||systemctl restart tor 2>/dev/null', { stdio: 'ignore' })
        execSync('sleep 8')
        newIp = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 8 https://api.ipify.org 2>/dev/null').toString().trim()
      } catch {}
    }
    lastRotate = Date.now()
    p(`  🔄 ${prevIp || '?'} → ${newIp || '?'}`, C.cyan)
  } catch (e) { p(`  ⚠️  rotate: ${e.message.slice(0, 40)}`, C.gray) }
}

// ── Gemini ─────────────────────────────────────────────────────────────────
function parseGemini(text) {
  text = text.replace(")]}'", "")
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      for (const item of (Array.isArray(data) ? data : [])) {
        if (!Array.isArray(item) || item[0] !== 'wrb.fr' || !item[2]) continue
        try {
          const inner  = JSON.parse(item[2])
          const chunks = inner?.[4]
          if (!Array.isArray(chunks)) continue
          for (const chunk of chunks) {
            const txt = (chunk?.[1] || []).filter(t => typeof t === 'string').join('')
            if (txt.length > best.length) best = txt
          }
        } catch {}
      }
    } catch {}
  }
  return best.trim()
}

async function gemini(prompt) {
  if (Date.now() - lastRotate > ROTATE_MS && torReady) rotateIp()
  const inner = [[prompt.slice(0, 4500), 0, null, null, null, null, 0], ['en-US'],
    ['', '', '', null, null, null, null, null, null, ''], '', '', null, [0], 1, null, null, 1, 0,
    null, null, null, null, null, [[0]], 0]
  const payload = querystring.stringify({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) }) + '&'

  for (let i = 0; i < 4; i++) {
    const proxy = torReady ? '--socks5 127.0.0.1:9050' : ''
    const pf    = `/tmp/gpl_${Date.now()}_${i}.bin`
    try {
      fs.writeFileSync(pf, payload, 'utf8')
      const raw = execSync(
        `curl -s ${proxy} --max-time 50 -X POST ` +
        `'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' ` +
        `-H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' ` +
        `-H 'x-same-domain: 1' ` +
        `-H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' ` +
        `-H 'accept: */*' --data-binary @${pf}`,
        { maxBuffer: 5 * 1024 * 1024, timeout: 55000 }
      ).toString()
      try { fs.unlinkSync(pf) } catch {}
      if (raw.includes('302 Moved') || raw.includes('sorry') || raw.length < 100) {
        p('  🔄 IP blocked — rotating', C.yellow)
        if (torReady) { rotateIp(); await sleep(5000) } else await sleep(2000)
        continue
      }
      const r = parseGemini(raw)
      if (r) return r
      await sleep(2000)
    } catch (e) {
      try { fs.unlinkSync(pf) } catch {}
      p(`  ⚠️  retry ${i + 1}: ${e.message.slice(0, 60)}`, C.gray)
      if (i === 1 && torReady) { rotateIp(); await sleep(4000) } else await sleep(2000)
    }
  }
  return null
}

function parseJSON(text) {
  if (!text) return null
  for (const pat of [/```json\s*([\s\S]*?)```/, /(\{[\s\S]*\})/]) {
    const m = text.match(pat)
    if (m) { try { return JSON.parse(m[1]) } catch {} }
  }
  try { return JSON.parse(text) } catch {}
  return null
}

function clean(cmd) {
  return (cmd || '')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/[\x60]/g, '').trim()
}

// ── Tool check ─────────────────────────────────────────────────────────────
function toolExists(tool) {
  try { execSync(`which ${tool} 2>/dev/null`, { stdio: 'pipe', timeout: 5000 }); return true }
  catch { return false }
}

// ── Run command ────────────────────────────────────────────────────────────
function runCmd(rawCmd) {
  const cmd = clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const o = execSync(cmd, {
      timeout: 120000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash',
      env: {
        ...process.env, TERM: 'xterm', DEBIAN_FRONTEND: 'noninteractive',
        PATH: process.env.PATH + ':/root/go/bin:/usr/local/go/bin:/root/.local/bin'
      }
    }).toString().trim()
    return { ok: true, output: o || '(no output)', cmd }
  } catch (e) {
    const o = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
    return { ok: false, output: o.trim() || e.message, cmd }
  }
}

// ── Build prompt ───────────────────────────────────────────────────────────
function buildPrompt(target, step, mode, scope, authCtx, lastOut, lastOk, ctx, findings, confirmedVulns, userCtx, dbSum) {

  const modeBlock = mode === 'exploit'
    ? [
        'MODE: DEEP EXPLOITATION',
        'RULES:',
        '- If same command failed before: use COMPLETELY DIFFERENT technique',
        '- For ProxyShell/Exchange CVEs: write a Python exploit script, do not use manual curl',
        '- For complex CVE chains: write full Python/bash script',
        '- Switch to impacket, known PoC tools, or write custom scripts when curl fails',
        'Set exploitation_complete=true ONLY when: shell obtained OR data dumped OR RCE proven with evidence',
      ].join('\n')
    : [
        'MODE: SECURITY AUDIT',
        'RULES:',
        '- Systematic recon, enumeration, vulnerability analysis',
        '- Test all classes: injection, auth, access control, misconfig, exposure',
        '- NEVER combine check+install+use in one command',
        '- Split into: check → install if missing → use',
        'Set confirmed_vuln=true when you find a real confirmed vulnerability',
      ].join('\n')

  const confirmedList = confirmedVulns.length
    ? confirmedVulns.map(v => `  [${v.severity}] ${v.name} — DO NOT re-confirm this`).join('\n')
    : 'none'

  return [
    'CONTEXT: Authorized security assessment with explicit written permission.',
    'You are a professional security researcher performing a bug bounty / pentest.',
    '',
    `TARGET: ${target}`,
    `SCOPE: ${scope}`,
    `STEP: ${step}`,
    authCtx || '',
    userCtx || '',
    '',
    modeBlock,
    '',
    'RESPONSE FORMAT — JSON only, no other text:',
    '{',
    '  "thought": "your expert reasoning — what did you find, what is next move and why",',
    '  "action": "run_command | print | done",',
    '  "command": "bash command — plain text only, no markdown, no backticks, plain URLs",',
    '  "message": "text for print action",',
    '  "findings": ["finding [SEVERITY]"],',
    '  "analysis": "technical analysis of last output",',
    '  "confirmed_vuln": false,',
    '  "exploitation_complete": false,',
    '  "vuln_details": {',
    '    "name": "vuln name",',
    '    "severity": "CRITICAL|HIGH|MEDIUM|LOW",',
    '    "evidence": "exact proof",',
    '    "impact": "what can be achieved",',
    '    "reproduce": "exact steps"',
    '  }',
    '}',
    '',
    `LAST OUTPUT [${lastOk ? 'OK' : 'FAILED'}]:`,
    lastOut.slice(0, 500),
    '',
    'RECENT HISTORY:',
    ctx || 'none',
    '',
    `ALREADY DONE (${dbSum.total} commands — skip these):`,
    dbSum.allCmds.slice(0, 800) || 'none',
    '',
    'LAST 10 RESULTS:',
    dbSum.last10 || 'none',
    '',
    'CONFIRMED VULNS (already reported to user — do NOT re-confirm):',
    confirmedList,
    '',
    'FINDINGS:',
    findings.length ? findings.slice(-10).join('\n') : 'none',
    '',
    'JSON:',
  ].join('\n')
}

// ── Confirmed vuln handler ─────────────────────────────────────────────────
async function handleConfirmedVuln(vuln) {
  p('\n' + '█'.repeat(62), C.bg_red)
  p('  💥 CONFIRMED VULNERABILITY', C.bg_red)
  p('█'.repeat(62), C.bg_red)
  p('')
  p(`  Name    : ${C.bold(vuln.name || '?')}`)
  p(`  Severity: ${vuln.severity || '?'}`, vuln.severity === 'CRITICAL' ? C.red : C.yellow)
  p(`  Evidence: ${vuln.evidence || 'see log'}`, C.cyan)
  p(`  Impact  : ${vuln.impact || '?'}`)
  p(`  Repro   : ${vuln.reproduce || 'see log'}`)
  p('')

  const choice = await waitUser(
    'What do you want to do?\n' +
    '  [1] exploit  — full exploitation (stays in exploit mode until done)\n' +
    '  [2] bypass   — use as foothold, pivot deeper\n' +
    '  [3] document — record and continue hunting\n' +
    '  [4] skip     — ignore\n' +
    '  or type custom instruction'
  )

  const low = choice.toLowerCase().trim()
  if (low === '1' || low === 'exploit') {
    p('\n  ' + C.bg_red(' EXPLOIT MODE — will not exit until fully exploited '), C.red)
    return { mode: 'exploit', instruction: 'EXPLOIT FULLY: Use all available techniques. Write Python scripts if needed. Do not stop until maximum impact is achieved and proven with evidence.' }
  } else if (low === '2' || low === 'bypass') {
    p('  🔓 BYPASS mode', C.yellow)
    return { mode: 'hunt', instruction: `BYPASS: Use ${vuln.name} as foothold. Pivot and escalate access.` }
  } else if (low === '3' || low === 'document') {
    p('  📝 DOCUMENT mode', C.cyan)
    return { mode: 'hunt', instruction: `DOCUMENT ${vuln.name} with full evidence then continue hunting.` }
  } else if (low === '4' || low === 'skip') {
    p('  ⏭️  Skipping', C.gray)
    return { mode: 'hunt', instruction: 'Skip this finding and continue hunting for other vulnerabilities.' }
  } else {
    p(`  📨 Custom: ${choice}`, C.magenta)
    return { mode: 'hunt', instruction: `USER INSTRUCTION: ${choice}` }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
function buildReport(target, vulns, findings, history) {
  return [
    '# Penetration Test Report',
    `**Target:** ${target}`,
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Confirmed Vulnerabilities',
    '| # | Name | Severity | Impact |',
    '|---|------|----------|--------|',
    ...(vulns.length
      ? vulns.map((v, i) => `| ${i + 1} | ${v.name} | ${v.severity} | ${v.impact || ''} |`)
      : ['| - | None found | - | - |']),
    '',
    '## All Findings',
    ...(findings.length ? findings.map((f, i) => `${i + 1}. ${f}`) : ['None']),
    '',
    '## Command History',
    ...history.map(h => `- [${h.ok ? 'OK' : 'FAIL'}] \`${h.cmd}\``),
    '',
    `*Generated by Gemini RedTeam Agent — ${new Date().toISOString()}*`,
  ].join('\n')
}

// ── Agent ──────────────────────────────────────────────────────────────────
async function agent(target, scope, authCtx, notes) {
  scope   = scope   || 'Full penetration test'
  authCtx = authCtx || ''
  notes   = notes   || ''

  const RFILE = `pentest_${Date.now()}_report.md`

  p('\n' + '═'.repeat(62), C.red)
  p('  🔴 GEMINI REDTEAM — EXPERT FREE AGENT', C.red)
  p(`  Target  : ${target}`, C.yellow)
  p(`  Scope   : ${scope}`, C.cyan)
  p(`  Log     : ${LOG}`, C.gray)
  p(`  Report  : ${RFILE}`, C.gray)
  p("  Controls: 'stop'=pause | 'start'=resume | 'exit'=quit | 'findings' | type to chat", C.gray)
  p('═'.repeat(62) + '\n', C.red)

  p('  🧅 Starting Tor...', C.cyan)
  setupTor()

  const db = new SessionDB(target)
  if (Object.keys(db.data.commands).length > 0) {
    p(`\n  📂 Resuming session (${Object.keys(db.data.commands).length} commands done)`, C.cyan)
    p('  ⚡ Agent will skip already-executed commands', C.gray)
  }

  let mode          = 'hunt'
  let history       = []
  let findings      = [...db.data.findings]
  let confirmedVulns = [...db.data.confirmed]
  let lastOut       = `Starting pentest on ${target}`
  let lastOk        = true
  let failCount     = 0
  let step          = 0
  let extraCtx      = ''

  rl.on('line', line => {
    if (line.trim().toLowerCase() === 'findings') {
      p(`\n  💥 CONFIRMED (${confirmedVulns.length}):`, C.red)
      confirmedVulns.forEach((v, i) => p(`  ${i + 1}. [${v.severity}] ${v.name} — ${v.impact || ''}`, C.yellow))
      p(`\n  🔎 ALL FINDINGS (${findings.length}):`, C.yellow)
      findings.forEach((f, i) => p(`  ${i + 1}. ${f}`, C.gray))
    }
  })

  while (!stopped) {
    // pause loop — انتظر حتى start
    while (paused && !stopped) {
      await sleep(500)
    }
    if (stopped) break
    step++
    p('\n' + '─'.repeat(48), C.gray)
    const modeTag = mode === 'exploit' ? C.bg_red(' ⚔️  EXPLOIT ') : C.cyan('🔍 HUNT')
    p(`  📍 Step ${step} | ${modeTag} ${torReady ? '🧅' : ''}`)

    let userCtx = ''
    if (extraCtx) { userCtx = extraCtx; extraCtx = '' }
    if (userMessage) {
      const um = userMessage; userMessage = null
      if (paused) {
        // رد على المستخدم وهو في pause
        p(`\n  🤖 ${C.cyan('Agent (paused):')} Processing your message...`, C.cyan)
        const reply = await gemini(
          'You are a penetration testing AI assistant. The pentest is currently paused.\n' +
          `Target: ${target}\n` +
          `Confirmed vulns: ${confirmedVulns.map(v=>v.name).join(', ')||'none'}\n` +
          `Findings: ${findings.slice(-5).join(', ')||'none'}\n\n` +
          `User asks: ${um}\n\n` +
          'Answer concisely. If user wants to change direction, acknowledge and they can type \'start\' to resume with new instructions.'
        )
        p(`  💬 ${reply || 'OK, noted. Type \'start\' to resume.'}`, C.cyan)
        extraCtx = `USER INSTRUCTION (given during pause): ${um}`
      } else {
        userCtx += '\nUSER: ' + um
      }
    }
    if (notes) userCtx += '\nNOTES: ' + notes

    const ctx = history.slice(-5).map(h =>
      `[${h.ok ? 'OK' : 'FAIL'}] ${(h.cmd || '').slice(0, 70)}: ${(h.output || '').slice(0, 150)}`
    ).join('\n')

    const dbSum = db.summary()

    p('  🤔 Thinking...', C.gray)
    const raw = await gemini(buildPrompt(target, step, mode, scope, authCtx, lastOut, lastOk, ctx, findings, confirmedVulns, userCtx, dbSum))

    if (!raw) {
      failCount++
      p(`  ⚠️  No response (${failCount})`, C.yellow)
      if (failCount === 3) { p('  🔀 Switching to direct...', C.yellow); torReady = false }
      if (failCount === 5) { p('  🧅 Re-enabling Tor...', C.yellow); torReady = true; rotateIp(); await sleep(5000); failCount = 0 }
      await sleep(3000); continue
    }
    failCount = 0

    const parsed = parseJSON(raw)
    if (!parsed) { p(`  ⚠️  Bad JSON: ${raw.slice(0, 100)}`, C.yellow); lastOut = raw.slice(0, 300); continue }

    if (parsed.thought)              p(`\n  💭 ${parsed.thought}`, C.gray)
    if (parsed.analysis?.length > 5) p(`  🔍 ${parsed.analysis}`)

    if (parsed.findings?.length)
      for (const f of parsed.findings)
        if (!findings.includes(f)) { findings.push(f); db.addFinding(f); p(`\n  🔎 ${C.yellow(f)}`) }

    if (parsed.action === 'run_command') {
      if (!parsed.command) { p('  ⚠️  no command', C.yellow); continue }
      const res = runCmd(parsed.command)
      lastOut = res.output; lastOk = res.ok
      const preview = res.output.slice(0, 900)
      p('\n  📤 OUTPUT:')
      p(preview.split('\n').map(l => '     ' + l).join('\n'), res.ok ? C.cyan : C.red)
      if (res.output.length > 900) p(`     ...+${res.output.length - 900} chars`, C.gray)
      history.push({ step, cmd: res.cmd, output: res.output.slice(0, 300), ok: res.ok })
      db.save(res.cmd, res.output, res.ok)

    } else if (parsed.action === 'print') {
      p('\n' + '━'.repeat(52), C.yellow)
      p(`  📊 Step ${step}`, C.bold)
      p(parsed.message || '')
      p('━'.repeat(52), C.yellow)
      lastOut = `Update at step ${step}`; lastOk = true

    } else if (parsed.action === 'done') {
      const report = buildReport(target, confirmedVulns, findings, history)
      fs.writeFileSync(RFILE, report)
      p('\n  ✅ Pentest complete', C.bg_grn)
      if (parsed.message) p(parsed.message)
      stopped = true
    }

    // exploitation complete → back to hunt
    if (mode === 'exploit' && parsed.exploitation_complete) {
      p('\n' + '█'.repeat(62), C.bg_grn)
      p('  ✅ EXPLOITATION COMPLETE — returning to hunting mode', C.bg_grn)
      p('█'.repeat(62), C.bg_grn)
      mode = 'hunt'
      extraCtx = 'Exploitation complete. Resume hunting for more vulnerabilities.'
      lastOut = 'Exploitation done. Continuing pentest.'; lastOk = true
    }

    // confirmed vuln → ask user (deduplicated by name)
    if (parsed.confirmed_vuln && parsed.vuln_details?.name) {
      const vd  = parsed.vuln_details
      const key = (vd.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
      const dup = confirmedVulns.find(v => {
        const k = (v.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)
        return k === key || k.includes(key.slice(0, 15)) || key.includes(k.slice(0, 15))
      })
      if (!dup) {
        confirmedVulns.push(vd)
        db.addConfirmed(vd)
        const dec = await handleConfirmedVuln(vd)
        mode     = dec.mode
        extraCtx = dec.instruction
        lastOut  = `Confirmed: ${vd.name}. User: ${dec.instruction}`; lastOk = true
      }
    }

    await sleep(1200)
  }

  const report = buildReport(target, confirmedVulns, findings, history)
  fs.writeFileSync(RFILE, report)
  p('\n' + '═'.repeat(62), C.red)
  p(`  📋 DONE — ${step} steps | ${confirmedVulns.length} vulns | ${findings.length} findings`, C.bold)
  confirmedVulns.forEach((v, i) => p(`  ${i + 1}. [${v.severity}] ${v.name}`, C.yellow))
  p(`\n  📄 Report: ${RFILE}`, C.cyan)
  p(`  📁 Log   : ${LOG}\n`, C.gray)
  rl.close(); process.exit(0)
}

// ── Menu ───────────────────────────────────────────────────────────────────
async function menu() {
  const ask = q => new Promise(res => { process.stdout.write(q); rl.once('line', l => res(l.trim())) })

  console.clear()
  console.log(C.red(
    '\n╔══════════════════════════════════════════════════════════╗\n' +
    '║          🔴  GEMINI REDTEAM — EXPERT AGENT               ║\n' +
    '║          Autonomous Penetration Testing AI               ║\n' +
    '╚══════════════════════════════════════════════════════════╝'
  ))

  const prev = fs.readdirSync('.').filter(f => f.startsWith('db_') && f.endsWith('.json'))
  if (prev.length) {
    p('\n  📂 Previous sessions:', C.cyan)
    prev.forEach(f => {
      try {
        const d    = JSON.parse(fs.readFileSync(f, 'utf8'))
        const cmds = Object.keys(d.commands || {}).length
        const vulns = (d.confirmed || []).length
        p(`    ${d.target} — ${cmds} cmds, ${vulns} vulns`, C.gray)
      } catch {}
    })
    console.log()
  }

  let target = process.argv.slice(2).join(' ').trim()
  if (!target) target = await ask(C.yellow('  🎯 Target URL: '))
  if (!target) { p('  ❌ No target', C.red); process.exit(1) }
  if (!target.startsWith('http')) target = 'https://' + target

  console.log(C.cyan('\n  📋 Scope:'))
  console.log(C.gray('  [1] Full pentest       (default)'))
  console.log(C.gray('  [2] Recon only'))
  console.log(C.gray('  [3] Web vulns only     (SQLi, XSS, IDOR, SSRF...)'))
  console.log(C.gray('  [4] Specific endpoint'))
  console.log(C.gray('  [5] Custom'))
  const sc = await ask(C.yellow('\n  Choose [1-5] or Enter: ')) || '1'

  let scope = ''
  if      (sc === '1' || sc === '') scope = 'Full penetration test'
  else if (sc === '2')              scope = 'Passive recon only — no active attacks'
  else if (sc === '3')              scope = 'Web vulnerabilities — SQLi, XSS, IDOR, SSRF, LFI, auth bypass'
  else if (sc === '4') { const ep = await ask(C.yellow('  Endpoint: ')); scope = `Focus on endpoint: ${ep}` }
  else if (sc === '5') { scope = await ask(C.yellow('  Describe focus: ')) }
  else scope = 'Full penetration test'

  const hasAuth = await ask(C.yellow('\n  🔑 Login credentials? [y/N]: '))
  let authCtx = ''
  if (hasAuth.toLowerCase() === 'y') {
    const user = await ask(C.yellow('  Username/email: '))
    const pass = await ask(C.yellow('  Password: '))
    authCtx = `AUTH: username="${user}" password="${pass}" — use for authenticated testing`
  }

  const notes = await ask(C.yellow('\n  📝 Notes/exclusions (Enter to skip): '))

  console.log(C.green('\n  ╔══════════════════════════════════╗'))
  console.log(C.green('  ║       MISSION BRIEFING           ║'))
  console.log(C.green('  ╚══════════════════════════════════╝'))
  p(`  Target : ${target}`, C.yellow)
  p(`  Scope  : ${scope}`, C.cyan)
  if (authCtx) p('  Auth   : credentials provided', C.cyan)
  if (notes)   p(`  Notes  : ${notes}`, C.gray)
  console.log()

  const go = await ask(C.bold('  🚀 Start? [Y/n]: '))
  if (go.toLowerCase() === 'n') { p('  Aborted.', C.gray); process.exit(0) }

  agent(target, scope, authCtx, notes)
}

menu()
#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Full Autonomous Mode
 * - يشتغل بدون توقف
 * - المستخدم يكتب في أي وقت لتوجيهه
 * - لا يسأل "هل تواصل" أبداً
 */
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const LOG = `session_${Date.now()}.log`
const C = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  magenta:s => `\x1b[35m${s}\x1b[0m`,
}
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg, c) => { console.log(c?c(msg):msg); w(msg) }

// ── User input — non-blocking ──────────────────────────────────────────────
let userMessage = null
let stopped = false

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const l = line.trim()
  if (!l) return
  const low = l.toLowerCase()
  if (low === 'stop' || low === 'exit' || low === 'quit') {
    stopped = true
    p('\n  🛑 Stopping...', C.red)
    return
  }
  if (low === 'findings') return  // handled in main loop
  // Any other message → inject as user guidance
  userMessage = l
  p(`\n  📨 ${C.bold('USER MESSAGE RECEIVED')} — will inject next step`, C.magenta)
})

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady = false
let lastRotate = Date.now()
const ROTATE_MS = 2 * 60 * 1000

function setupTor() {
  try {
    try { execSync('which tor', {stdio:'ignore'}) }
    catch { execSync('apt-get install -y tor 2>/dev/null', {stdio:'ignore'}) }
    try {
      const torrc = '/etc/tor/torrc'
      let conf = ''
      try { conf = fs.readFileSync(torrc,'utf8') } catch {}
      if (!conf.includes('ControlPort 9051')) {
        fs.appendFileSync(torrc, '\nControlPort 9051\nCookieAuthentication 0\n')
      }
      execSync('service tor restart 2>/dev/null || systemctl restart tor 2>/dev/null', {stdio:'ignore'})
      execSync('sleep 5', {stdio:'ignore'})
    } catch {}
    const ip = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org 2>/dev/null').toString().trim()
    if (ip && ip.length < 20) { torReady = true; p(`  ✅ Tor ready — Exit IP: ${ip}`, C.green) }
  } catch { p('  ⚠️  Tor unavailable — direct connection', C.yellow) }
}

function rotateIp() {
  try {
    execSync(`echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT' | nc 127.0.0.1 9051 2>/dev/null || true`)
    lastRotate = Date.now()
    const ip = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 8 https://api.ipify.org 2>/dev/null').toString().trim()
    p(`  🔄 New Tor IP: ${ip}`, C.cyan)
  } catch { p('  ⚠️  Rotate failed', C.gray) }
}

// ── Gemini via curl+Tor ────────────────────────────────────────────────────
function parseGemini(text) {
  text = text.replace(")]}'","")
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      for (const item of (Array.isArray(data)?data:[])) {
        if (!Array.isArray(item)||item[0]!=='wrb.fr'||!item[2]) continue
        try {
          const inner = JSON.parse(item[2])
          const chunks = inner?.[4]
          if (!Array.isArray(chunks)) continue
          for (const chunk of chunks) {
            const parts = chunk?.[1]
            if (!Array.isArray(parts)) continue
            const txt = parts.filter(t=>typeof t==='string').join('')
            if (txt.length>best.length) best=txt
          }
        } catch {}
      }
    } catch {}
  }
  return best.trim()
}

async function gemini(prompt) {
  if (Date.now()-lastRotate > ROTATE_MS && torReady) rotateIp()

  const safe = prompt.slice(0, 4000)
  const inner = [[safe,0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  const payload = querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'

  const payloadFile = `/tmp/gpl_${Date.now()}.bin`
  fs.writeFileSync(payloadFile, payload)

  const proxy = torReady ? '--socks5 127.0.0.1:9050' : ''

  for (let i=0; i<4; i++) {
    try {
      const raw = execSync(
        `curl -s ${proxy} --max-time 45 -X POST ` +
        `'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' ` +
        `-H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' ` +
        `-H 'x-same-domain: 1' ` +
        `-H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' ` +
        `-H 'accept: */*' ` +
        `--data-binary @${payloadFile}`,
        {maxBuffer:5*1024*1024, timeout:50000}
      ).toString()

      try { fs.unlinkSync(payloadFile) } catch {}

      if (raw.includes('302 Moved') || raw.includes('sorry') || raw.length < 100) {
        p(`  🔄 IP blocked — rotating (attempt ${i+1})`, C.yellow)
        if (torReady) { rotateIp(); await sleep(4000) }
        continue
      }

      const result = parseGemini(raw)
      if (result) return result

    } catch(e) {
      p(`  ⚠️  curl retry ${i+1}: ${e.message.slice(0,50)}`, C.gray)
      if (torReady && i===1) { rotateIp(); await sleep(3000) }
      else await sleep(2000)
    }
  }
  try { fs.unlinkSync(payloadFile) } catch {}
  return null
}

function parseJSON(text) {
  if (!text) return null
  for (const pat of [/```json\s*([\s\S]*?)```/,/```\s*(\{[\s\S]*?\})\s*```/,/(\{[\s\S]*\})/]) {
    const m=text.match(pat)
    if(m){try{return JSON.parse(m[1])}catch{}}
  }
  try{return JSON.parse(text)}catch{}
  return null
}

function clean(cmd) {
  if (!cmd) return ''
  return cmd.replace(/\[([^\]]*)\]\(([^)]+)\)/g,'$2').replace(/\[([^\]]+)\]/g,'$1').replace(/`/g,'').trim()
}

function runCmd(rawCmd) {
  const cmd = clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const o = execSync(cmd,{timeout:45000,maxBuffer:5*1024*1024,shell:'/bin/bash',env:{...process.env,TERM:'xterm'}}).toString().trim()
    return {ok:true,output:o||'(no output)',cmd}
  } catch(e) {
    const o=(e.stdout?.toString()||'')+(e.stderr?.toString()||'')
    return {ok:false,output:o.trim()||e.message,cmd}
  }
}

const sleep = ms => new Promise(r=>setTimeout(r,ms))

// ── System prompt — no asking user ────────────────────────────────────────
const SYS = `Red Team AI agent on Kali Linux. AUTONOMOUS MODE — never ask user to continue.
Respond ONLY with JSON:
{"thought":"...","action":"run_command|print|done","command":"bash cmd","message":"info to print","findings":[],"analysis":"..."}

Actions:
- run_command: execute a bash command (plain text, no markdown, plain URLs)
- print: show a message/report to user without stopping
- done: only when task explicitly completed

Rules:
- NEVER use ask_user — you work autonomously
- Fix failed commands yourself
- If blocked/stuck: try alternative approach automatically
- print findings every 5-6 steps as progress update`

async function agent(task) {
  p(`\n${'═'.repeat(60)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — AUTONOMOUS`,C.red)
  p(`  Task: ${task}`,C.yellow)
  p(`  Log:  ${LOG}`,C.gray)
  p(`  ──────────────────────────────────────────`,C.gray)
  p(`  Type anytime: message to guide | 'stop' to halt | 'findings'`,C.gray)
  p(`${'═'.repeat(60)}\n`,C.red)

  p('  🧅 Setting up Tor...', C.cyan)
  setupTor()

  let history=[], findings=[], lastOut='Starting.', lastOk=true
  let failCount=0, step=0

  // findings command
  rl.on('line', line => {
    if (line.trim().toLowerCase()==='findings') {
      p(`\n  🚨 FINDINGS (${findings.length}):`,C.yellow)
      findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
    }
  })

  while (!stopped) {
    step++
    p(`\n${'─'.repeat(48)}`,C.gray)
    p(`  📍 STEP ${step} ${torReady?'🧅':''}`,C.cyan)

    // Check if user sent a message
    let userCtx = ''
    if (userMessage) {
      userCtx = `\nUSER INSTRUCTION: ${userMessage}`
      p(`  📨 Injecting user message: "${userMessage}"`, C.magenta)
      userMessage = null
    }

    const ctx = history.slice(-3).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'msg').slice(0,60)}: ${(h.output||'').slice(0,120)}`
    ).join('\n')

    const prompt = `${SYS}
Task: ${task}
Step: ${step}${userCtx}
Last[${lastOk?'OK':'FAIL'}]: ${lastOut.slice(0,300)}
Recent:\n${ctx||'none'}
Findings: ${findings.slice(-6).join(' | ')||'none'}
JSON:`

    p(`  🤔 Thinking...`,C.gray)
    const raw = await gemini(prompt)

    if (!raw) {
      failCount++
      p(`  ⚠️  No response (${failCount})`,C.yellow)
      if (failCount>=5) {
        p(`  🔄 Auto-reset after 5 failures`,C.yellow)
        history=[]; lastOut='Reset after failures. Continue task.'; failCount=0
      }
      await sleep(3000)
      continue
    }
    failCount=0

    const parsed = parseJSON(raw)
    if (!parsed) {
      p(`  ⚠️  Bad JSON: ${raw.slice(0,80)}`,C.yellow)
      lastOut=raw.slice(0,200)
      continue
    }

    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    if(parsed.action==='run_command') {
      if(!parsed.command){p('  ⚠️  no command',C.yellow);continue}
      const res=runCmd(parsed.command)
      lastOut=res.output; lastOk=res.ok
      p(`\n  📤 OUTPUT:`)
      p(res.output.slice(0,600).split('\n').map(l=>`     ${l}`).join('\n'),res.ok?C.cyan:C.red)
      if(res.output.length>600) p(`     ...+${res.output.length-600} chars`,C.gray)
      history.push({step,cmd:res.cmd,output:res.output,ok:res.ok})

    } else if(parsed.action==='print') {
      // Just print — no stopping
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 AGENT REPORT — Step ${step}`,C.bold)
      p(parsed.message||'')
      p(`${'━'.repeat(52)}`,C.yellow)
      lastOut=`Printed report at step ${step}`; lastOk=true
      history.push({step,cmd:null,output:parsed.message||'',ok:true})

    } else if(parsed.action==='done') {
      p(`\n${'═'.repeat(60)}`,C.green)
      p(`  ✅ TASK COMPLETE`,C.green)
      if(parsed.message) p(parsed.message)
      stopped=true
    }

    if(parsed.findings?.length) {
      for(const f of parsed.findings) {
        if(!findings.includes(f)){
          findings.push(f)
          p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`)
        }
      }
    }

    await sleep(1200)
  }

  p(`\n${'═'.repeat(60)}`,C.red)
  p(`  📋 FINAL SUMMARY — ${step} steps | ${findings.length} findings`,C.bold)
  findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
  p(`  📁 Log: ${LOG}\n`,C.gray)
  fs.writeFileSync(LOG.replace('.log','_report.json'),JSON.stringify({task,steps:step,findings,history},null,2))
  rl.close(); process.exit(0)
}

const task=process.argv.slice(2).join(' ')
if(!task){
  process.stdout.write(C.red('\n🔴 Target/task: '))
  rl.once('line', t => agent(t.trim()))
} else agent(task)

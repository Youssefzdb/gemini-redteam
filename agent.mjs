#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Smart Autonomous Pentest Agent
 * يثبت الأدوات التي يحتاجها تلقائياً
 * 5 phases: Recon → Scan → Vuln Hunt → Confirm → Report
 */
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const LOG   = `pentest_${Date.now()}.log`
const RFILE = `pentest_${Date.now()}_report.md`
const sleep = ms => new Promise(r=>setTimeout(r,ms))

const C = {
  red:    s=>`\x1b[31m${s}\x1b[0m`,
  green:  s=>`\x1b[32m${s}\x1b[0m`,
  yellow: s=>`\x1b[33m${s}\x1b[0m`,
  cyan:   s=>`\x1b[36m${s}\x1b[0m`,
  bold:   s=>`\x1b[1m${s}\x1b[0m`,
  gray:   s=>`\x1b[90m${s}\x1b[0m`,
  magenta:s=>`\x1b[35m${s}\x1b[0m`,
  blue:   s=>`\x1b[34m${s}\x1b[0m`,
}
const w   = msg => fs.appendFileSync(LOG, msg+'\n')
const p   = (msg,c) => { console.log(c?c(msg):msg); w(msg) }

// ── Non-blocking user input ────────────────────────────────────────────────
let userMessage = null
let stopped     = false
const rl = readline.createInterface({input:process.stdin})
rl.on('line', line => {
  const l = line.trim()
  if(!l) return
  const low = l.toLowerCase()
  if(low==='stop'||low==='exit'){ stopped=true; p('\n  🛑 Stopping...',C.red); return }
  if(low==='findings'||low==='vulns') return
  userMessage = l
  p(`\n  📨 ${C.bold('USER →')} "${l}"`,C.magenta)
})

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady  = false
let lastRotate = Date.now()
const ROTATE_MS = 2*60*1000

function setupTor() {
  try {
    try { execSync('which tor',{stdio:'ignore'}) }
    catch { execSync('apt-get install -y tor netcat-openbsd -qq 2>/dev/null',{stdio:'ignore'}) }
    try {
      const rc='/etc/tor/torrc'; let c=''; try{c=fs.readFileSync(rc,'utf8')}catch{}
      if(!c.includes('ControlPort 9051')) fs.appendFileSync(rc,'\nControlPort 9051\nCookieAuthentication 0\n')
      execSync('service tor restart 2>/dev/null||systemctl restart tor 2>/dev/null',{stdio:'ignore'})
      execSync('sleep 6',{stdio:'ignore'})
    } catch {}
    const ip=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org 2>/dev/null').toString().trim()
    if(ip&&ip.length<20){ torReady=true; p(`  ✅ Tor — IP: ${ip}`,C.green) }
    else p('  ⚠️  Tor unavailable — direct',C.yellow)
  } catch { p('  ⚠️  Tor failed',C.yellow) }
}

function rotateIp() {
  try {
    execSync(`printf 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n' | nc -q1 127.0.0.1 9051 2>/dev/null||true`)
    lastRotate=Date.now()
    const ip=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 8 https://api.ipify.org 2>/dev/null').toString().trim()
    p(`  🔄 New IP: ${ip}`,C.cyan)
  } catch {}
}

// ── Gemini ─────────────────────────────────────────────────────────────────
function parseGemini(text) {
  text=text.replace(")]}'","")
  let best=''
  for(const line of text.split('\n')) {
    if(!line.includes('wrb.fr')) continue
    try {
      const data=JSON.parse(line)
      for(const item of (Array.isArray(data)?data:[])) {
        if(!Array.isArray(item)||item[0]!=='wrb.fr'||!item[2]) continue
        try {
          const inner=JSON.parse(item[2])
          const chunks=inner?.[4]
          if(!Array.isArray(chunks)) continue
          for(const chunk of chunks) {
            const parts=chunk?.[1]
            if(!Array.isArray(parts)) continue
            const txt=parts.filter(t=>typeof t==='string').join('')
            if(txt.length>best.length) best=txt
          }
        } catch {}
      }
    } catch {}
  }
  return best.trim()
}

async function gemini(prompt) {
  if(Date.now()-lastRotate>ROTATE_MS&&torReady) rotateIp()
  const safe=prompt.slice(0,4000)
  const inner=[[safe,0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  const payload=querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'
  const pf=`/tmp/gpl_${Date.now()}.bin`
  fs.writeFileSync(pf,payload)
  const proxy=torReady?'--socks5 127.0.0.1:9050':''
  for(let i=0;i<4;i++) {
    try {
      const raw=execSync(
        `curl -s ${proxy} --max-time 45 -X POST `+
        `'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' `+
        `-H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' `+
        `-H 'x-same-domain: 1' `+
        `-H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' `+
        `-H 'accept: */*' `+
        `--data-binary @${pf}`,
        {maxBuffer:5*1024*1024,timeout:50000}
      ).toString()
      try{fs.unlinkSync(pf)}catch{}
      if(raw.includes('302 Moved')||raw.includes('sorry')||raw.length<100){
        p(`  🔄 IP blocked — rotating`,C.yellow)
        if(torReady){rotateIp();await sleep(4000)}
        continue
      }
      const r=parseGemini(raw)
      if(r) return r
    } catch(e) {
      p(`  ⚠️  retry ${i+1}: ${e.message.slice(0,50)}`,C.gray)
      if(torReady&&i===1){rotateIp();await sleep(3000)}
      else await sleep(2000)
    }
  }
  try{fs.unlinkSync(pf)}catch{}
  return null
}

function parseJSON(text) {
  if(!text) return null
  for(const pat of [/```json\s*([\s\S]*?)```/,/```\s*(\{[\s\S]*?\})\s*```/,/(\{[\s\S]*\})/]) {
    const m=text.match(pat)
    if(m){try{return JSON.parse(m[1])}catch{}}
  }
  try{return JSON.parse(text)}catch{}
  return null
}

function clean(cmd) {
  if(!cmd) return ''
  return cmd
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g,'$2')
    .replace(/\[([^\]]+)\]/g,'$1')
    .replace(/`/g,'').trim()
}

function runCmd(rawCmd) {
  const cmd=clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const o=execSync(cmd,{
      timeout:90000,
      maxBuffer:10*1024*1024,
      shell:'/bin/bash',
      env:{...process.env,TERM:'xterm',DEBIAN_FRONTEND:'noninteractive',PATH:process.env.PATH+':/root/go/bin:/usr/local/go/bin'}
    }).toString().trim()
    return {ok:true,output:o||'(no output)',cmd}
  } catch(e) {
    const o=(e.stdout?.toString()||'')+(e.stderr?.toString()||'')
    return {ok:false,output:o.trim()||e.message,cmd}
  }
}

// ── System prompt ──────────────────────────────────────────────────────────
function buildPrompt(phase, target, step, lastOut, lastOk, ctx, findings, userCtx) {
  return `You are an elite autonomous Red Team AI agent running on Kali Linux.
You perform a full professional penetration test in 5 phases.

CURRENT PHASE: ${phase} / 5
TARGET: ${target}
STEP: ${step}${userCtx}

CRITICAL RULES:
- Respond ONLY with valid JSON — nothing else
- NEVER stop to ask the user anything
- If a tool is missing: install it yourself with apt-get or pip3 or go install
- Fix any failed command automatically with a better approach
- Use plain bash commands — NO markdown, NO brackets around URLs
- Move to next phase when current phase objectives are complete
- After phase 5 write the final report

PHASES:
1-RECON: Gather all info about target — DNS, WHOIS, HTTP headers, tech stack, WAF, subdomains, certificates, robots.txt, sitemap
2-SCAN: Deep scan — all ports, directories/files bruteforce, JS file analysis, API endpoints, hidden params, error pages
3-VULN-HUNT: Systematically test — SQLi, XSS, IDOR, SSRF, LFI, open redirect, misconfig, exposed secrets, weak auth, CORS
4-CONFIRM: For each finding run a precise PoC to confirm it is real. Eliminate false positives. Rate: CRITICAL/HIGH/MEDIUM/LOW
5-REPORT: Write complete markdown pentest report to file ${RFILE}

JSON FORMAT:
{
  "thought": "what I am thinking",
  "phase": <1-5>,
  "action": "run_command" | "print" | "next_phase" | "done",
  "command": "exact bash command to run",
  "message": "text to display to user (for print/report)",
  "findings": ["finding description SEVERITY"],
  "analysis": "analysis of last output"
}

LAST COMMAND [${lastOk?'SUCCESS':'FAILED'}]:
${lastOut.slice(0,400)}

RECENT HISTORY:
${ctx||'none'}

ALL FINDINGS SO FAR:
${findings.length?findings.slice(-10).join('\n'):'none yet'}

Respond with JSON:`
}

// ── Main ───────────────────────────────────────────────────────────────────
async function agent(target) {
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — SMART AUTONOMOUS PENTEST`,C.red)
  p(`  Target  : ${target}`,C.yellow)
  p(`  Log     : ${LOG}`,C.gray)
  p(`  Report  : ${RFILE}`,C.gray)
  p(`  Controls: type anything to guide | 'findings' | 'stop'`,C.gray)
  p(`${'═'.repeat(62)}\n`,C.red)

  p('  🧅 Starting Tor...',C.cyan)
  setupTor()

  const phaseNames = {
    1:'🔍 RECON', 2:'📡 SCAN', 3:'🎯 VULN HUNT', 4:'💥 CONFIRM', 5:'📝 REPORT'
  }

  let phase    = 1
  let history  = []
  let findings = []
  let lastOut  = `Starting pentest on ${target}`
  let lastOk   = true
  let failCount= 0
  let step     = 0
  let phaseStep= 0

  // findings command
  rl.on('line', line => {
    if(line.trim().toLowerCase()==='findings') {
      p(`\n  🚨 FINDINGS (${findings.length}):`,C.yellow)
      findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
    }
  })

  // Print phase banner
  const showPhase = (ph) => {
    p(`\n${'▓'.repeat(62)}`,C.blue)
    p(`  ${phaseNames[ph]} — Phase ${ph}/5`,C.bold)
    p(`${'▓'.repeat(62)}\n`,C.blue)
  }

  showPhase(phase)

  while(!stopped && phase<=5) {
    step++; phaseStep++
    p(`\n${'─'.repeat(48)}`,C.gray)
    p(`  📍 Step ${step} | ${phaseNames[phase]} ${torReady?'🧅':''}`,C.cyan)

    let userCtx=''
    if(userMessage){ userCtx=`\nUSER INSTRUCTION: ${userMessage}`; userMessage=null }

    const ctx=history.slice(-4).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'').slice(0,70)}: ${(h.output||'').slice(0,150)}`
    ).join('\n')

    const prompt=buildPrompt(phase,target,step,lastOut,lastOk,ctx,findings,userCtx)

    p(`  🤔 Thinking...`,C.gray)
    const raw=await gemini(prompt)

    if(!raw){
      failCount++
      p(`  ⚠️  No response (${failCount})`,C.yellow)
      if(failCount>=5){ history=[]; lastOut=`Reset. Continuing phase ${phase}.`; failCount=0 }
      await sleep(3000); continue
    }
    failCount=0

    const parsed=parseJSON(raw)
    if(!parsed){ p(`  ⚠️  Bad JSON: ${raw.slice(0,100)}`,C.yellow); lastOut=raw.slice(0,300); continue }

    // Show thinking
    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    // Collect findings
    if(parsed.findings?.length) {
      for(const f of parsed.findings) {
        if(!findings.includes(f)){
          findings.push(f)
          p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`)
        }
      }
    }

    // Handle action
    if(parsed.action==='run_command') {
      if(!parsed.command){ p('  ⚠️  no command',C.yellow); continue }
      const res=runCmd(parsed.command)
      lastOut=res.output; lastOk=res.ok
      const preview=res.output.slice(0,700)
      p(`\n  📤 OUTPUT:`)
      p(preview.split('\n').map(l=>`     ${l}`).join('\n'), res.ok?C.cyan:C.red)
      if(res.output.length>700) p(`     ...+${res.output.length-700} chars`,C.gray)
      history.push({step,cmd:res.cmd,output:res.output.slice(0,300),ok:res.ok})

    } else if(parsed.action==='print') {
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 ${phaseNames[phase]} Update — Step ${step}`,C.bold)
      p(parsed.message||'')
      p(`${'━'.repeat(52)}`,C.yellow)
      lastOut=`Printed at step ${step}`; lastOk=true

    } else if(parsed.action==='next_phase'||parsed.phase===phase+1) {
      p(`\n  ✅ ${phaseNames[phase]} complete!`,C.green)
      if(parsed.message) p(parsed.message,C.green)
      phase++; phaseStep=0
      if(phase<=5) showPhase(phase)
      lastOut=`Phase ${phase-1} done. Starting ${phaseNames[phase]||'report'}.`; lastOk=true

    } else if(parsed.action==='done') {
      p(`\n  ✅ Pentest complete`,C.green)
      if(parsed.message) p(parsed.message)
      phase=6; stopped=true
    }

    // Auto-advance safety
    if(phaseStep>=25&&phase<5){
      p(`\n  ⏭️  Phase ${phase} max steps — advancing`,C.yellow)
      phase++; phaseStep=0
      if(phase<=5) showPhase(phase)
    }

    await sleep(1200)
  }

  // Final summary
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  📋 PENTEST COMPLETE — ${step} steps | ${findings.length} findings`,C.bold)
  findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
  if(fs.existsSync(RFILE)) p(`\n  📄 Report saved: ${RFILE}`,C.cyan)
  p(`  📁 Log: ${LOG}\n`,C.gray)
  rl.close(); process.exit(0)
}

const target=process.argv.slice(2).join(' ').trim()
if(!target){
  process.stdout.write(C.red('\n🔴 Target URL: '))
  rl.once('line',t=>{ if(t.trim()) agent(t.trim()) })
} else agent(target)

#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Expert Cybersecurity Agent
 * يفكر كـ expert حقيقي، يتوقف فقط عند تأكيد ثغرة
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
  bg_red: s=>`\x1b[41m\x1b[97m${s}\x1b[0m`,
}
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg,c) => { console.log(c?c(msg):msg); w(msg) }

// ── User input — non-blocking + blocking wait ──────────────────────────────
let userMessage  = null
let stopped      = false
let waitingInput = false
let inputResolve = null

const rl = readline.createInterface({input:process.stdin})
rl.on('line', line => {
  const l = line.trim()
  if(!l) return
  const low = l.toLowerCase()

  if(low==='stop'||low==='exit'){ stopped=true; p('\n  🛑 Stopping...',C.red); return }
  if(low==='findings') return

  // إذا الـ agent ينتظر قرار المستخدم
  if(waitingInput && inputResolve){
    inputResolve(l)
    waitingInput=false
    inputResolve=null
    return
  }

  // رسالة توجيه عادية
  userMessage = l
  p(`\n  📨 ${C.bold('USER →')} "${l}"`,C.magenta)
})

// دالة انتظار المستخدم (blocking حتى يجيب)
function waitUser(question) {
  return new Promise(resolve => {
    p(`\n${'▶'.repeat(52)}`,C.yellow)
    p(`  ❓ ${C.bold(question)}`,C.yellow)
    p(`${'▶'.repeat(52)}`,C.yellow)
    process.stdout.write(C.cyan('  > '))
    waitingInput  = true
    inputResolve  = resolve
  })
}

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady   = false
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
      execSync('sleep 5',{stdio:'ignore'})
    } catch {}
    const ip=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org 2>/dev/null').toString().trim()
    if(ip&&ip.length<20){ torReady=true; p(`  ✅ Tor — IP: ${ip}`,C.green) }
    else p('  ⚠️  Tor unavailable — direct connection',C.yellow)
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
  const safe=prompt.slice(0,4500)
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
        `curl -s ${proxy} --max-time 50 -X POST `+
        `'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' `+
        `-H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' `+
        `-H 'x-same-domain: 1' `+
        `-H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' `+
        `-H 'accept: */*' `+
        `--data-binary @${pf}`,
        {maxBuffer:5*1024*1024,timeout:55000}
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
  return cmd.replace(/\[([^\]]*)\]\(([^)]+)\)/g,'$2').replace(/\[([^\]]+)\]/g,'$1').replace(/`/g,'').trim()
}

function runCmd(rawCmd) {
  const cmd=clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const o=execSync(cmd,{
      timeout:90000,maxBuffer:10*1024*1024,shell:'/bin/bash',
      env:{...process.env,TERM:'xterm',DEBIAN_FRONTEND:'noninteractive',
           PATH:process.env.PATH+':/root/go/bin:/usr/local/go/bin:/root/.local/bin'}
    }).toString().trim()
    return {ok:true,output:o||'(no output)',cmd}
  } catch(e) {
    const o=(e.stdout?.toString()||'')+(e.stderr?.toString()||'')
    return {ok:false,output:o.trim()||e.message,cmd}
  }
}

// ── Expert system prompt ───────────────────────────────────────────────────
function buildPrompt(phase, target, step, lastOut, lastOk, ctx, findings, confirmedVulns, userCtx) {
  const phaseDesc = {
    1:`RECON PHASE — You are mapping the target like a senior pentester:
  - HTTP headers, server info, technologies, frameworks
  - DNS records (A, AAAA, MX, TXT, CNAME), WHOIS
  - WAF detection, CDN identification
  - Subdomain enumeration
  - SSL/TLS certificate analysis (SANs, expiry)
  - robots.txt, sitemap.xml, security.txt
  - Google dorking for exposed files
  Install any tool you need with apt-get or pip3 or go install`,

    2:`SCAN PHASE — Deep enumeration like an expert:
  - Full port scan (not just top 1000)
  - Service/version detection on all open ports
  - Directory and file bruteforce (use relevant wordlists)
  - JavaScript file download and secret extraction (API keys, tokens, endpoints)
  - API endpoint discovery and mapping
  - Parameter discovery
  - Backup and config file detection (.env, .git, .bak, config.php etc)
  - Error page analysis for stack traces/info disclosure
  Install any tool you need`,

    3:`VULN HUNT PHASE — Systematic vulnerability testing:
  - SQL Injection (GET/POST params, headers, cookies)
  - XSS (reflected, stored, DOM)
  - IDOR / Broken Object Level Authorization
  - SSRF (internal network, cloud metadata)
  - LFI / Path traversal
  - Open redirect
  - CORS misconfiguration
  - Authentication bypass
  - JWT vulnerabilities (alg:none, weak secret)
  - Exposed admin panels
  - Sensitive data in responses
  - Rate limiting absence
  - Mass assignment
  Think like an attacker — be creative and thorough`,

    4:`CONFIRMATION PHASE — Verify each potential finding with precision:
  - Run exact PoC for each potential vulnerability
  - Capture proof: response code, response body snippet, headers
  - Eliminate false positives
  - Rate each confirmed finding: CRITICAL / HIGH / MEDIUM / LOW
  - Document exact reproduction steps
  IMPORTANT: When you CONFIRM a real vulnerability, set confirmed_vuln=true in your response`,

    5:`REPORT PHASE — Write a professional penetration test report:
  - Save to file: ${RFILE}
  - Executive summary
  - Findings table with severity
  - Detailed findings with evidence and reproduction steps
  - Remediation recommendations
  - Use markdown format`
  }

  return `You are an expert penetration tester and red team operator with 10+ years of experience.
You think and act like a senior offensive security professional — methodical, creative, thorough.

TARGET: ${target}
CURRENT PHASE: ${phase}/5 — ${['','RECON','SCAN','VULN HUNT','CONFIRMATION','REPORT'][phase]}
STEP: ${step}${userCtx}

${phaseDesc[phase]}

RESPONSE FORMAT — JSON only, no other text:
{
  "thought": "expert reasoning about what to do next and why",
  "action": "run_command | print | next_phase | done",
  "command": "exact bash command — plain text, no markdown formatting, plain URLs",
  "message": "text for user (progress update or report)",
  "findings": ["finding with severity: CRITICAL/HIGH/MEDIUM/LOW"],
  "analysis": "technical analysis of last output",
  "confirmed_vuln": false,
  "vuln_details": {
    "name": "vulnerability name",
    "severity": "CRITICAL/HIGH/MEDIUM/LOW",
    "evidence": "exact proof from response",
    "impact": "what attacker can do",
    "reproduce": "exact steps to reproduce"
  }
}

AUTONOMOUS RULES:
- Never ask user anything EXCEPT when confirmed_vuln=true (handled externally)
- If tool missing: install it first, then use it
- If command fails: analyze why and try smarter approach
- Think like an expert — don't just run scripts blindly, understand what you find
- Move to next_phase when current phase is thoroughly complete
- Max 20 steps per phase then auto-advance

LAST COMMAND [${lastOk?'SUCCESS':'FAILED'}]:
${lastOut.slice(0,500)}

RECENT HISTORY:
${ctx||'none'}

CONFIRMED VULNERABILITIES SO FAR:
${confirmedVulns.length?confirmedVulns.map(v=>`- ${v.name} [${v.severity}]: ${v.evidence?.slice(0,80)}`).join('\n'):'none yet'}

ALL FINDINGS:
${findings.length?findings.slice(-8).join('\n'):'none yet'}

JSON response:`
}

// ── Vuln decision UI ───────────────────────────────────────────────────────
async function handleConfirmedVuln(vuln, target) {
  p(`\n${'█'.repeat(62)}`,C.bg_red)
  p(`  💥 CONFIRMED VULNERABILITY`,C.bg_red)
  p(`${'█'.repeat(62)}`,C.bg_red)
  p(`\n  Name    : ${C.bold(vuln.name||'Unknown')}`,C.red)
  p(`  Severity: ${C.bold(vuln.severity||'?')}`,vuln.severity==='CRITICAL'?C.red:C.yellow)
  p(`  Evidence: ${vuln.evidence||'see log'}`,C.cyan)
  p(`  Impact  : ${vuln.impact||'?'}`)
  p(`  Repro   : ${vuln.reproduce||'see log'}\n`)

  const choice = await waitUser(
    'What do you want to do?\n' +
    '  [1] exploit  — attempt full exploitation\n' +
    '  [2] bypass   — use vuln to bypass controls and continue\n' +
    '  [3] document — document only, move on\n' +
    '  [4] skip     — ignore and continue\n' +
    '  or type custom instruction'
  )

  const low = choice.toLowerCase().trim()
  let decision = ''

  if(low==='1'||low==='exploit') {
    decision='EXPLOIT: Attempt full exploitation of this vulnerability. Use all available techniques. Get maximum impact (RCE, data exfil, privilege escalation, etc).'
    p(`  ⚔️  Mode: EXPLOIT`,C.red)
  } else if(low==='2'||low==='bypass') {
    decision='BYPASS: Use this vulnerability as a foothold to bypass security controls and access deeper functionality. Pivot and escalate.'
    p(`  🔓  Mode: BYPASS & PIVOT`,C.yellow)
  } else if(low==='3'||low==='document') {
    decision='DOCUMENT ONLY: Record this finding thoroughly with all evidence, then continue hunting for more vulnerabilities.'
    p(`  📝  Mode: DOCUMENT`,C.cyan)
  } else if(low==='4'||low==='skip') {
    decision='SKIP: Ignore this finding and continue to the next vulnerability.'
    p(`  ⏭️  Mode: SKIP`,C.gray)
  } else {
    decision=`USER CUSTOM: ${choice}`
    p(`  📨  Custom: ${choice}`,C.magenta)
  }

  return decision
}

// ── Main ───────────────────────────────────────────────────────────────────
async function agent(target) {
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — EXPERT AUTONOMOUS PENTESTER`,C.red)
  p(`  Target: ${target}`,C.yellow)
  p(`  Log:    ${LOG}`,C.gray)
  p(`  Report: ${RFILE}`,C.gray)
  p(`  ──────────────────────────────────────────────────`,C.gray)
  p(`  Type anytime to guide | 'findings' | 'stop'`,C.gray)
  p(`${'═'.repeat(62)}\n`,C.red)

  p('  🧅 Starting Tor...',C.cyan)
  setupTor()

  const phaseNames={1:'🔍 RECON',2:'📡 SCAN',3:'🎯 VULN HUNT',4:'💥 CONFIRM',5:'📝 REPORT'}

  let phase          = 1
  let history        = []
  let findings       = []
  let confirmedVulns = []
  let lastOut        = `Starting expert pentest on ${target}`
  let lastOk         = true
  let failCount      = 0
  let step           = 0
  let phaseStep      = 0
  let vulnDecision   = ''

  rl.on('line', line => {
    if(line.trim().toLowerCase()==='findings') {
      p(`\n  🚨 CONFIRMED VULNS (${confirmedVulns.length}):`,C.red)
      confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name}`,C.yellow))
      p(`\n  📋 ALL FINDINGS (${findings.length}):`,C.yellow)
      findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.gray))
    }
  })

  const showPhase = ph => {
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
    if(vulnDecision){ userCtx=`\nVULN DECISION: ${vulnDecision}`; vulnDecision='' }
    if(userMessage){ userCtx+=`\nUSER INSTRUCTION: ${userMessage}`; userMessage=null }

    const ctx=history.slice(-4).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'').slice(0,70)}: ${(h.output||'').slice(0,150)}`
    ).join('\n')

    const prompt=buildPrompt(phase,target,step,lastOut,lastOk,ctx,findings,confirmedVulns,userCtx)

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

    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    // Collect findings
    if(parsed.findings?.length) {
      for(const f of parsed.findings) {
        if(!findings.includes(f)){
          findings.push(f)
          p(`\n  🔎 ${C.yellow('POTENTIAL:')} ${f}`)
        }
      }
    }

    // Handle actions
    if(parsed.action==='run_command') {
      if(!parsed.command){ p('  ⚠️  no command',C.yellow); continue }
      const res=runCmd(parsed.command)
      lastOut=res.output; lastOk=res.ok
      p(`\n  📤 OUTPUT:`)
      p(res.output.slice(0,800).split('\n').map(l=>`     ${l}`).join('\n'),res.ok?C.cyan:C.red)
      if(res.output.length>800) p(`     ...+${res.output.length-800} chars`,C.gray)
      history.push({step,cmd:res.cmd,output:res.output.slice(0,300),ok:res.ok})

    } else if(parsed.action==='print') {
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 ${phaseNames[phase]} — Step ${step}`,C.bold)
      p(parsed.message||'')
      p(`${'━'.repeat(52)}`,C.yellow)
      lastOut=`Report at step ${step}`; lastOk=true

    } else if(parsed.action==='next_phase') {
      p(`\n  ✅ ${phaseNames[phase]} complete!`,C.green)
      if(parsed.message) p(parsed.message,C.green)
      phase++; phaseStep=0
      if(phase<=5) showPhase(phase)
      lastOut=`Phase ${phase-1} done. Starting ${phaseNames[phase]||'report'}.`

    } else if(parsed.action==='done') {
      p(`\n  ✅ Pentest complete`,C.green)
      if(parsed.message) p(parsed.message)
      phase=6
    }

    // ── CONFIRMED VULN → pause and ask user ───────────────────────────────
    if(parsed.confirmed_vuln && parsed.vuln_details?.name) {
      const vd = parsed.vuln_details
      // avoid duplicate
      if(!confirmedVulns.find(v=>v.name===vd.name&&v.evidence===vd.evidence)) {
        confirmedVulns.push(vd)
        const decision = await handleConfirmedVuln(vd, target)
        vulnDecision   = `For vulnerability "${vd.name}": ${decision}`
        lastOut        = `Confirmed vuln: ${vd.name}. User decision: ${decision}`
        lastOk         = true
      }
    }

    if(phaseStep>=20&&phase<5&&phase>0){
      p(`\n  ⏭️  Phase ${phase} max steps — advancing`,C.yellow)
      phase++; phaseStep=0
      if(phase<=5) showPhase(phase)
    }

    await sleep(1200)
  }

  // Final
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  📋 PENTEST COMPLETE`,C.bold)
  p(`  Steps: ${step} | Confirmed vulns: ${confirmedVulns.length} | Findings: ${findings.length}`,C.cyan)
  confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name} — ${v.impact||''}`,C.yellow))
  if(fs.existsSync(RFILE)) p(`\n  📄 Report: ${RFILE}`,C.cyan)
  p(`  📁 Log: ${LOG}\n`,C.gray)
  rl.close(); process.exit(0)
}

const target=process.argv.slice(2).join(' ').trim()
if(!target){
  process.stdout.write(C.red('\n🔴 Target URL: '))
  rl.once('line',t=>{ if(t.trim()) agent(t.trim()) })
} else agent(target)

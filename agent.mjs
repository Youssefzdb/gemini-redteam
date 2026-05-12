#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Expert Cybersecurity Agent
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

// ── Non-blocking user input ────────────────────────────────────────────────
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
  if(waitingInput && inputResolve){
    inputResolve(l); waitingInput=false; inputResolve=null; return
  }
  userMessage = l
  p(`\n  📨 ${C.bold('USER →')} "${l}"`,C.magenta)
})

function waitUser(question) {
  return new Promise(resolve => {
    p(`\n${'▶'.repeat(52)}`,C.yellow)
    p(`  ❓ ${C.bold(question)}`,C.yellow)
    p(`${'▶'.repeat(52)}`,C.yellow)
    process.stdout.write(C.cyan('  > '))
    waitingInput=true; inputResolve=resolve
  })
}

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady   = false
let lastRotate = Date.now()
const ROTATE_MS = 2*60*1000

function setupTor() {
  try {
    try { execSync('which tor',{stdio:'ignore'}) }
    catch {
      // بدون apt-get update
      execSync('apt-get install -y -qq tor netcat-openbsd 2>/dev/null',{stdio:'ignore'})
    }
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

// ── System prompt ──────────────────────────────────────────────────────────
function buildPrompt(phase, target, step, lastOut, lastOk, ctx, findings, confirmedVulns, userCtx) {
  const phaseDesc = {
    1:`RECON — Map the target completely:
  HTTP headers, server/tech detection, WAF/CDN, DNS records, WHOIS,
  SSL cert SANs, subdomains, robots.txt, sitemap, security.txt, Google dorks`,
    2:`SCAN — Deep enumeration:
  All ports (not just top 1000), service versions, directory/file bruteforce,
  JS file analysis for secrets/endpoints, API mapping, backup files (.env .git .bak),
  error pages for stack traces`,
    3:`VULN HUNT — Systematic attack:
  SQLi, XSS (reflected/stored/DOM), IDOR, SSRF, LFI, open redirect,
  CORS misconfig, auth bypass, JWT flaws, exposed admin panels,
  sensitive data leaks, rate limit bypass, mass assignment`,
    4:`CONFIRM — Prove each finding:
  Run precise PoC per vulnerability, capture exact evidence,
  eliminate false positives, rate CRITICAL/HIGH/MEDIUM/LOW`,
    5:`REPORT — Write professional markdown report to ${RFILE}:
  Executive summary, findings table, detailed evidence, remediation`
  }

  return `You are a senior red team operator and penetration tester with deep offensive security expertise.
You think critically, adapt your approach based on what you discover, and pursue vulnerabilities like a real attacker.

TARGET: ${target}
PHASE: ${phase}/5 — ${['','RECON','SCAN','VULN HUNT','CONFIRM','REPORT'][phase]}
STEP: ${step}${userCtx}

PHASE OBJECTIVE:
${phaseDesc[phase]}

STRICT RULES:
1. NEVER run "apt-get update" — EVER. It wastes time. Use "apt-get install -y -qq <tool>" directly.
2. NEVER run "apt-get update && apt-get install" — forbidden.
3. To install tools use ONLY: apt-get install -y -qq <tool>  OR  pip3 install -q <tool>  OR  go install <pkg>@latest
4. Never stop to ask the user — work autonomously
5. Commands must be plain bash — no markdown, plain URLs only
6. If command fails: think why and try a smarter approach
7. Think like an expert — understand results, don't just run scripts blindly
8. When you CONFIRM a real vulnerability set confirmed_vuln=true

JSON RESPONSE FORMAT (nothing else):
{
  "thought": "expert reasoning — what did I learn, what should I do next",
  "action": "run_command | print | next_phase | done",
  "command": "exact bash command — plain text only",
  "message": "progress update for print action",
  "findings": ["description [SEVERITY]"],
  "analysis": "technical analysis of last output",
  "confirmed_vuln": false,
  "vuln_details": {
    "name": "vuln name",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "evidence": "exact proof snippet",
    "impact": "what attacker can achieve",
    "reproduce": "exact reproduction steps"
  }
}

LAST OUTPUT [${lastOk?'SUCCESS':'FAILED'}]:
${lastOut.slice(0,500)}

RECENT HISTORY:
${ctx||'none'}

CONFIRMED VULNS:
${confirmedVulns.length?confirmedVulns.map(v=>`[${v.severity}] ${v.name}: ${v.evidence?.slice(0,80)}`).join('\n'):'none'}

FINDINGS:
${findings.length?findings.slice(-8).join('\n'):'none'}

JSON:`
}

// ── Vuln decision ──────────────────────────────────────────────────────────
async function handleConfirmedVuln(vuln) {
  p(`\n${'█'.repeat(62)}`,C.bg_red)
  p(`  💥 CONFIRMED VULNERABILITY`,C.bg_red)
  p(`${'█'.repeat(62)}`,C.bg_red)
  p(`\n  Name    : ${C.bold(vuln.name||'?')}`,C.red)
  p(`  Severity: ${C.bold(vuln.severity||'?')}`,vuln.severity==='CRITICAL'?C.red:C.yellow)
  p(`  Evidence: ${vuln.evidence||'see log'}`,C.cyan)
  p(`  Impact  : ${vuln.impact||'?'}`)
  p(`  Repro   : ${vuln.reproduce||'see log'}\n`)

  const choice = await waitUser(
    'What do you want to do?\n' +
    '  [1] exploit  — full exploitation attempt\n' +
    '  [2] bypass   — use as foothold, pivot deeper\n' +
    '  [3] document — record and continue hunting\n' +
    '  [4] skip     — ignore and move on\n' +
    '  or type any custom instruction'
  )

  const low=choice.toLowerCase().trim()
  let decision=''
  if(low==='1'||low==='exploit'){
    decision='EXPLOIT: Attempt full exploitation. Use sqlmap/metasploit/custom payloads. Get max impact: RCE, data dump, privilege escalation.'
    p(`  ⚔️  EXPLOIT mode`,C.red)
  } else if(low==='2'||low==='bypass'){
    decision='BYPASS: Use this vuln as foothold. Bypass auth controls, pivot to internal functionality, escalate access.'
    p(`  🔓  BYPASS & PIVOT mode`,C.yellow)
  } else if(low==='3'||low==='document'){
    decision='DOCUMENT: Record this finding with full evidence, then continue discovering more vulnerabilities.'
    p(`  📝  DOCUMENT mode`,C.cyan)
  } else if(low==='4'||low==='skip'){
    decision='SKIP: Ignore this finding and continue.'
    p(`  ⏭️  SKIP`,C.gray)
  } else {
    decision=`CUSTOM INSTRUCTION: ${choice}`
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
  p(`  Type anytime: message | 'findings' | 'stop'`,C.gray)
  p(`${'═'.repeat(62)}\n`,C.red)

  p('  🧅 Starting Tor...',C.cyan)
  setupTor()

  const phaseNames={1:'🔍 RECON',2:'📡 SCAN',3:'🎯 VULN HUNT',4:'💥 CONFIRM',5:'📝 REPORT'}
  const showPhase = ph => {
    p(`\n${'▓'.repeat(62)}`,C.blue)
    p(`  ${phaseNames[ph]} — Phase ${ph}/5`,C.bold)
    p(`${'▓'.repeat(62)}\n`,C.blue)
  }

  let phase=1, history=[], findings=[], confirmedVulns=[]
  let lastOut=`Starting pentest on ${target}`, lastOk=true
  let failCount=0, step=0, phaseStep=0, vulnDecision=''

  rl.on('line', line => {
    if(line.trim().toLowerCase()==='findings') {
      p(`\n  💥 CONFIRMED (${confirmedVulns.length}):`,C.red)
      confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name}`,C.yellow))
      p(`\n  🔎 FINDINGS (${findings.length}):`,C.yellow)
      findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.gray))
    }
  })

  showPhase(phase)

  while(!stopped && phase<=5) {
    step++; phaseStep++
    p(`\n${'─'.repeat(48)}`,C.gray)
    p(`  📍 Step ${step} | ${phaseNames[phase]} ${torReady?'🧅':''}`,C.cyan)

    let userCtx=''
    if(vulnDecision){ userCtx=`\nVULN DECISION: ${vulnDecision}`; vulnDecision='' }
    if(userMessage){ userCtx+=`\nUSER: ${userMessage}`; userMessage=null }

    const ctx=history.slice(-4).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'').slice(0,70)}: ${(h.output||'').slice(0,150)}`
    ).join('\n')

    p(`  🤔 Thinking...`,C.gray)
    const raw=await gemini(buildPrompt(phase,target,step,lastOut,lastOk,ctx,findings,confirmedVulns,userCtx))

    if(!raw){
      failCount++
      p(`  ⚠️  No response (${failCount})`,C.yellow)
      if(failCount>=5){ history=[]; lastOut=`Reset. Phase ${phase} continuing.`; failCount=0 }
      await sleep(3000); continue
    }
    failCount=0

    const parsed=parseJSON(raw)
    if(!parsed){ p(`  ⚠️  Bad JSON: ${raw.slice(0,100)}`,C.yellow); lastOut=raw.slice(0,300); continue }

    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    if(parsed.findings?.length)
      for(const f of parsed.findings)
        if(!findings.includes(f)){ findings.push(f); p(`\n  🔎 ${C.yellow(f)}`) }

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
      p(`\n  ✅ Done`,C.green)
      if(parsed.message) p(parsed.message)
      phase=6
    }

    // ── CONFIRMED VULN → pause & ask ──────────────────────────────────────
    if(parsed.confirmed_vuln && parsed.vuln_details?.name) {
      const vd=parsed.vuln_details
      if(!confirmedVulns.find(v=>v.name===vd.name)) {
        confirmedVulns.push(vd)
        const dec=await handleConfirmedVuln(vd)
        vulnDecision=`For "${vd.name}": ${dec}`
        lastOut=`Confirmed: ${vd.name}. Decision: ${dec}`; lastOk=true
      }
    }

    if(phaseStep>=20&&phase<5){ p(`\n  ⏭️  Max steps — next phase`,C.yellow); phase++; phaseStep=0; if(phase<=5) showPhase(phase) }

    await sleep(1200)
  }

  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  📋 COMPLETE — ${step} steps | ${confirmedVulns.length} vulns | ${findings.length} findings`,C.bold)
  confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name}`,C.yellow))
  if(fs.existsSync(RFILE)) p(`\n  📄 Report: ${RFILE}`,C.cyan)
  p(`  📁 Log: ${LOG}\n`,C.gray)
  rl.close(); process.exit(0)
}

const target=process.argv.slice(2).join(' ').trim()
if(!target){
  process.stdout.write(C.red('\n🔴 Target URL: '))
  rl.once('line',t=>{ if(t.trim()) agent(t.trim()) })
} else agent(target)

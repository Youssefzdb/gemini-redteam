#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Full Pentest Autonomous Agent
 * Runs inside Claude Code CLI via gemini-proxy OR standalone
 * 
 * Phases:
 *   1. Recon       — DNS, headers, tech, subdomains
 *   2. Scan        — ports, dirs, endpoints, JS secrets
 *   3. Vuln Hunt   — SQLi, XSS, IDOR, SSRF, misconfigs
 *   4. Confirm     — PoC for each finding
 *   5. Report      — structured markdown report
 */
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const LOG   = `pentest_${Date.now()}.log`
const RPORT = `pentest_${Date.now()}_report.md`

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
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg,c) => { console.log(c?c(msg):msg); w(msg) }
const sleep = ms => new Promise(r=>setTimeout(r,ms))

// ── User input non-blocking ────────────────────────────────────────────────
let userMessage = null
let stopped = false
const rl = readline.createInterface({input:process.stdin})
rl.on('line', line => {
  const l = line.trim()
  if (!l) return
  const low = l.toLowerCase()
  if (low==='stop'||low==='exit') { stopped=true; p('\n  🛑 Stopping agent...',C.red); return }
  if (low==='findings'||low==='vulns') return
  userMessage = l
  p(`\n  📨 ${C.bold('USER →')} "${l}" — injecting next step`,C.magenta)
})

// ── Tor ────────────────────────────────────────────────────────────────────
let torReady = false
let lastRotate = Date.now()
const ROTATE_MS = 2*60*1000

function setupTor() {
  try {
    try { execSync('which tor',{stdio:'ignore'}) }
    catch { execSync('apt-get install -y tor netcat-openbsd 2>/dev/null',{stdio:'ignore'}) }
    try {
      const torrc='/etc/tor/torrc'
      let conf=''; try{conf=fs.readFileSync(torrc,'utf8')}catch{}
      if(!conf.includes('ControlPort 9051'))
        fs.appendFileSync(torrc,'\nControlPort 9051\nCookieAuthentication 0\n')
      execSync('service tor restart 2>/dev/null || systemctl restart tor 2>/dev/null',{stdio:'ignore'})
      execSync('sleep 6',{stdio:'ignore'})
    } catch {}
    const ip=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org 2>/dev/null').toString().trim()
    if(ip&&ip.length<20){torReady=true;p(`  ✅ Tor — Exit IP: ${ip}`,C.green)}
    else p('  ⚠️  Tor not ready — direct connection',C.yellow)
  } catch { p('  ⚠️  Tor setup failed',C.yellow) }
}

function rotateIp() {
  try {
    execSync(`echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT' | nc 127.0.0.1 9051 2>/dev/null||true`)
    lastRotate=Date.now()
    const ip=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 8 https://api.ipify.org 2>/dev/null').toString().trim()
    p(`  🔄 New Tor IP: ${ip}`,C.cyan)
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
      if(raw.includes('302 Moved')||raw.includes('sorry')||raw.length<100) {
        p(`  🔄 IP blocked — rotating`,C.yellow)
        if(torReady){rotateIp();await sleep(4000)}
        continue
      }
      const result=parseGemini(raw)
      if(result) return result
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
    const o=execSync(cmd,{timeout:60000,maxBuffer:10*1024*1024,shell:'/bin/bash',env:{...process.env,TERM:'xterm'}}).toString().trim()
    return {ok:true,output:o||'(no output)',cmd}
  } catch(e) {
    const o=(e.stdout?.toString()||'')+(e.stderr?.toString()||'')
    return {ok:false,output:o.trim()||e.message,cmd}
  }
}

// ── Install tools ──────────────────────────────────────────────────────────
function installTools() {
  p('\n  📦 Checking tools...', C.cyan)
  const tools = [
    ['nmap',    'nmap'],
    ['curl',    'curl'],
    ['whatweb', 'whatweb'],
    ['ffuf',    'ffuf'],
    ['nikto',   'nikto'],
    ['sqlmap',  'sqlmap'],
    ['nuclei',  'nuclei'],
    ['subfinder','subfinder'],
    ['httpx',   'httpx-toolkit'],
    ['wafw00f', 'wafw00f'],
    ['gau',     'golang-go'],
  ]
  for(const [bin,pkg] of tools) {
    try { execSync(`which ${bin}`,{stdio:'ignore'}); p(`  ✅ ${bin}`,C.gray) }
    catch {
      p(`  📥 Installing ${bin}...`,C.yellow)
      try { execSync(`apt-get install -y ${pkg} 2>/dev/null`,{stdio:'ignore'}) }
      catch { p(`  ⚠️  ${bin} not installed`,C.gray) }
    }
  }
  // nuclei via go if not found
  try { execSync('which nuclei',{stdio:'ignore'}) }
  catch {
    try {
      execSync('go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest 2>/dev/null',{stdio:'ignore',timeout:60000})
      execSync('cp ~/go/bin/nuclei /usr/local/bin/ 2>/dev/null||true',{stdio:'ignore'})
    } catch {}
  }
}

// ── Phases definition ──────────────────────────────────────────────────────
const PHASES = [
  { id:1, name:'🔍 RECON',         emoji:'🔍', desc:'DNS, WHOIS, headers, tech stack, WAF detection, subdomains' },
  { id:2, name:'📡 SCAN',          emoji:'📡', desc:'Port scan, directory bruteforce, JS file analysis, API endpoint discovery' },
  { id:3, name:'🎯 VULN HUNT',     emoji:'🎯', desc:'SQLi, XSS, IDOR, SSRF, open redirect, misconfigs, exposed secrets, LFI' },
  { id:4, name:'💥 CONFIRM',       emoji:'💥', desc:'PoC for each finding, false positive elimination, severity rating' },
  { id:5, name:'📝 REPORT',        emoji:'📝', desc:'Full structured markdown report with evidence and remediation' },
]

// ── System prompts per phase ───────────────────────────────────────────────
function buildSYS(phase, target) {
  const phaseGuide = {
    1: `Run these recon commands:
- curl -sI ${target}
- whois $(echo ${target}|sed 's|https://||;s|/.*||')
- dig +short $(echo ${target}|sed 's|https://||;s|/.*||') A AAAA MX TXT
- whatweb -a 3 ${target}
- wafw00f ${target}
- subfinder -d $(echo ${target}|sed 's|https://||;s|/.*||') -silent 2>/dev/null || echo "subfinder unavailable"`,
    2: `Run these scan commands:
- nmap -sV -sC -T4 --top-ports 1000 $(echo ${target}|sed 's|https://||;s|/.*||')
- ffuf -w /usr/share/wordlists/dirb/common.txt -u ${target}/FUZZ -mc 200,301,302,403 -t 50 -timeout 5
- curl -s ${target} | grep -oE '(src|href)="[^"]*\\.js[^"]*"' | head -20
- curl -s ${target} | grep -oE '/api/[^"\\s]+' | sort -u`,
    3: `Test these vulnerabilities:
- SQLi: curl -s "${target}/search?q=1'" | grep -i error
- XSS: curl -s "${target}/?q=<script>alert(1)</script>" | grep -i script
- IDOR: try /api/users/1 /api/users/2 /api/users/0
- SSRF: curl -s "${target}/fetch?url=http://169.254.169.254/latest/meta-data/"
- Open redirect: curl -sI "${target}/redirect?url=https://evil.com"
- Headers: check missing Security-Headers, CORS misconfig
- JS secrets: curl -s ${target} | grep -iE '(api_key|secret|token|password)=[^&"\\s]+'`,
    4: `For each finding in the list, craft a specific PoC command to CONFIRM it is real (not false positive). Test carefully and record exact evidence (response code, body snippet). Rate each: CRITICAL/HIGH/MEDIUM/LOW`,
    5: `Generate a complete penetration test report in markdown format with: Executive Summary, Findings table, Detailed findings with evidence, Remediation recommendations. Use all findings collected.`
  }
  return `Red Team AI on Kali Linux. AUTONOMOUS — never stop, never ask questions.
Current phase: ${phase.name} — ${phase.desc}
JSON response only:
{"thought":"...","action":"run_command|print|next_phase|done","command":"bash cmd (plain text no markdown)","message":"text to display","findings":[],"analysis":"...","phase_complete":false}

action=next_phase: move to next phase when current is fully done
action=print: display info/progress without stopping
action=done: only after phase 5 report is written

PHASE GUIDE:
${phaseGuide[phase.id]||'Continue systematically'}

Fix errors yourself. Try alternatives if tools missing. Never repeat same failing command.`
}

// ── Report builder ─────────────────────────────────────────────────────────
function buildReport(target, allFindings, phaseHistory) {
  const date = new Date().toISOString().split('T')[0]
  const critical = allFindings.filter(f=>f.includes('CRITICAL')||f.includes('critical'))
  const high     = allFindings.filter(f=>f.includes('HIGH')||f.includes('high'))
  const med      = allFindings.filter(f=>f.includes('MED')||f.includes('medium')||f.includes('Medium'))
  const low      = allFindings.filter(f=>!critical.includes(f)&&!high.includes(f)&&!med.includes(f))

  return `# 🔴 Penetration Test Report
**Target:** ${target}
**Date:** ${date}
**Tool:** Gemini RedTeam Agent

---

## Executive Summary
Automated penetration test performed on ${target} using an autonomous AI-driven red team agent.
Total findings: **${allFindings.length}** (${critical.length} Critical, ${high.length} High, ${med.length} Medium, ${low.length} Low/Info)

---

## Findings Summary

| # | Finding | Severity |
|---|---------|----------|
${allFindings.map((f,i)=>`| ${i+1} | ${f} | ${f.includes('CRITICAL')?'🔴 Critical':f.includes('HIGH')?'🟠 High':f.includes('MED')||f.includes('Medium')?'🟡 Medium':'🔵 Info'} |`).join('\n')}

---

## Detailed Findings

${allFindings.map((f,i)=>`### Finding ${i+1}: ${f}
- **Evidence:** See log file ${LOG}
- **Remediation:** Apply security patch, validate input, update headers as applicable
`).join('\n')}

---

## Phase History
${Object.entries(phaseHistory).map(([ph,cmds])=>`### ${ph}\n${cmds.map(c=>`- \`${c}\``).join('\n')}`).join('\n\n')}

---
*Generated by Gemini RedTeam Agent — ${new Date().toISOString()}*
`
}

// ── Main agent ─────────────────────────────────────────────────────────────
async function agent(target) {
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — FULL PENTEST AUTONOMOUS`,C.red)
  p(`  Target: ${target}`,C.yellow)
  p(`  Phases: Recon → Scan → Vuln Hunt → Confirm → Report`,C.cyan)
  p(`  Log:    ${LOG}`,C.gray)
  p(`  Type anytime: guidance message | 'stop' | 'findings'`,C.gray)
  p(`${'═'.repeat(62)}\n`,C.red)

  installTools()

  p('\n  🧅 Setting up Tor...', C.cyan)
  setupTor()

  let allFindings  = []
  let phaseHistory = {}
  let history      = []
  let lastOut      = `Target: ${target}. Starting recon.`
  let lastOk       = true
  let failCount    = 0
  let step         = 0
  let phaseIdx     = 0

  rl.on('line', line => {
    const l=line.trim().toLowerCase()
    if(l==='findings'||l==='vulns') {
      p(`\n  🚨 FINDINGS (${allFindings.length}):`,C.yellow)
      allFindings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
    }
  })

  while(!stopped && phaseIdx < PHASES.length) {
    const phase = PHASES[phaseIdx]
    if(!phaseHistory[phase.name]) phaseHistory[phase.name]=[]

    p(`\n${'▓'.repeat(62)}`,C.blue)
    p(`  ${phase.emoji} PHASE ${phase.id}/5: ${phase.name}`,C.bold)
    p(`  ${phase.desc}`,C.gray)
    p(`${'▓'.repeat(62)}\n`,C.blue)

    let phaseSteps = 0
    let phaseDone  = false

    while(!stopped && !phaseDone) {
      step++; phaseSteps++
      p(`\n${'─'.repeat(48)}`,C.gray)
      p(`  📍 Step ${step} | Phase ${phase.id}/5 | ${phase.emoji} ${phase.name.split(' ')[1]}`,C.cyan)

      // Inject user message if any
      let userCtx=''
      if(userMessage) {
        userCtx=`\nUSER INSTRUCTION: ${userMessage}`
        p(`  📨 User: "${userMessage}"`,C.magenta)
        userMessage=null
      }

      const ctx=history.slice(-3).map(h=>
        `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'').slice(0,60)}: ${(h.output||'').slice(0,120)}`
      ).join('\n')

      const prompt=`${buildSYS(phase,target)}

Target: ${target}
Phase: ${phase.id}/5 — ${phase.name}
Phase steps so far: ${phaseSteps}${userCtx}
Last[${lastOk?'OK':'FAIL'}]: ${lastOut.slice(0,300)}
Recent:\n${ctx||'none'}
All findings so far: ${allFindings.slice(-8).join(' | ')||'none'}
JSON:`

      p(`  🤔 Thinking...`,C.gray)
      const raw=await gemini(prompt)

      if(!raw) {
        failCount++
        p(`  ⚠️  No response (${failCount})`,C.yellow)
        if(failCount>=5){
          p(`  🔄 Auto-reset`,C.yellow)
          history=[]; lastOut=`Reset. Phase ${phase.id} continuing.`; failCount=0
        }
        await sleep(3000); continue
      }
      failCount=0

      const parsed=parseJSON(raw)
      if(!parsed){p(`  ⚠️  Bad JSON: ${raw.slice(0,80)}`,C.yellow);lastOut=raw.slice(0,200);continue}

      if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
      if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

      if(parsed.action==='run_command') {
        if(!parsed.command){p('  ⚠️  no command',C.yellow);continue}
        const res=runCmd(parsed.command)
        lastOut=res.output; lastOk=res.ok
        p(`\n  📤 OUTPUT:`)
        p(res.output.slice(0,700).split('\n').map(l=>`     ${l}`).join('\n'),res.ok?C.cyan:C.red)
        if(res.output.length>700) p(`     ...+${res.output.length-700} chars`,C.gray)
        history.push({step,cmd:res.cmd,output:res.output,ok:res.ok})
        phaseHistory[phase.name].push(res.cmd)

      } else if(parsed.action==='print') {
        p(`\n${'━'.repeat(52)}`,C.yellow)
        p(`  📊 ${phase.emoji} Progress — Step ${step}`,C.bold)
        p(parsed.message||'')
        p(`${'━'.repeat(52)}`,C.yellow)
        lastOut=`Progress update at step ${step}`; lastOk=true

      } else if(parsed.action==='next_phase'||parsed.phase_complete) {
        p(`\n  ✅ Phase ${phase.id} complete!`,C.green)
        if(parsed.message) p(parsed.message,C.green)
        phaseDone=true; phaseIdx++

      } else if(parsed.action==='done') {
        p(`\n  ✅ Agent done`,C.green)
        if(parsed.message) p(parsed.message)
        phaseDone=true; phaseIdx=PHASES.length
      }

      // Collect findings
      if(parsed.findings?.length) {
        for(const f of parsed.findings) {
          if(!allFindings.includes(f)){
            allFindings.push(f)
            p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`)
          }
        }
      }

      // Auto-advance phase after too many steps (safety)
      if(phaseSteps>=20&&!phaseDone) {
        p(`\n  ⏭️  Phase ${phase.id} max steps — moving to next phase`,C.yellow)
        phaseDone=true; phaseIdx++
      }

      await sleep(1200)
    }
  }

  // Write final report
  if(!stopped) {
    const report=buildReport(target,allFindings,phaseHistory)
    fs.writeFileSync(RPORT,report)
    p(`\n${'═'.repeat(62)}`,C.green)
    p(`  ✅ PENTEST COMPLETE`,C.green)
    p(`  🚨 Total findings: ${allFindings.length}`,C.yellow)
    allFindings.forEach((f,i)=>p(`    ${i+1}. ${f}`,C.yellow))
    p(`\n  📄 Report: ${RPORT}`,C.cyan)
    p(`  📁 Log:    ${LOG}`,C.gray)
    p(`${'═'.repeat(62)}\n`,C.green)
  }

  rl.close(); process.exit(0)
}

const target=process.argv.slice(2).join(' ')
if(!target) {
  process.stdout.write(C.red('\n🔴 Target URL: '))
  rl.once('line',t=>agent(t.trim()))
} else agent(target)

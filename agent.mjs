#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam — Free Expert Agent
 * - لا phases، لا max steps
 * - يشتغل بحرية كـ expert حقيقي
 * - يتوقف فقط عند تأكيد ثغرة → يسأل المستخدم
 * - إذا اختار exploit → يبقى في exploit mode حتى يستغلها كاملاً
 */
import querystring from 'node:querystring'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const LOG   = `pentest_${Date.now()}.log`
const RFILE = `pentest_${Date.now()}_report.md`
const sleep = ms => new Promise(r=>setTimeout(r,ms))

// ── Session DB — يحفظ كل أمر ونتيجته ──────────────────────────────────────
class SessionDB {
  constructor(target) {
    const host = target.replace(/https?:\/\//,'').replace(/[^a-zA-Z0-9]/g,'_').slice(0,40)
    this.file = `db_${host}.json`
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file,'utf8'))
      : { target, created: new Date().toISOString(), commands: {}, findings: [], confirmed: [] }
    if(fs.existsSync(this.file))
      p(`  📂 Loaded existing DB: ${this.file} (${Object.keys(this.data.commands).length} commands)`, C.cyan)
  }

  // تحقق هل نفّذنا هذا الأمر من قبل
  has(cmd) {
    const key = cmd.trim().slice(0,120)
    return !!this.data.commands[key]
  }

  // احفظ الأمر ونتيجته
  save(cmd, output, ok) {
    const key = cmd.trim().slice(0,120)
    this.data.commands[key] = { ok, output: output.slice(0,500), ts: Date.now() }
    this._flush()
  }

  // احفظ finding
  addFinding(f) {
    if(!this.data.findings.includes(f)){ this.data.findings.push(f); this._flush() }
  }

  // احفظ confirmed vuln
  addConfirmed(v) {
    if(!this.data.confirmed.find(x=>x.name===v.name)){ this.data.confirmed.push(v); this._flush() }
  }

  // ملخص للـ prompt — آخر الأوامر وما تم اختباره
  summary() {
    const cmds = Object.entries(this.data.commands)
    const last10 = cmds.slice(-10).map(([cmd,r])=>`[${r.ok?'OK':'FAIL'}] ${cmd}: ${r.output.slice(0,80)}`).join('\n')
    const allCmds = cmds.map(([cmd])=>cmd).join('\n')
    return { last10, allCmds, total: cmds.length }
  }

  _flush() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}

const C = {
  red:    s=>`\x1b[31m${s}\x1b[0m`,
  green:  s=>`\x1b[32m${s}\x1b[0m`,
  yellow: s=>`\x1b[33m${s}\x1b[0m`,
  cyan:   s=>`\x1b[36m${s}\x1b[0m`,
  bold:   s=>`\x1b[1m${s}\x1b[0m`,
  gray:   s=>`\x1b[90m${s}\x1b[0m`,
  magenta:s=>`\x1b[35m${s}\x1b[0m`,
  bg_red: s=>`\x1b[41m\x1b[97m${s}\x1b[0m`,
  bg_grn: s=>`\x1b[42m\x1b[97m${s}\x1b[0m`,
}
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg,c) => { console.log(c?c(msg):msg); w(msg) }

// ── User input ─────────────────────────────────────────────────────────────
let userMessage  = null
let stopped      = false
let waitingInput = false
let inputResolve = null

const rl = readline.createInterface({input:process.stdin})
rl.on('line', line => {
  const l = line.trim()
  if(!l) return
  if(l.toLowerCase()==='stop'||l.toLowerCase()==='exit'){
    stopped=true; p('\n  🛑 Stopping...',C.red); return
  }
  if(l.toLowerCase()==='findings') return
  if(waitingInput && inputResolve){
    inputResolve(l); waitingInput=false; inputResolve=null; return
  }
  userMessage=l
  p(`\n  📨 ${C.bold('USER →')} "${l}"`,C.magenta)
})

function waitUser(question) {
  return new Promise(resolve => {
    p(`\n${'▶'.repeat(54)}`,C.yellow)
    p(`  ❓ ${C.bold(question)}`,C.yellow)
    p(`${'▶'.repeat(54)}`,C.yellow)
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
    catch { execSync('apt-get install -y -qq tor netcat-openbsd 2>/dev/null',{stdio:'ignore'}) }
    try {
      const rc='/etc/tor/torrc'; let c=''
      try{c=fs.readFileSync(rc,'utf8')}catch{}
      if(!c.includes('ControlPort 9051'))
        fs.appendFileSync(rc,'\nControlPort 9051\nCookieAuthentication 0\n')
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
    let prevIp=''
    try{prevIp=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 5 https://api.ipify.org 2>/dev/null').toString().trim()}catch{}
    try{execSync(`printf 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n' | nc -q1 127.0.0.1 9051 2>/dev/null||true`)}catch{}
    let newIp=prevIp
    for(let i=0;i<5;i++){
      execSync('sleep 3')
      try{newIp=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 5 https://api.ipify.org 2>/dev/null').toString().trim()}catch{}
      if(newIp&&newIp!==prevIp) break
    }
    if(!newIp||newIp===prevIp){
      p(`  🔁 IP stuck — restarting tor...`,C.yellow)
      try{
        execSync('service tor restart 2>/dev/null||systemctl restart tor 2>/dev/null',{stdio:'ignore'})
        execSync('sleep 8')
        newIp=execSync('curl -s --socks5 127.0.0.1:9050 --max-time 8 https://api.ipify.org 2>/dev/null').toString().trim()
      }catch{}
    }
    lastRotate=Date.now()
    p(`  🔄 ${prevIp||'?'} → ${newIp||'?'}`,C.cyan)
  } catch(e){ p(`  ⚠️  rotate: ${e.message.slice(0,40)}`,C.gray) }
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
            const txt=(chunk?.[1]||[]).filter(t=>typeof t==='string').join('')
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
  const inner=[[prompt.slice(0,4500),0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  const payload=querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'

  for(let i=0;i<4;i++){
    const proxy=torReady?'--socks5 127.0.0.1:9050':''
    const pf=`/tmp/gpl_${Date.now()}_${i}.bin`
    try {
      fs.writeFileSync(pf,payload,'utf8')
      const raw=execSync(
        `curl -s ${proxy} --max-time 50 -X POST `+
        `'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' `+
        `-H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' `+
        `-H 'x-same-domain: 1' `+
        `-H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' `+
        `-H 'accept: */*' --data-binary @${pf}`,
        {maxBuffer:5*1024*1024,timeout:55000}
      ).toString()
      try{fs.unlinkSync(pf)}catch{}
      if(raw.includes('302 Moved')||raw.includes('sorry')||raw.length<100){
        p(`  🔄 IP blocked — rotating`,C.yellow)
        if(torReady){rotateIp();await sleep(5000)}
        else await sleep(2000)
        continue
      }
      const r=parseGemini(raw)
      if(r) return r
      await sleep(2000)
    } catch(e) {
      try{fs.unlinkSync(pf)}catch{}
      p(`  ⚠️  retry ${i+1}: ${e.message.slice(0,60)}`,C.gray)
      if(i===1&&torReady){rotateIp();await sleep(4000)}
      else await sleep(2000)
    }
  }
  return null
}

function parseJSON(text) {
  if(!text) return null
  for(const pat of [/```json\s*([\s\S]*?)```/,/(\{[\s\S]*\})/]) {
    const m=text.match(pat)
    if(m){try{return JSON.parse(m[1])}catch{}}
  }
  try{return JSON.parse(text)}catch{}
  return null
}

function clean(cmd) {
  return (cmd||'')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g,'$2')
    .replace(/\[([^\]]+)\]/g,'$1')
    .replace(/`/g,'').trim()
}


// ── تحقق من الأداة قبل التثبيت ────────────────────────────────────────────
function toolExists(tool) {
  try { execSync(`which ${tool} 2>/dev/null || ${tool} --version 2>/dev/null`, {stdio:'pipe', timeout:5000}); return true }
  catch { return false }
}

function ensureTool(tool, installCmd) {
  if(toolExists(tool)) {
    p(`  ✅ ${tool} already installed`,C.gray)
    return true
  }
  p(`  📦 Installing ${tool}...`,C.yellow)
  try {
    execSync(installCmd, {
      stdio:'pipe', timeout:60000, shell:'/bin/bash',
      env:{...process.env, DEBIAN_FRONTEND:'noninteractive',
           PATH:process.env.PATH+':/root/go/bin:/usr/local/go/bin:/root/.local/bin'}
    })
    p(`  ✅ ${tool} installed`,C.green)
    return true
  } catch(e) {
    p(`  ⚠️  Failed to install ${tool}: ${e.message.slice(0,60)}`,C.red)
    return false
  }
}

function runCmd(rawCmd) {
  const cmd=clean(rawCmd)
  p(`\n  ⚡ ${C.bold('EXEC:')} ${C.green(cmd)}`)
  try {
    const o=execSync(cmd,{
      timeout:120000, maxBuffer:10*1024*1024, shell:'/bin/bash',
      env:{...process.env, TERM:'xterm', DEBIAN_FRONTEND:'noninteractive',
           PATH:process.env.PATH+':/root/go/bin:/usr/local/go/bin:/root/.local/bin'}
    }).toString().trim()
    return {ok:true, output:o||'(no output)', cmd}
  } catch(e) {
    const o=(e.stdout?.toString()||'')+(e.stderr?.toString()||'')
    return {ok:false, output:o.trim()||e.message, cmd}
  }
}

// ── System prompt ──────────────────────────────────────────────────────────
function buildPrompt(target, step, mode, scope, authCtx, lastOut, lastOk, ctx, findings, confirmedVulns, userCtx, dbSummary) {
  const modeCtx = mode==='exploit'
    ? `🔬 VERIFICATION MODE — Perform deep technical verification of the confirmed vulnerability.
Your goal is to fully demonstrate the impact with clear proof-of-concept evidence.
Document exact reproduction steps, affected data scope, and technical details.
Only set exploitation_complete=true when you have complete technical evidence documented.`
    : `🔍 AUDIT MODE — Conduct a comprehensive security assessment.
Perform systematic recon, enumeration, and vulnerability analysis.
Test all common vulnerability classes: injection, authentication, access control, misconfigurations.
Document all issues found. When you confirm a real vulnerability set confirmed_vuln=true.`

  return `You are a professional web application security auditor performing an authorized security assessment.
You conduct thorough security audits to help organizations identify and fix vulnerabilities.
You work methodically and document all findings professionally.

CONTEXT: This is an authorized security assessment. All testing is performed with explicit permission.
TARGET: ${target}
SCOPE: ${scope}
STEP: ${step}
MODE: ${mode.toUpperCase()}
${authCtx}${userCtx}

${modeCtx}

TOOL RULES:
1. NEVER run apt-get update — forbidden absolutely
2. NEVER combine check+install+use in one command (no: which tool || install && use)
3. ALWAYS split into separate steps:
   Step A: which <tool> 2>/dev/null || echo "MISSING"
   Step B (only if missing): apt-get install -y -qq <tool>  OR  pip3 install -q <tool>  OR  go install <pkg>@latest
   Step C: run the tool
4. Most tools exist on Kali — just run them directly, skip the check
5. NEVER chain: which tool || install && use — this is forbidden

JSON RESPONSE ONLY — no other text:
{
  "thought": "expert reasoning — what did I find, what's my next move and why",
  "action": "run_command | print | done",
  "command": "bash command — plain text, no markdown, plain URLs",
  "message": "text for print action",
  "findings": ["finding [SEVERITY]"],
  "analysis": "technical analysis of last output",
  "confirmed_vuln": false,
  "exploitation_complete": false,
  "vuln_details": {
    "name": "vulnerability name",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "evidence": "exact proof from response",
    "impact": "what can be achieved",
    "reproduce": "exact reproduction steps"
  }
}

LAST OUTPUT [${lastOk?'OK':'FAILED'}]:
${lastOut.slice(0,500)}

RECENT HISTORY:
${ctx||'none'}

CONFIRMED VULNS:
${confirmedVulns.length
  ? confirmedVulns.map(v=>`  [${v.severity}] ${v.name} — ${v.impact||''}`).join('\n')
  : 'none yet'}

FINDINGS SO FAR:
${findings.length ? findings.slice(-10).join('\n') : 'none yet'}

ALREADY EXECUTED COMMANDS (${dbSummary.total} total — DO NOT repeat these):
${dbSummary.allCmds.slice(0,800)||'none yet'}

LAST 10 RESULTS:
${dbSummary.last10||'none yet'}

JSON:`
}

// ── Confirmed vuln handler ─────────────────────────────────────────────────
async function handleConfirmedVuln(vuln) {
  p(`\n${'█'.repeat(62)}`,C.bg_red)
  p(`  💥 CONFIRMED VULNERABILITY`,C.bg_red)
  p(`${'█'.repeat(62)}`,C.bg_red)
  p(`\n  Name    : ${C.bold(vuln.name||'?')}`)
  p(`  Severity: ${C.bold(vuln.severity||'?')}`, vuln.severity==='CRITICAL'?C.red:C.yellow)
  p(`  Evidence: ${vuln.evidence||'see log'}`,C.cyan)
  p(`  Impact  : ${vuln.impact||'?'}`)
  p(`  Repro   : ${vuln.reproduce||'see log'}\n`)

  const choice = await waitUser(
    'What do you want to do?\n' +
    '  [1] exploit  — deep verification with full PoC evidence\n' +
    '  [2] bypass   — use as foothold, pivot deeper\n' +
    '  [3] document — record and continue hunting\n' +
    '  [4] skip     — ignore\n' +
    '  or type custom instruction'
  )

  const low=choice.toLowerCase().trim()
  if(low==='1'||low==='exploit'){
    p(`\n  ⚔️  ${C.bg_red(' EXPLOIT MODE — will not exit until fully exploited ')}`,C.red)
    return {mode:'exploit', instruction:'VERIFY FULLY: Demonstrate complete technical impact with PoC. Document all evidence. Do not stop until fully verified.'}
  } else if(low==='2'||low==='bypass'){
    p(`  🔓  BYPASS mode`,C.yellow)
    return {mode:'hunt', instruction:`BYPASS: Use ${vuln.name} as foothold. Pivot and escalate access.`}
  } else if(low==='3'||low==='document'){
    p(`  📝  DOCUMENT mode`,C.cyan)
    return {mode:'hunt', instruction:`DOCUMENT ${vuln.name} with full evidence then continue hunting.`}
  } else if(low==='4'||low==='skip'){
    p(`  ⏭️  Skipping`,C.gray)
    return {mode:'hunt', instruction:'Skip this finding and continue hunting.'}
  } else {
    p(`  📨  Custom: ${choice}`,C.magenta)
    return {mode:'hunt', instruction:`USER: ${choice}`}
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function agent(target, scope='Full penetration test', authCtx='', notes='') {
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — EXPERT FREE AGENT`,C.red)
  p(`  Target  : ${target}`,C.yellow)
  p(`  Log     : ${LOG}`,C.gray)
  p(`  Report  : ${RFILE}`,C.gray)
  p(`  Controls: type anything | 'findings' | 'stop'`,C.gray)
  p(`${'═'.repeat(62)}\n`,C.red)

  p('  🧅 Starting Tor...',C.cyan)
  setupTor()

  const db = new SessionDB(target)
  if(Object.keys(db.data.commands).length > 0) {
    p(`\n  📂 Resuming from previous session (${Object.keys(db.data.commands).length} commands already done)`,C.cyan)
    p(`  ⚡ Agent will skip already-executed commands`,C.gray)
  }
  // استرجع ما تم حفظه مسبقاً
  let mode          = 'hunt'   // 'hunt' | 'exploit'
  let history       = []
  let findings      = [...db.data.findings]
  let confirmedVulns= [...db.data.confirmed]
  let lastOut       = `Starting pentest on ${target}`
  let lastOk        = true
  let failCount     = 0
  let step          = 0
  let extraCtx      = ''

  rl.on('line', line => {
    if(line.trim().toLowerCase()==='findings'){
      p(`\n  💥 CONFIRMED (${confirmedVulns.length}):`,C.red)
      confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name} — ${v.impact||''}`,C.yellow))
      p(`\n  🔎 ALL FINDINGS (${findings.length}):`,C.yellow)
      findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.gray))
    }
  })

  while(!stopped) {
    step++
    p(`\n${'─'.repeat(48)}`,C.gray)
    const modeTag = mode==='exploit'
      ? C.bg_red(` ⚔️  EXPLOIT MODE `)
      : C.cyan(`🔍 HUNT`)
    p(`  📍 Step ${step} | ${modeTag} ${torReady?'🧅':''}`,)

    let userCtx=''
    if(extraCtx){ userCtx=extraCtx; extraCtx='' }
    if(userMessage){ userCtx+=`\nUSER: ${userMessage}`; userMessage=null }

    const ctx=history.slice(-5).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${(h.cmd||'').slice(0,70)}: ${(h.output||'').slice(0,150)}`
    ).join('\n')

    p(`  🤔 Thinking...`,C.gray)
    const dbSum=db.summary()
    const raw=await gemini(buildPrompt(target,step,mode,scope,authCtx,lastOut,lastOk,ctx,findings,confirmedVulns,userCtx,dbSum))

    if(!raw){
      failCount++
      p(`  ⚠️  No response (${failCount})`,C.yellow)
      if(failCount===3){ p(`  🔀 Switching to direct...`,C.yellow); torReady=false }
      if(failCount===5){ p(`  🧅 Re-enabling Tor...`,C.yellow); torReady=true; rotateIp(); await sleep(5000); failCount=0 }
      await sleep(3000); continue
    }
    failCount=0

    const parsed=parseJSON(raw)
    if(!parsed){ p(`  ⚠️  Bad JSON: ${raw.slice(0,100)}`,C.yellow); lastOut=raw.slice(0,300); continue }

    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    // collect findings
    if(parsed.findings?.length)
      for(const f of parsed.findings)
        if(!findings.includes(f)){ findings.push(f); db.addFinding(f); p(`\n  🔎 ${C.yellow(f)}`) }

    // handle action
    if(parsed.action==='run_command'){
      if(!parsed.command){ p('  ⚠️  no command',C.yellow); continue }
      const res=runCmd(parsed.command)
      lastOut=res.output; lastOk=res.ok
      const preview=res.output.slice(0,900)
      p(`\n  📤 OUTPUT:`)
      p(preview.split('\n').map(l=>`     ${l}`).join('\n'), res.ok?C.cyan:C.red)
      if(res.output.length>900) p(`     ...+${res.output.length-900} chars`,C.gray)
      history.push({step, cmd:res.cmd, output:res.output.slice(0,300), ok:res.ok})
      db.save(res.cmd, res.output, res.ok)

    } else if(parsed.action==='print'){
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 Agent Update — Step ${step}`,C.bold)
      p(parsed.message||'')
      p(`${'━'.repeat(52)}`,C.yellow)
      lastOut=`Update at step ${step}`; lastOk=true

    } else if(parsed.action==='done'){
      // write report
      const report=buildReport(target,confirmedVulns,findings,history)
      fs.writeFileSync(RFILE,report)
      p(`\n  ✅ Pentest complete`,C.bg_grn)
      if(parsed.message) p(parsed.message)
      stopped=true
    }

    // ── Exploitation complete → back to hunt ───────────────────────────────
    if(mode==='exploit' && parsed.exploitation_complete){
      p(`\n${'█'.repeat(62)}`,C.bg_grn)
      p(`  ✅ EXPLOITATION COMPLETE — returning to hunting mode`,C.bg_grn)
      p(`${'█'.repeat(62)}`,C.bg_grn)
      mode='hunt'
      extraCtx='Exploitation complete. Resume hunting for more vulnerabilities.'
      lastOut=`Exploitation done. Continuing pentest.`; lastOk=true
    }

    // ── Confirmed vuln → pause and ask user ───────────────────────────────
    if(parsed.confirmed_vuln && parsed.vuln_details?.name){
      const vd=parsed.vuln_details
      if(!confirmedVulns.find(v=>v.name===vd.name&&v.evidence===vd.evidence)){
        confirmedVulns.push(vd)
        db.addConfirmed(vd)
        const dec=await handleConfirmedVuln(vd)
        mode=dec.mode
        extraCtx=dec.instruction
        lastOut=`Confirmed: ${vd.name}. User chose: ${dec.instruction}`; lastOk=true
      }
    }

    await sleep(1200)
  }

  // final summary
  const report=buildReport(target,confirmedVulns,findings,history)
  fs.writeFileSync(RFILE,report)
  p(`\n${'═'.repeat(62)}`,C.red)
  p(`  📋 DONE — ${step} steps | ${confirmedVulns.length} exploited | ${findings.length} findings`,C.bold)
  confirmedVulns.forEach((v,i)=>p(`  ${i+1}. [${v.severity}] ${v.name} — ${v.impact||''}`,C.yellow))
  p(`\n  📄 Report: ${RFILE}`,C.cyan)
  p(`  📁 Log   : ${LOG}\n`,C.gray)
  rl.close(); process.exit(0)
}

function buildReport(target, vulns, findings, history) {
  const date=new Date().toISOString().split('T')[0]
  return `# 🔴 Penetration Test Report
**Target:** ${target}
**Date:** ${date}

## Confirmed Vulnerabilities
| # | Name | Severity | Impact |
|---|------|----------|--------|
${vulns.map((v,i)=>`| ${i+1} | ${v.name} | ${v.severity} | ${v.impact||''} |`).join('\n')||'| - | None found | - | - |'}

## All Findings
${findings.map((f,i)=>`${i+1}. ${f}`).join('\n')||'None'}

## Command History
${history.map(h=>`- [${h.ok?'OK':'FAIL'}] \`${h.cmd}\``).join('\n')}

---
*Generated by Gemini RedTeam Agent — ${new Date().toISOString()}*
`
}

async function menu() {
  const ask = q => new Promise(res => {
    process.stdout.write(q)
    rl.once('line', l => res(l.trim()))
  })

  console.clear()
  console.log(C.red(`
╔══════════════════════════════════════════════════════════╗
║          🔴  GEMINI REDTEAM — EXPERT AGENT               ║
║          Autonomous Penetration Testing AI               ║
╚══════════════════════════════════════════════════════════╝`))

  // عرض sessions سابقة
  const prev = fs.readdirSync('.').filter(f=>f.startsWith('db_')&&f.endsWith('.json'))
  if(prev.length) {
    p('\n  📂 Previous sessions:', C.cyan)
    prev.forEach((f,i)=>{
      try {
        const d=JSON.parse(fs.readFileSync(f,'utf8'))
        const cmds=Object.keys(d.commands||{}).length
        const vulns=(d.confirmed||[]).length
        p(`  [${i+1}] ${d.target} — ${cmds} cmds, ${vulns} vulns`,C.gray)
      } catch{}
    })
    console.log()
  }

  // Target
  let target = process.argv.slice(2).join(' ').trim()
  if(!target) target = await ask(C.yellow('  🎯 Target URL (e.g. https://example.com): '))
  if(!target) { p('  ❌ No target provided',C.red); process.exit(1) }
  if(!target.startsWith('http')) target = 'https://' + target

  // Scope
  console.log(C.cyan('\n  📋 Scope options:'))
  console.log(C.gray('  [1] Full pentest          — everything (default)'))
  console.log(C.gray('  [2] Recon only             — passive, no active attacks'))
  console.log(C.gray('  [3] Web vulns only         — SQLi, XSS, IDOR, SSRF...'))
  console.log(C.gray('  [4] Specific endpoint      — focus on one path'))
  console.log(C.gray('  [5] Custom                 — type your own focus'))
  const scopeChoice = await ask(C.yellow('\n  Choose scope [1-5] or Enter for full: ')) || '1'

  let scope = ''
  if(scopeChoice==='1'||scopeChoice==='') scope = 'Full penetration test — recon, scanning, all vulnerability classes'
  else if(scopeChoice==='2') scope = 'Passive recon only — no active attacks, just information gathering'
  else if(scopeChoice==='3') scope = 'Web vulnerabilities focus — SQLi, XSS, IDOR, SSRF, LFI, auth bypass, CORS'
  else if(scopeChoice==='4') {
    const ep = await ask(C.yellow('  Specific endpoint (e.g. /api/login): '))
    scope = `Focus exclusively on endpoint: ${ep} — test all vulnerability classes on this path`
  }
  else if(scopeChoice==='5') {
    scope = await ask(C.yellow('  Describe your focus: '))
  }
  else scope = 'Full penetration test'

  // Auth credentials (optional)
  const hasAuth = await ask(C.yellow('\n  🔑 Do you have login credentials to test? [y/N]: '))
  let authCtx = ''
  if(hasAuth.toLowerCase()==='y') {
    const user = await ask(C.yellow('  Username/email: '))
    const pass = await ask(C.yellow('  Password: '))
    authCtx = `\nAUTH CREDENTIALS AVAILABLE: username="${user}" password="${pass}" — use these to test authenticated endpoints and privilege escalation`
  }

  // Extra notes
  const notes = await ask(C.yellow('\n  📝 Any extra notes or exclusions? (Enter to skip): '))

  // Summary
  console.log(C.green('\n  ╔═══════════════════════════════════════╗'))
  console.log(C.green('  ║         MISSION BRIEFING              ║'))
  console.log(C.green('  ╚═══════════════════════════════════════╝'))
  p(`  Target : ${target}`, C.yellow)
  p(`  Scope  : ${scope}`, C.cyan)
  if(authCtx) p(`  Auth   : credentials provided`, C.cyan)
  if(notes)   p(`  Notes  : ${notes}`, C.gray)
  console.log()

  const go = await ask(C.bold('  🚀 Start? [Y/n]: '))
  if(go.toLowerCase()==='n') { p('  Aborted.',C.gray); process.exit(0) }

  const fullTarget = target + (authCtx||'') + (notes ? `\nNOTES: ${notes}` : '') + `\nSCOPE: ${scope}`
  agent(target, scope, authCtx, notes)
}

menu()

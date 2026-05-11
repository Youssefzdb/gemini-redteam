#!/usr/bin/env node
/**
 * 🔴 Gemini RedTeam Agent — Tor Rotating IP
 * Uses Tor SOCKS5 proxy to bypass IP blocks
 * Rotates IP every 2 minutes automatically
 */
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import querystring from 'node:querystring'
import { execSync, exec } from 'node:child_process'
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
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg, c) => { console.log(c?c(msg):msg); w(msg) }
const ask = q => new Promise(r => rl.question(C.yellow(`\n❓ ${q}\n> `), a => r(a.trim())))

// ── Tor Setup ──────────────────────────────────────────────────────────────
const TOR_SOCKS = { host: '127.0.0.1', port: 9050 }
const TOR_CONTROL = { host: '127.0.0.1', port: 9051 }
let torReady = false
let lastRotate = Date.now()
const ROTATE_INTERVAL = 2 * 60 * 1000 // 2 minutes

function setupTor() {
  try {
    // Install if needed
    try { execSync('which tor', {stdio:'ignore'}) }
    catch { p('  📦 Installing tor...', C.yellow); execSync('apt-get install -y tor', {stdio:'ignore'}) }

    // Configure tor control port
    const torrc = '/etc/tor/torrc'
    let conf = ''
    try { conf = fs.readFileSync(torrc,'utf8') } catch {}
    if (!conf.includes('ControlPort 9051')) {
      fs.appendFileSync(torrc, '\nControlPort 9051\nHashedControlPassword ""\nCookieAuthentication 0\n')
    }

    // Start/restart tor
    try { execSync('systemctl restart tor', {stdio:'ignore'}) }
    catch { execSync('service tor restart', {stdio:'ignore'}) }

    // Wait for tor to be ready
    p('  ⏳ Waiting for Tor...', C.gray)
    for (let i = 0; i < 20; i++) {
      try {
        execSync('curl -s --socks5 127.0.0.1:9050 --max-time 3 https://check.torproject.org/api/ip', {stdio:'ignore'})
        torReady = true
        break
      } catch {
        execSync('sleep 2')
      }
    }

    if (torReady) {
      const ip = execSync('curl -s --socks5 127.0.0.1:9050 --max-time 10 https://api.ipify.org').toString().trim()
      p(`  ✅ Tor ready! Exit IP: ${ip}`, C.green)
    } else {
      p('  ⚠️  Tor not ready, using direct connection', C.yellow)
    }
  } catch(e) {
    p(`  ⚠️  Tor setup failed: ${e.message}`, C.yellow)
  }
}

function rotateIp() {
  try {
    // Send NEWNYM signal to Tor control port
    const sock = net.createConnection(TOR_CONTROL.port, TOR_CONTROL.host)
    sock.on('connect', () => {
      sock.write('AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n')
    })
    sock.on('data', () => sock.destroy())
    sock.on('error', () => {
      // fallback: restart tor
      try { execSync('systemctl reload tor 2>/dev/null || service tor reload 2>/dev/null', {stdio:'ignore'}) } catch {}
    })
    lastRotate = Date.now()
    p('\n  🔄 Tor IP rotated!', C.cyan)
  } catch(e) {
    p(`  ⚠️  Rotate failed: ${e.message}`, C.gray)
  }
}

// ── SOCKS5 HTTP Request via Tor ────────────────────────────────────────────
function socksRequest(options, body) {
  return new Promise((resolve, reject) => {
    // Connect to Tor SOCKS5
    const socket = net.createConnection(TOR_SOCKS.port, TOR_SOCKS.host)
    socket.setTimeout(60000)

    socket.on('connect', () => {
      // SOCKS5 handshake
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })

    let step = 0
    let responseData = Buffer.alloc(0)

    socket.on('data', chunk => {
      if (step === 0) {
        // Auth response
        if (chunk[1] === 0x00) {
          step = 1
          const host = Buffer.from(options.hostname)
          const port = options.port || 443
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03]),
            Buffer.from([host.length]),
            host,
            Buffer.from([port >> 8, port & 0xff])
          ])
          socket.write(req)
        }
      } else if (step === 1) {
        // Connection response
        if (chunk[1] === 0x00) {
          step = 2
          // Now do TLS over this socket
          const tlsSocket = require('tls').connect({
            socket,
            servername: options.hostname,
            rejectUnauthorized: false
          }, () => {
            const httpReq = `POST ${options.path} HTTP/1.1\r\n` +
              `Host: ${options.hostname}\r\n` +
              Object.entries(options.headers||{}).map(([k,v])=>`${k}: ${v}`).join('\r\n') +
              `\r\n\r\n` + body
            tlsSocket.write(httpReq)
          })
          tlsSocket.on('data', d => { responseData = Buffer.concat([responseData, d]) })
          tlsSocket.on('end', () => resolve(responseData.toString()))
          tlsSocket.on('error', reject)
        }
      }
    })

    socket.on('error', reject)
    socket.on('timeout', () => { socket.destroy(); reject(new Error('SOCKS timeout')) })
  })
}

// ── Simpler approach: use curl with tor proxy ──────────────────────────────
async function geminiViaTor(prompt) {
  const inner = [[prompt,0,null,null,null,null,0],['en-US'],
    ['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,
    null,null,null,null,null,[[0]],0]
  const payload = querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify(inner)])})+'&'

  // Auto-rotate every 2 minutes
  if (Date.now() - lastRotate > ROTATE_INTERVAL) rotateIp()

  const safe = prompt.length > 4000 ? prompt.slice(0,4000) : prompt
  const safePayload = querystring.stringify({'f.req':JSON.stringify([null,JSON.stringify([[safe,0,null,null,null,null,0],['en-US'],['','','',null,null,null,null,null,null,''],'','',null,[0],1,null,null,1,0,null,null,null,null,null,[[0]],0])])})+'&'

  const proxy = torReady ? '--socks5 127.0.0.1:9050' : ''
  const payloadFile = `/tmp/gemini_payload_${Date.now()}.txt`
  fs.writeFileSync(payloadFile, safePayload)

  for (let i = 0; i < 3; i++) {
    try {
      const cmd = `curl -s ${proxy} --max-time 45 -X POST \
        'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' \
        -H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' \
        -H 'x-same-domain: 1' \
        -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' \
        -H 'accept: */*' \
        --data-binary @${payloadFile}`

      const raw = execSync(cmd, { maxBuffer: 5*1024*1024, timeout: 50000 }).toString()
      fs.unlinkSync(payloadFile)

      // Check for redirect (IP block)
      if (raw.includes('302') || raw.includes('sorry') || raw.includes('CAPTCHA')) {
        p(`  🔄 IP blocked! Rotating...`, C.yellow)
        rotateIp()
        await new Promise(r => setTimeout(r, 3000))
        continue
      }

      const result = parseGemini(raw)
      if (result) return result

    } catch(e) {
      p(`  ⚠️  retry ${i+1}: ${e.message.slice(0,60)}`, C.gray)
      if (torReady) { rotateIp(); await new Promise(r => setTimeout(r, 3000)) }
    }
  }
  return null
}

function parseGemini(text) {
  text = text.replace(")]}'","")
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      for (const item of (Array.isArray(data)?data:[])) {
        if (!Array.isArray(item) || item[0]!=='wrb.fr' || !item[2]) continue
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

const SYS = `Red Team AI on Kali Linux. JSON only:
{"thought":"...","action":"run_command|ask_user|report|done","command":"bash cmd","message":"...","findings":[],"analysis":"..."}
- command: plain bash, plain URLs (no markdown)
- Fix failed commands yourself next step
- Use report every 5 steps`

async function agent(task) {
  p(`\n${'═'.repeat(58)}`,C.red)
  p(`  🔴 GEMINI REDTEAM — Tor Rotating IP`,C.red)
  p(`  Task: ${task}`,C.yellow)
  p(`  Log:  ${LOG}`,C.gray)
  p(`  stop | findings | status`,C.gray)
  p(`${'═'.repeat(58)}\n`,C.red)

  // Setup Tor first
  p('  🧅 Setting up Tor...', C.cyan)
  setupTor()

  let history=[], findings=[], lastOut='Starting.', lastOk=true
  let stopped=false, failCount=0, step=0

  rl.on('line',line=>{
    const l=line.trim().toLowerCase()
    if(l==='stop'||l==='exit') stopped=true
    if(l==='findings'){p(`\n🚨 FINDINGS (${findings.length}):`,C.yellow);findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))}
    if(l==='status') p(`  Step ${step} | Findings: ${findings.length} | ${lastOk?'✅':'❌'} | Tor: ${torReady?'🧅':'❌'}`,C.cyan)
    if(l==='rotate') rotateIp()
  })

  while (!stopped) {
    step++
    p(`\n${'─'.repeat(46)}`,C.gray)
    p(`  📍 STEP ${step} ${torReady?'🧅':''}`,C.cyan)

    const ctx = history.slice(-3).map(h=>
      `[${h.ok?'OK':'FAIL'}] ${h.cmd||'?'}: ${(h.output||'').slice(0,150)}`
    ).join('\n')

    const prompt = `${SYS}
Task: ${task}
Step: ${step}
Last[${lastOk?'OK':'FAIL'}]: ${lastOut.slice(0,300)}
History:\n${ctx||'none'}
Findings: ${findings.slice(-5).join(' | ')||'none'}
JSON:`

    p(`  🤔 Thinking...`,C.gray)
    const raw = await geminiViaTor(prompt)

    if (!raw) {
      failCount++
      p(`  ⚠️  No response (${failCount}/3)`,C.yellow)
      if(failCount>=3){
        const r=await ask('Stuck. New direction or "stop":')
        if(r==='stop'){stopped=true;break}
        lastOut=`User: ${r}`; failCount=0
      }
      continue
    }
    failCount=0

    const parsed=parseJSON(raw)
    if (!parsed) { p(`  ⚠️  Bad JSON: ${raw.slice(0,80)}`,C.yellow); lastOut=raw.slice(0,200); continue }

    if(parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if(parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    if(parsed.action==='run_command'){
      if(!parsed.command){p('  ⚠️  no command',C.yellow);continue}
      const res=runCmd(parsed.command)
      lastOut=res.output; lastOk=res.ok
      p(`\n  📤 OUTPUT:`)
      p(res.output.slice(0,600).split('\n').map(l=>`     ${l}`).join('\n'),res.ok?C.cyan:C.red)
      if(res.output.length>600) p(`     ...+${res.output.length-600} chars`,C.gray)
      history.push({step,cmd:res.cmd,output:res.output,ok:res.ok})

    } else if(parsed.action==='ask_user'){
      p(`\n  🤖 ${C.bold('AGENT:')} ${parsed.message||'Need input.'}`)
      const ans=await ask('Your response:')
      if(ans==='stop'){stopped=true;break}
      lastOut=`User: ${ans}`; lastOk=true
      history.push({step,cmd:null,output:lastOut,ok:true})

    } else if(parsed.action==='report'){
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 REPORT — Step ${step}`,C.bold)
      p(parsed.message||'')
      if(parsed.findings?.length) parsed.findings.forEach(f=>{if(!findings.includes(f)){findings.push(f);p(`  🚨 ${f}`,C.yellow)}})
      p(`${'━'.repeat(52)}`,C.yellow)
      const cont=await ask('Continue? (yes / stop / new task):')
      if(cont==='stop'||cont==='no'){stopped=true;break}
      lastOut=`User: ${cont}`; lastOk=true
      if(cont!=='yes'&&cont.length>2) task=cont

    } else if(parsed.action==='done'){
      p(`\n${'═'.repeat(58)}`,C.green)
      p(`  ✅ DONE`,C.green)
      if(parsed.message) p(parsed.message)
      stopped=true
    }

    if(parsed.findings?.length){
      for(const f of parsed.findings){
        if(!findings.includes(f)){findings.push(f);p(`\n  🚨 ${C.bold('FINDING:')} ${C.yellow(f)}`)}
      }
    }

    await new Promise(r=>setTimeout(r,1200))
  }

  p(`\n${'═'.repeat(58)}`,C.red)
  p(`  📋 SUMMARY — ${step} steps | ${findings.length} findings`,C.bold)
  findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))
  p(`  📁 ${LOG}\n`,C.gray)
  fs.writeFileSync(LOG.replace('.log','_report.json'),JSON.stringify({task,steps:step,findings,history},null,2))
  rl.close();process.exit(0)
}

const task=process.argv.slice(2).join(' ')
if(!task) rl.question(C.red('\n🔴 Target/task: '),t=>agent(t.trim()))
else agent(task)

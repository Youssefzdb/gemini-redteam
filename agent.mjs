#!/usr/bin/env node
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
const w = msg => fs.appendFileSync(LOG, msg+'\n')
const p = (msg, c) => { console.log(c?c(msg):msg); w(msg) }
const ask = q => new Promise(r => rl.question(C.yellow(`\n❓ ${q}\n> `), a => r(a.trim())))

function clean(cmd) {
  if (!cmd) return ''
  return cmd
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g,'$2')
    .replace(/\[([^\]]+)\]/g,'$1')
    .replace(/`/g,'').trim()
}

function run(rawCmd) {
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

// ── Gemini — tested & working ──────────────────────────────────────────────
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
                if (txt.length>best.length) best=txt
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
  // Keep prompt short — tested max before Empty
  const safe = prompt.length > 4000 ? prompt.slice(0,4000) : prompt
  for (let i=0;i<3;i++) {
    try {
      return await new Promise((resolve,reject) => {
        const payload = buildPayload(safe)
        const req = https.request({
          hostname:'gemini.google.com',
          path:'/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          method:'POST',
          headers:{
            'content-type':'application/x-www-form-urlencoded;charset=UTF-8',
            'content-length':Buffer.byteLength(payload),
            'x-same-domain':'1',
            'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            'cookie':'','accept':'*/*',
          },timeout:60000,
        },res=>{
          let d=''
          res.on('data',c=>d+=c)
          res.on('end',()=>{
            const r=parseGemini(d)
            r?resolve(r):reject(new Error('Empty'))
          })
        })
        req.on('error',reject)
        req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'))})
        req.write(payload);req.end()
      })
    } catch(e) {
      p(`  ⚠️  retry ${i+1}: ${e.message}`,C.gray)
      await new Promise(r=>setTimeout(r,2000*(i+1)))
    }
  }
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

// ── Short system prompt — avoids Empty ────────────────────────────────────
const SYS = `Red Team AI on Kali Linux. JSON only:
{"thought":"...","action":"run_command|ask_user|report|done","command":"bash cmd","message":"...","findings":[],"analysis":"..."}
- command: plain bash, plain URLs (no markdown no brackets)
- If command failed: fix it yourself next step
- report every 5 steps, ask_user when stuck`

async function agent(task) {
  p(`\n${'═'.repeat(58)}`,C.red)
  p(`  🔴 GEMINI REDTEAM AGENT — Autonomous`,C.red)
  p(`  Task: ${task}`,C.yellow)
  p(`  Log:  ${LOG}`,C.gray)
  p(`  stop | findings | status`,C.gray)
  p(`${'═'.repeat(58)}\n`,C.red)

  let history=[], findings=[], lastOut='Starting.', lastOk=true
  let stopped=false, failCount=0, step=0

  rl.on('line',line=>{
    const l=line.trim().toLowerCase()
    if(l==='stop'||l==='exit') stopped=true
    if(l==='findings'){p(`\n🚨 FINDINGS (${findings.length}):`,C.yellow);findings.forEach((f,i)=>p(`  ${i+1}. ${f}`,C.yellow))}
    if(l==='status') p(`  Step ${step} | Findings: ${findings.length} | ${lastOk?'✅':'❌'}`,C.cyan)
  })

  while (!stopped) {
    step++
    p(`\n${'─'.repeat(46)}`,C.gray)
    p(`  📍 STEP ${step}`,C.cyan)

    // ── Strict context limit — max 3 recent steps, 150 chars each ──────────
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
    const raw = await gemini(prompt)

    if (!raw) {
      failCount++
      p(`  ⚠️  No response (${failCount}/3)`,C.yellow)
      if (failCount>=3) {
        const r = await ask('Stuck. New direction or "stop":')
        if(r==='stop'){stopped=true;break}
        lastOut=`User: ${r}`; failCount=0
      }
      continue
    }
    failCount=0

    const parsed = parseJSON(raw)
    if (!parsed) {
      p(`  ⚠️  Bad JSON: ${raw.slice(0,100)}`,C.yellow)
      // Still show raw so agent doesn't lose context
      lastOut=`Previous response unparseable: ${raw.slice(0,200)}`
      continue
    }

    if (parsed.thought) p(`\n  💭 ${parsed.thought}`,C.gray)
    if (parsed.analysis?.length>5) p(`  🔍 ${parsed.analysis}`)

    if (parsed.action==='run_command') {
      if (!parsed.command){p('  ⚠️  no command',C.yellow);continue}
      const res=run(parsed.command)
      lastOut=res.output; lastOk=res.ok
      const preview=res.output.slice(0,600)
      p(`\n  📤 OUTPUT:`)
      p(preview.split('\n').map(l=>`     ${l}`).join('\n'),res.ok?C.cyan:C.red)
      if(res.output.length>600) p(`     ...+${res.output.length-600} chars`,C.gray)
      history.push({step,cmd:res.cmd,output:res.output,ok:res.ok})

    } else if (parsed.action==='ask_user') {
      p(`\n  🤖 ${C.bold('AGENT:')} ${parsed.message||'Need input.'}`)
      const ans=await ask('Your response:')
      if(ans==='stop'){stopped=true;break}
      lastOut=`User: ${ans}`; lastOk=true
      history.push({step,cmd:null,output:lastOut,ok:true})

    } else if (parsed.action==='report') {
      p(`\n${'━'.repeat(52)}`,C.yellow)
      p(`  📊 REPORT — Step ${step}`,C.bold)
      p(parsed.message||'')
      if(parsed.findings?.length) parsed.findings.forEach(f=>{if(!findings.includes(f)){findings.push(f);p(`  🚨 ${f}`,C.yellow)}})
      p(`${'━'.repeat(52)}`,C.yellow)
      const cont=await ask('Continue? (yes / stop / new task):')
      if(cont==='stop'||cont==='no'){stopped=true;break}
      lastOut=`User: ${cont}`; lastOk=true
      if(cont!=='yes'&&cont.length>2) task=cont

    } else if (parsed.action==='done') {
      p(`\n${'═'.repeat(58)}`,C.green)
      p(`  ✅ DONE`,C.green)
      if(parsed.message) p(parsed.message)
      stopped=true
    }

    if(parsed.findings?.length) {
      for(const f of parsed.findings) {
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

#!/usr/bin/env node
/**
 * Gemini Proxy — Anthropic API → Gemini 2.0 Flash
 */

import http from 'node:http'
import https from 'node:https'
import querystring from 'node:querystring'

const PORT = 9099

// ── Gemini Engine ──────────────────────────────────────────────────────────
function buildGeminiPayload(prompt) {
  const inner = [
    [prompt, 0, null, null, null, null, 0],
    ['en-US'],
    ['', '', '', null, null, null, null, null, null, ''],
    '', '', null, [0], 1, null, null, 1, 0,
    null, null, null, null, null, [[0]], 0
  ]
  return querystring.stringify({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) }) + '&'
}

function parseGemini(text) {
  text = text.replace(")]}'", '')
  let best = ''
  for (const line of text.split('\n')) {
    if (!line.includes('wrb.fr')) continue
    try {
      const data = JSON.parse(line)
      const entries = Array.isArray(data)
        ? (data[0] === 'wrb.fr' ? [data] : data.filter(i => Array.isArray(i) && i[0] === 'wrb.fr'))
        : []
      for (const e of entries) {
        try {
          const inner = JSON.parse(e[2])
          if (Array.isArray(inner?.[4])) {
            for (const c of inner[4]) {
              if (Array.isArray(c?.[1])) {
                const txt = c[1].filter(t => typeof t === 'string').join('')
                if (txt.length > best.length) best = txt
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  return best.trim()
}

function askGemini(prompt) {
  return new Promise((resolve, reject) => {
    const payload = buildGeminiPayload(prompt)
    const req = https.request({
      hostname: 'gemini.google.com',
      path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'content-length': Buffer.byteLength(payload),
        'x-same-domain': '1',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'cookie': '',
        'accept': '*/*',
      },
      timeout: 120000,
    }, (res) => {
      let d = ''
      res.on('data', chunk => d += chunk)
      res.on('end', () => resolve(parseGemini(d) || 'Hello! How can I help you?'))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout')) })
    req.write(payload)
    req.end()
  })
}

// ── Messages → Prompt ──────────────────────────────────────────────────────
function messagesToPrompt(messages, system) {
  let prompt = ''
  if (system) {
    const sysText = Array.isArray(system)
      ? system.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : String(system)
    prompt += `System instructions:\n${sysText}\n\n`
  }
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant'
    let content = ''
    if (Array.isArray(msg.content)) {
      content = msg.content
        .filter(b => b.type === 'text' || b.type === 'tool_result')
        .map(b => b.type === 'text' ? b.text : (b.content?.[0]?.text || JSON.stringify(b.content)))
        .join('\n')
    } else {
      content = String(msg.content || '')
    }
    if (content.trim()) prompt += `${role}: ${content}\n`
  }
  prompt += 'Assistant:'
  return prompt
}

// ── Streaming SSE ──────────────────────────────────────────────────────────
function sendStream(res, text, model) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2)

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  write('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      content: [], model,
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null, stop_sequence: null
    }
  })

  write('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' }
  })

  write('ping', { type: 'ping' })

  // Send in small chunks to simulate streaming
  const CHUNK = 15
  for (let i = 0; i < text.length; i += CHUNK) {
    write('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + CHUNK) }
    })
  }

  write('content_block_stop', { type: 'content_block_stop', index: 0 })

  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(text.length / 4) }
  })

  write('message_stop', { type: 'message_stop' })
  res.end()
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,anthropic-version,x-api-key,anthropic-beta')

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Read body
  const rawBody = await new Promise(resolve => {
    let d = Buffer.alloc(0)
    req.on('data', c => d = Buffer.concat([d, c]))
    req.on('end', () => resolve(d.toString('utf8')))
  })

  let body = {}
  try { body = JSON.parse(rawBody) } catch {}

  console.log(`[${new Date().toISOString()}] ${method} ${url}`)

  // ── POST /v1/messages ────────────────────────────────────────────────────
  if (url.includes('/v1/messages') && method === 'POST') {
    const { messages = [], system, stream = false, model = 'claude-opus-4-5' } = body

    const prompt = messagesToPrompt(messages, system)
    console.log(`  → ${messages.length} messages, stream=${stream}`)

    let text
    try {
      text = await askGemini(prompt)
      console.log(`  ← ${text.length} chars from Gemini`)
    } catch (e) {
      console.error(`  ✗ Gemini error: ${e.message}`)
      text = `I encountered an error: ${e.message}. Please try again.`
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      sendStream(res, text, model)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        id: 'msg_' + Math.random().toString(36).slice(2),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: Math.ceil(text.length / 4) }
      }))
    }
    return
  }

  // ── GET /v1/models ────────────────────────────────────────────────────
  if (url.includes('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'claude-opus-4-5', object: 'model', created: 1700000000, owned_by: 'anthropic' },
        { id: 'claude-sonnet-4-5', object: 'model', created: 1700000000, owned_by: 'anthropic' },
        { id: 'claude-haiku-4-5', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      ]
    }))
    return
  }

  // ── Default: return 200 for anything else Claude Code probes ─────────────
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n\x1b[32m╔══════════════════════════════════════════════╗\x1b[0m`)
  console.log(`\x1b[32m║  Gemini Proxy  →  http://127.0.0.1:${PORT}      ║\x1b[0m`)
  console.log(`\x1b[32m║  Anthropic API → Gemini 2.0 Flash (keyless) ║\x1b[0m`)
  console.log(`\x1b[32m╚══════════════════════════════════════════════╝\x1b[0m\n`)
  console.log(`\x1b[33mRun Claude Code:\x1b[0m`)
  console.log(`  ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs\n`)
})

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\x1b[31m❌ Port ${PORT} busy. Run: kill $(lsof -ti:${PORT})\x1b[0m`)
  }
  process.exit(1)
})

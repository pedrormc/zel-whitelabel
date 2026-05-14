#!/usr/bin/env bun
/**
 * Webhook server — receives Evolution API webhooks and writes messages
 * to the FIFO that feeds Claude's stdin (stream-json format).
 *
 * Runs as a separate PM2 process alongside the Claude session.
 * Does NOT use MCP — just HTTP + FIFO.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { openSync, writeSync, closeSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

const ENV_FILE = process.env.ZEL_ENV ?? new URL('.env', import.meta.url).pathname
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]\w*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      const val = m[2].replace(/^(['"])(.*)\1$/, '$2')
      process.env[m[1]] = val
    }
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`webhook-server: failed to read ${ENV_FILE}: ${err}`)
  }
}

const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const EVOLUTION_URL = process.env.EVOLUTION_URL
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY
const PORT = parseInt(process.env.PORT || '3333', 10)
const FIFO_PATH = process.env.FIFO_PATH ?? '/home/USER/zel/zel-stdin.fifo'
const PLAUD_WEBHOOK_TOKEN = process.env.PLAUD_WEBHOOK_TOKEN
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR ?? '/home/USER/zel/plaud-transcripts'

const REQUIRED: Record<string, string | undefined> = {
  OWNER_WHATSAPP_NUMBER, OPENAI_API_KEY, EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY,
  PLAUD_WEBHOOK_TOKEN,
}
for (const [key, val] of Object.entries(REQUIRED)) {
  if (!val) {
    console.error(`webhook-server: ${key} required — check ${ENV_FILE}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Deduplication — 5 min TTL
// ---------------------------------------------------------------------------

const seenMessages = new Map<string, number>()
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [id, ts] of seenMessages) {
    if (ts < cutoff) seenMessages.delete(id)
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Audio transcription — Whisper via OpenAI
// ---------------------------------------------------------------------------

async function transcribeAudio(
  messageKey: Record<string, unknown>,
): Promise<string> {
  const mediaRes = await fetch(
    `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_APIKEY!,
      },
      body: JSON.stringify({ message: { key: messageKey } }),
    },
  )

  if (!mediaRes.ok) throw new Error(`Evolution media API: ${mediaRes.status}`)
  const mediaData = (await mediaRes.json()) as { base64?: string }
  if (!mediaData.base64) throw new Error('No base64 audio in response')

  const audioBuffer = Buffer.from(mediaData.base64, 'base64')
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' })

  const formData = new FormData()
  formData.append('file', blob, 'audio.ogg')
  formData.append('model', 'whisper-1')
  formData.append('language', 'pt')

  const whisperRes = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    },
  )

  if (!whisperRes.ok) throw new Error(`Whisper API: ${whisperRes.status}`)
  const whisperData = (await whisperRes.json()) as { text: string }
  return whisperData.text
}

// ---------------------------------------------------------------------------
// Send error to WhatsApp (for cases where we can't reach Claude)
// ---------------------------------------------------------------------------

async function sendEvolutionText(number: string, text: string): Promise<void> {
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_APIKEY! },
    body: JSON.stringify({ number: `${number}@s.whatsapp.net`, text }),
  }).catch(err => console.error(`webhook-server: send error: ${err}`))
}

// ---------------------------------------------------------------------------
// Write to FIFO — sends a stream-json user message to Claude's stdin
// ---------------------------------------------------------------------------

function writeToFifo(content: string): boolean {
  try {
    const fd = openSync(FIFO_PATH, 'w')
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    })
    writeSync(fd, msg + '\n')
    closeSync(fd)
    return true
  } catch (err) {
    console.error(`webhook-server: FIFO write failed: ${err}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(data: Record<string, any>): Promise<void> {
  if (data.event !== 'messages.upsert') return

  const key = data.data?.key
  if (!key) return
  if (key.fromMe) return

  const senderJid: string = key.remoteJid || ''
  const senderNumber = senderJid.replace('@s.whatsapp.net', '')
  if (senderNumber !== OWNER_WHATSAPP_NUMBER) return

  const msgId: string | undefined = key.id
  if (msgId && seenMessages.has(msgId)) return
  if (msgId) seenMessages.set(msgId, Date.now())

  const msg = data.data?.message
  if (!msg) return

  let messageText: string | null = null

  if (msg.conversation) {
    messageText = msg.conversation
  } else if (msg.extendedTextMessage?.text) {
    messageText = msg.extendedTextMessage.text
  } else if (msg.audioMessage) {
    try {
      const transcription = await transcribeAudio(data.data.key)
      messageText = transcription
        ? `[audio transcrito]: ${transcription}`
        : null
    } catch (err) {
      console.error(`webhook-server: transcription failed: ${err}`)
      await sendEvolutionText(OWNER_WHATSAPP_NUMBER!, 'Nao consegui transcrever o audio, tenta de novo.')
      return
    }
  } else {
    await sendEvolutionText(OWNER_WHATSAPP_NUMBER!, 'Zel so entende texto e audio por enquanto.')
    return
  }

  if (!messageText || messageText.trim().length === 0) return
  const text = messageText.trim()

  // Format as a channel-like message so Claude knows it's from WhatsApp
  const channelMsg =
    `<channel source="whatsapp" chat_id="${senderJid}" user="${senderNumber}" ts="${new Date().toISOString()}">\n` +
    `${text}\n` +
    `</channel>`

  const ok = writeToFifo(channelMsg)
  if (!ok) {
    await sendEvolutionText(OWNER_WHATSAPP_NUMBER!, 'Zel ta reiniciando, tenta de novo em 1 min.')
  } else {
    console.log(`webhook-server: forwarded message from ${senderNumber}: ${text.slice(0, 50)}`)
  }
}

// ---------------------------------------------------------------------------
// Plaud transcript handler — receives transcripts from n8n on external service
// ---------------------------------------------------------------------------

type PlaudPayload = {
  transcript: string
  duration: number
  filename: string
  recorded_at: string
}

function validatePlaud(body: unknown): PlaudPayload | string {
  if (!body || typeof body !== 'object') return 'body must be JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.transcript !== 'string' || b.transcript.trim().length < 10) {
    return 'transcript must be string >= 10 chars'
  }
  if (typeof b.duration !== 'number' || b.duration <= 0) {
    return 'duration must be positive number (seconds)'
  }
  if (typeof b.filename !== 'string' || !b.filename.trim()) {
    return 'filename required'
  }
  if (typeof b.recorded_at !== 'string' || isNaN(Date.parse(b.recorded_at))) {
    return 'recorded_at must be ISO date string'
  }
  return b as PlaudPayload
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return s > 0 ? `${m}min${s}s` : `${m}min`
}

function saveTranscript(payload: PlaudPayload): string {
  if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const safeStamp = payload.recorded_at.replace(/[:.]/g, '-')
  const safeName = payload.filename.replace(/[^\w.-]/g, '_')
  const path = join(TRANSCRIPTS_DIR, `${safeStamp}_${safeName}.txt`)
  writeFileSync(path, payload.transcript, 'utf8')
  return path
}

function buildPlaudPrompt(payload: PlaudPayload, transcriptPath: string): string {
  const preview = payload.transcript.slice(0, 500).replace(/\n/g, ' ')
  const ts = new Date().toISOString()
  return (
    `<channel source="plaud" chat_id="${OWNER_WHATSAPP_NUMBER}@s.whatsapp.net" user="${OWNER_WHATSAPP_NUMBER}" ts="${ts}">\n` +
    `<plaud-transcript>\n` +
    `filename: ${payload.filename}\n` +
    `duration: ${formatDuration(payload.duration)}\n` +
    `recorded_at: ${payload.recorded_at}\n` +
    `transcript_path: ${transcriptPath}\n` +
    `\n` +
    `PRÉVIA (primeiros 500 chars):\n` +
    `"${preview}${payload.transcript.length > 500 ? '...' : ''}"\n` +
    `</plaud-transcript>\n` +
    `\n` +
    `Nova gravação do Plaud chegou. Manda mensagem pro dono via reply perguntando o que fazer:\n` +
    `1. Ata de reunião (gera .docs e manda pros participantes)\n` +
    `2. Extrair tarefas pro backlog (registra no vault)\n` +
    `3. Ignorar\n` +
    `\n` +
    `Aguarda resposta dele e processa conforme. A transcrição completa tá em transcript_path — lê só quando precisar.\n` +
    `</channel>`
  )
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        channel: 'whatsapp',
        fifo: existsSync(FIFO_PATH) ? 'exists' : 'missing',
        uptime: process.uptime(),
      })
    }

    if (req.method === 'POST' && url.pathname === '/webhook/zel') {
      const data = (await req.json()) as Record<string, any>
      handleWebhook(data).catch(err =>
        console.error(`webhook-server: webhook error: ${err}`),
      )
      return Response.json({ status: 'received' })
    }

    if (req.method === 'POST' && url.pathname === '/webhook/plaud-transcript') {
      const auth = req.headers.get('authorization') ?? ''
      const expected = `Bearer ${PLAUD_WEBHOOK_TOKEN}`
      if (auth !== expected) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 })
      }

      const result = validatePlaud(body)
      if (typeof result === 'string') {
        return Response.json({ error: result }, { status: 400 })
      }

      let transcriptPath: string
      try {
        transcriptPath = saveTranscript(result)
      } catch (err) {
        console.error(`webhook-server: save transcript failed: ${err}`)
        return Response.json({ error: 'save failed' }, { status: 500 })
      }

      const prompt = buildPlaudPrompt(result, transcriptPath)
      const ok = writeToFifo(prompt)
      if (!ok) {
        return Response.json({ error: 'fifo unavailable' }, { status: 503 })
      }

      console.log(`webhook-server: plaud transcript queued (${result.filename}, ${formatDuration(result.duration)}) → ${transcriptPath}`)
      return Response.json({ status: 'queued', transcript_path: transcriptPath })
    }

    // Trigger endpoint for proactive tasks (briefing, review)
    if (req.method === 'POST' && url.pathname === '/trigger') {
      const { prompt, source } = (await req.json()) as {
        prompt: string
        source?: string
      }
      if (!prompt) {
        return Response.json({ error: 'prompt required' }, { status: 400 })
      }

      const channelMsg =
        `<channel source="${source ?? 'trigger'}" chat_id="${OWNER_WHATSAPP_NUMBER}@s.whatsapp.net" user="${OWNER_WHATSAPP_NUMBER}" ts="${new Date().toISOString()}">\n` +
        `${prompt}\n` +
        `</channel>`

      const ok = writeToFifo(channelMsg)
      return Response.json({ status: ok ? 'triggered' : 'fifo_error' })
    }

    return new Response('not found', { status: 404 })
  },
})

console.log(`webhook-server: listening on :${PORT}`)

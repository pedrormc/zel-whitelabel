#!/usr/bin/env bun
/**
 * WhatsApp channel for Claude Code via Evolution API.
 *
 * MCP server that bridges WhatsApp messages into a running Claude Code session.
 * Receives webhooks from Evolution API, forwards to Claude as channel events,
 * and exposes a reply tool so Claude can send messages back.
 *
 * Single-user mode: only OWNER_WHATSAPP_NUMBER is allowed through the gate.
 * No pairing flow needed — sender is hardcoded.
 *
 * State: .env only. No access.json or pairing files.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFileSync } from 'fs'

// ---------------------------------------------------------------------------
// ENV — load .env manually (Bun doesn't auto-load, plugin subprocess has no env block)
// ---------------------------------------------------------------------------

const ENV_FILE = process.env.ZEL_ENV ?? new URL('.env', import.meta.url).pathname
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]\w*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      // Strip surrounding quotes (single or double)
      const val = m[2].replace(/^(['"])(.*)\1$/, '$2')
      process.env[m[1]] = val
    }
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    process.stderr.write(`whatsapp channel: failed to read ${ENV_FILE}: ${err}\n`)
  }
}

const EVOLUTION_URL = process.env.EVOLUTION_URL
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const PORT = parseInt(process.env.PORT || '3333', 10)
const ZEL_HOME = process.env.ZEL_HOME ?? '/root/zel'

const REQUIRED: Record<string, string | undefined> = {
  EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY, OWNER_WHATSAPP_NUMBER, OPENAI_API_KEY,
}
for (const [key, val] of Object.entries(REQUIRED)) {
  if (!val) {
    process.stderr.write(`whatsapp channel: ${key} required — check ${ENV_FILE}\n`)
    process.exit(1)
  }
}

const OWNER_JID = `${OWNER_WHATSAPP_NUMBER}@s.whatsapp.net`

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`whatsapp channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`whatsapp channel: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Deduplication — 5 min TTL, same as v1
// ---------------------------------------------------------------------------

const seenMessages = new Map<string, number>()
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [id, ts] of seenMessages) {
    if (ts < cutoff) seenMessages.delete(id)
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Permission reply detection
// From official spec: 5 lowercase letters a-z minus 'l'.
// Extended to accept Portuguese yes/no (sim/s, nao/não).
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no|sim|s|nao|não)\s+([a-km-z]{5})\s*$/i
const YES_WORDS = new Set(['y', 'yes', 'sim', 's'])

// ---------------------------------------------------------------------------
// Evolution API — send helpers
// ---------------------------------------------------------------------------

const MAX_MSG_LENGTH = 3500
const RETRY_DELAYS = [1000, 3000, 10000]

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LENGTH) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH)
    if (splitAt === -1 || splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MSG_LENGTH)
    }
    if (splitAt === -1 || splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = MAX_MSG_LENGTH
    }
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

async function sendEvolutionText(number: string, text: string): Promise<void> {
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`
  const body = JSON.stringify({ number: `${number}@s.whatsapp.net`, text })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: EVOLUTION_APIKEY!,
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body })
      if (res.ok) return
      const errBody = await res.text().catch(() => 'no body')
      process.stderr.write(
        `whatsapp channel: send HTTP ${res.status} attempt ${attempt + 1}: ${errBody}\n`,
      )
    } catch (err) {
      process.stderr.write(
        `whatsapp channel: send error attempt ${attempt + 1}: ${err}\n`,
      )
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
    }
  }
  process.stderr.write(
    `whatsapp channel: failed to send after ${RETRY_DELAYS.length + 1} attempts\n`,
  )
}

// ---------------------------------------------------------------------------
// Audio transcription — Whisper via OpenAI (same as v1)
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
// MCP Server — channel declaration
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'O remetente le WhatsApp, nao esta sessao. Tudo que voce quer que ele veja DEVE ir pelo tool reply — seu output no terminal nunca chega no chat.',
      '',
      'Mensagens do WhatsApp chegam como <channel source="whatsapp" chat_id="..." user="..." ts="...">.',
      'Responda com o tool reply — passe o chat_id da tag.',
      '',
      'Regras de resposta:',
      '- PT-BR, casual e direto',
      '- Maximo 3 paragrafos curtos — e WhatsApp, nao email',
      '- Se a tarefa for longa, mande updates parciais via reply',
      '',
      'Para permissoes de tools, o usuario pode responder "sim <codigo>" ou "nao <codigo>" no WhatsApp.',
      '',
      'O WhatsApp nao tem historico acessivel — voce so ve mensagens conforme chegam.',
    ].join('\n'),
  },
)

// ---------------------------------------------------------------------------
// Permission relay — forward tool approval prompts to WhatsApp
// ---------------------------------------------------------------------------

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description } = params
    const text =
      `Permissao: ${tool_name}\n` +
      `${description}\n\n` +
      `Responda: "sim ${request_id}" ou "nao ${request_id}"`
    await sendEvolutionText(OWNER_WHATSAPP_NUMBER!, text)
  },
)

// ---------------------------------------------------------------------------
// Tools — reply (send message back via Evolution API)
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Envia mensagem no WhatsApp via Evolution API. Passe chat_id da mensagem recebida e o texto.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'O chat_id (JID) da mensagem recebida',
          },
          text: {
            type: 'string',
            description: 'Texto da resposta',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string

        // Gate: only send to dono
        const number = chat_id.replace('@s.whatsapp.net', '')
        if (number !== OWNER_WHATSAPP_NUMBER) {
          throw new Error(`chat ${chat_id} not allowed — only ${OWNER_WHATSAPP_NUMBER}`)
        }

        const chunks = splitMessage(text)
        for (const chunk of chunks) {
          await sendEvolutionText(number, chunk)
        }

        return {
          content: [
            {
              type: 'text',
              text:
                chunks.length === 1
                  ? 'sent'
                  : `sent ${chunks.length} parts`,
            },
          ],
        }
      }
      default:
        return {
          content: [
            { type: 'text', text: `unknown tool: ${req.params.name}` },
          ],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [
        { type: 'text', text: `${req.params.name} failed: ${msg}` },
      ],
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Connect to Claude Code over stdio
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Graceful shutdown — when Claude Code closes the MCP connection
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('whatsapp channel: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ---------------------------------------------------------------------------
// HTTP Webhook Server — receives Evolution API webhooks
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1', // nginx proxies external traffic — no need to expose
  async fetch(req) {
    const url = new URL(req.url)

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        channel: 'whatsapp',
        uptime: process.uptime(),
      })
    }

    // Evolution API webhook
    if (req.method === 'POST' && url.pathname === '/webhook/zel') {
      const data = (await req.json()) as Record<string, any>

      // Fire-and-forget — don't block the 200 response
      handleWebhook(data).catch(err => {
        process.stderr.write(`whatsapp channel: webhook error: ${err}\n`)
      })

      return Response.json({ status: 'received' })
    }

    // Trigger endpoint — used by proactive.js (briefing, review)
    // Accepts { prompt, source } and pushes as a channel notification
    if (req.method === 'POST' && url.pathname === '/trigger') {
      const { prompt, source } = (await req.json()) as {
        prompt: string
        source?: string
      }

      if (!prompt) {
        return Response.json({ error: 'prompt required' }, { status: 400 })
      }

      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content: prompt,
            meta: {
              chat_id: OWNER_JID,
              user: OWNER_WHATSAPP_NUMBER!,
              source: source ?? 'trigger',
              ts: new Date().toISOString(),
            },
          },
        })
        .catch(err => {
          process.stderr.write(`whatsapp channel: trigger error: ${err}\n`)
        })

      return Response.json({ status: 'triggered' })
    }

    return new Response('not found', { status: 404 })
  },
})

process.stderr.write(`whatsapp channel: listening on :${PORT}\n`)

// ---------------------------------------------------------------------------
// Webhook handler — filters, gates, transcribes, and forwards to Claude
// ---------------------------------------------------------------------------

async function handleWebhook(data: Record<string, any>): Promise<void> {
  // Only messages.upsert events
  if (data.event !== 'messages.upsert') return

  const key = data.data?.key
  if (!key) return
  if (key.fromMe) return

  // Gate: only the owner's number
  const senderJid: string = key.remoteJid || ''
  const senderNumber = senderJid.replace('@s.whatsapp.net', '')
  if (senderNumber !== OWNER_WHATSAPP_NUMBER) return

  // Dedup
  const msgId: string | undefined = key.id
  if (msgId && seenMessages.has(msgId)) return
  if (msgId) seenMessages.set(msgId, Date.now())

  const msg = data.data?.message
  if (!msg) return

  // --- Extract message text by type ---

  let messageText: string | null = null

  // Text
  if (msg.conversation) {
    messageText = msg.conversation
  } else if (msg.extendedTextMessage?.text) {
    messageText = msg.extendedTextMessage.text
  }
  // Audio
  else if (msg.audioMessage) {
    try {
      const transcription = await transcribeAudio(data.data.key)
      messageText = transcription
        ? `[audio transcrito]: ${transcription}`
        : null
    } catch (err) {
      process.stderr.write(`whatsapp channel: transcription failed: ${err}\n`)
      await sendEvolutionText(
        OWNER_WHATSAPP_NUMBER!,
        'Nao consegui transcrever o audio, tenta de novo.',
      )
      return
    }
  }
  // Unsupported
  else {
    await sendEvolutionText(
      OWNER_WHATSAPP_NUMBER!,
      'Zel so entende texto e audio por enquanto.',
    )
    return
  }

  if (!messageText || messageText.trim().length === 0) return
  const text = messageText.trim()

  // --- Permission reply intercept ---

  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const isAllow = YES_WORDS.has(permMatch[1]!.toLowerCase())
    await mcp.notification({
      method: 'notifications/claude/channel/permission' as any,
      params: {
        request_id: permMatch[2]!.toLowerCase(),
        behavior: isAllow ? 'allow' : 'deny',
      },
    })
    await sendEvolutionText(
      OWNER_WHATSAPP_NUMBER!,
      isAllow ? 'Permitido' : 'Negado',
    )
    return
  }

  // --- Forward to Claude Code session ---

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id: senderJid,
        user: senderNumber,
        ts: new Date().toISOString(),
        ...(msgId ? { message_id: msgId } : {}),
      },
    },
  })
}

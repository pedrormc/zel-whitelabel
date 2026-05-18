#!/usr/bin/env bun
/**
 * WhatsApp MCP server — provides the `reply` tool so Claude can send
 * messages back via Evolution API.
 *
 * This is a pure MCP server (stdio transport). No HTTP server.
 * The webhook-server.ts handles incoming webhooks separately.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'

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
    process.stderr.write(`whatsapp-mcp: failed to read ${ENV_FILE}: ${err}\n`)
  }
}

const EVOLUTION_URL = process.env.EVOLUTION_URL
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER

const REQUIRED: Record<string, string | undefined> = {
  EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY, OWNER_WHATSAPP_NUMBER,
}
for (const [key, val] of Object.entries(REQUIRED)) {
  if (!val) {
    process.stderr.write(`whatsapp-mcp: ${key} required — check ${ENV_FILE}\n`)
    process.exit(1)
  }
}

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
        `whatsapp-mcp: send HTTP ${res.status} attempt ${attempt + 1}: ${errBody}\n`,
      )
    } catch (err) {
      process.stderr.write(
        `whatsapp-mcp: send error attempt ${attempt + 1}: ${err}\n`,
      )
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
    }
  }
  process.stderr.write(
    `whatsapp-mcp: failed to send after ${RETRY_DELAYS.length + 1} attempts\n`,
  )
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'whatsapp', version: '2.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Mensagens do WhatsApp chegam como <channel source="whatsapp" chat_id="..." user="..." ts="...">.',
      'Responda SEMPRE com o tool reply — seu output no terminal NAO chega no WhatsApp.',
      'Passe o chat_id da tag <channel>.',
      '',
      'Regras de resposta:',
      '- PT-BR, casual e direto',
      '- Maximo 3 paragrafos curtos — e WhatsApp, nao email',
      '- Se a tarefa for longa, mande updates parciais via reply',
    ].join('\n'),
  },
)

// ---------------------------------------------------------------------------
// Tools — reply
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

        // Defense in depth: webhook should already normalize @lid → @s.whatsapp.net
        // before this reaches Claude. If a chat_id slips through in @lid format,
        // sendEvolutionText would build an invalid JID — reject early with a clear msg.
        const number = chat_id
          .replace(/@s\.whatsapp\.net$/, '')
          .replace(/:\d+$/, '')
        if (number.endsWith('@lid')) {
          throw new Error(
            `chat_id ${chat_id} is @lid format — expected @s.whatsapp.net (webhook should normalize upstream)`,
          )
        }
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
// Connect
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

process.on('unhandledRejection', err => {
  process.stderr.write(`whatsapp-mcp: unhandled rejection: ${err}\n`)
})

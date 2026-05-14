/**
 * Standalone Evolution API send utility (CommonJS).
 * Used by reminder-checker.js and proactive.js — scripts that run
 * outside the channel server but still need to send WhatsApp messages.
 */

require('dotenv').config();

const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;
const MAX_MSG_LENGTH = 3500;
const RETRY_DELAYS = [1000, 3000, 10000];

function splitMessage(text) {
  if (text.length <= MAX_MSG_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MSG_LENGTH);
    }
    if (splitAt === -1 || splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = MAX_MSG_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function sendSingleText(number, text) {
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
  const body = JSON.stringify({ number: `${number}@s.whatsapp.net`, text });
  const headers = {
    'Content-Type': 'application/json',
    apikey: EVOLUTION_APIKEY,
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.ok) return;
      const errBody = await res.text().catch(() => 'no body');
      console.error(`[evolution-send] HTTP ${res.status} attempt ${attempt + 1}:`, errBody);
    } catch (err) {
      console.error(`[evolution-send] Network error attempt ${attempt + 1}:`, err.message);
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  console.error(`[evolution-send] Failed after ${RETRY_DELAYS.length + 1} attempts to ${number}`);
}

async function sendText(number, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sendSingleText(number, chunk);
  }
}

module.exports = { sendText, splitMessage };

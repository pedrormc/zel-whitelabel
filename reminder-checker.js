require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendText } = require('./lib/evolution-send');

const HOME = process.env.HOME || process.env.USERPROFILE;
const ZEL_HOME = process.env.ZEL_HOME || path.join(HOME, 'zel');
const REMINDERS_FILE = path.join(ZEL_HOME, 'reminders.json');
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER;
const CHECK_INTERVAL = 60_000; // 60 seconds

function readReminders() {
  try {
    const data = fs.readFileSync(REMINDERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeReminders(reminders) {
  const tmp = REMINDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2));
  fs.renameSync(tmp, REMINDERS_FILE);
}

async function checkReminders() {
  const reminders = readReminders();
  if (reminders.length === 0) return;

  const now = new Date();
  const due = [];
  const remaining = [];

  for (const r of reminders) {
    const reminderTime = new Date(r.time);
    if (reminderTime <= now) {
      due.push(r);
    } else {
      remaining.push(r);
    }
  }

  if (due.length === 0) return;

  const MAX_RETRIES = 3;
  const MAX_AGE_MS = 30 * 60 * 1000; // Drop reminders older than 30min past due

  for (const r of due) {
    const age = now - new Date(r.time);
    const retries = r._retries || 0;

    // Drop if too old or too many retries
    if (age > MAX_AGE_MS || retries >= MAX_RETRIES) {
      console.log(`[reminders] Dropped (${retries >= MAX_RETRIES ? 'max retries' : 'expired'}): ${r.text}`);
      continue;
    }

    try {
      await sendText(OWNER_WHATSAPP_NUMBER, `Lembrete: ${r.text}`);
      console.log(`[reminders] Dispatched: ${r.text}`);
    } catch (err) {
      console.error(`[reminders] Failed to send (attempt ${retries + 1}): ${r.text}`, err.message);
      remaining.push({ ...r, _retries: retries + 1 });
    }
  }

  writeReminders(remaining);
}

// Run immediately, then every 60s
console.log('[zel-reminders] Started. Checking every 60s.');
checkReminders();
setInterval(checkReminders, CHECK_INTERVAL);

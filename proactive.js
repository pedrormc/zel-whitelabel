/**
 * Proactive features: daily briefing and day review.
 *
 * v2: Instead of spawning a separate Claude session, this script collects
 * data and POSTs to the channel server's /trigger endpoint. Claude processes
 * the prompt within the existing persistent session and replies via WhatsApp.
 *
 * Fallback: if the channel server is down, sends raw data directly via Evolution API.
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sendText } = require('./lib/evolution-send');

const HOME = process.env.HOME || process.env.USERPROFILE;
const VAULT_PATH = process.env.VAULT_PATH || path.join(HOME, 'obsidiano');
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER;
const CHANNEL_PORT = parseInt(process.env.PORT || '3333', 10);

const command = process.argv[2];

if (!command || !['daily-briefing', 'day-review', 'task-reminder'].includes(command)) {
  console.error('Usage: node proactive.js <daily-briefing|day-review|task-reminder>');
  process.exit(1);
}

async function triggerChannel(prompt) {
  const res = await fetch(`http://127.0.0.1:${CHANNEL_PORT}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, source: 'proactive' }),
  });
  if (!res.ok) throw new Error(`Channel trigger failed: HTTP ${res.status}`);
}

(async () => {
  try {
    if (command === 'daily-briefing') {
      await dailyBriefing();
    } else if (command === 'task-reminder') {
      await taskReminder();
    } else {
      await dayReview();
    }
  } catch (err) {
    console.error(`[proactive] ${command} failed:`, err.message);
    await sendText(OWNER_WHATSAPP_NUMBER, `Zel: ${command} falhou — ${err.message}`).catch(() => {});
  }
})();

async function dailyBriefing() {
  let todoContent = '';
  const todoPath = path.join(VAULT_PATH, 'tasks.md');
  try { todoContent = fs.readFileSync(todoPath, 'utf8'); } catch {}

  let reunioesContent = '';
  const reunioesDir = path.join(VAULT_PATH, 'Reuniões');
  try {
    const files = fs.readdirSync(reunioesDir).filter(f => f.endsWith('.md'));
    for (const f of files.slice(-3)) {
      reunioesContent += `### ${f}\n${fs.readFileSync(path.join(reunioesDir, f), 'utf8').slice(0, 500)}\n\n`;
    }
  } catch {}

  let remindersContent = '';
  const remindersPath = path.join(HOME, 'zel', 'reminders.json');
  try {
    const reminders = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    const dailyReminders = reminders.filter(r => r.type === 'daily');
    if (dailyReminders.length > 0) {
      remindersContent = dailyReminders.map(r => `- ${r.text}`).join('\n');
    }
  } catch {}

  const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

  const prompt = `[PROATIVO - Briefing do dia] Gere o briefing para o dono. Hoje e ${today}.

Tarefas pendentes:
${todoContent || '(nenhuma encontrada)'}

Lembretes diarios:
${remindersContent || '(nenhum)'}

Reunioes recentes:
${reunioesContent || '(nenhuma encontrada)'}

Formate curto pra WhatsApp. Use bullet points. Comece com "Bom dia, tudo bom!" e envie via reply tool.`;

  try {
    await triggerChannel(prompt);
    console.log('[proactive] Daily briefing triggered via channel.');
  } catch {
    console.error('[proactive] Channel unavailable, sending raw data.');
    await sendText(OWNER_WHATSAPP_NUMBER, `Bom dia, tudo bom! (Zel offline, dados crus)\n\n${todoContent.slice(0, 500) || 'Nenhuma tarefa encontrada.'}`);
  }
}

async function taskReminder() {
  const tasksPath = path.join(HOME, 'zel', 'today-tasks.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  } catch (err) {
    console.error('[proactive] task-reminder: cant read today-tasks.json', err.message);
    return;
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  if (data.date !== todayISO) {
    console.log(`[proactive] task-reminder: skipping (file date=${data.date}, today=${todayISO})`);
    return;
  }

  const pending = (data.tasks || []).filter(t => !t.done);
  if (pending.length === 0) {
    console.log('[proactive] task-reminder: all tasks done, skipping');
    return;
  }

  const taskList = (data.tasks || [])
    .map(t => `${t.done ? '[x]' : '[ ]'} ${t.id}. ${t.text}`)
    .join('\n');

  const prompt = `[PROATIVO - Lembrete de tarefas] O usuario pediu lembrete a cada 30min sobre as tarefas de hoje. Pergunta de forma curta e direta como tá o progresso. Lista atual:

${taskList}

Pendentes: ${pending.length} de ${data.tasks.length}.

Curto (max 4 linhas), tom casual, pede pra ele te dizer quais já fechou pra você atualizar o status. NAO mande a lista completa de novo a menos que ele peça. Envie via reply tool.`;

  try {
    await triggerChannel(prompt);
    console.log('[proactive] Task reminder triggered via channel.');
  } catch {
    console.error('[proactive] Channel unavailable, sending raw reminder.');
    await sendText(OWNER_WHATSAPP_NUMBER, `Lembrete: ${pending.length} tarefas pendentes hoje. Quais já fechou?`);
  }
}

async function dayReview() {
  let gitLog = '';
  try {
    gitLog = execSync('git log --since="today 00:00" --oneline --no-decorate', {
      cwd: VAULT_PATH,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch {}

  const prompt = `[PROATIVO - Review do dia] Gere o review do dia para o dono.

Mudancas no vault hoje:
${gitLog || '(nenhuma mudanca no vault hoje)'}

Resuma: o que foi feito, o que ficou pendente, o que precisa de atencao amanha.
Formate curto pra WhatsApp. Use bullet points. Comece com "Review do dia:" e envie via reply tool.`;

  try {
    await triggerChannel(prompt);
    console.log('[proactive] Day review triggered via channel.');
  } catch {
    console.error('[proactive] Channel unavailable, sending raw data.');
    await sendText(OWNER_WHATSAPP_NUMBER, `Review do dia: (Zel offline)\n\n${gitLog || 'Nenhuma mudanca no vault hoje.'}`);
  }
}

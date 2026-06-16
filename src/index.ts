import { Hono } from "hono";
import { extract, transcribe, type MealEntry } from "./openai";
import {
  append,
  overwrite,
  readDay,
  readDiario,
  readMensual,
  readSemanal,
  type DiarioRow,
  type PeriodoRow,
  type SheetClient,
} from "./sheets";
import { downloadFile, getFilePath } from "./telegram";

type Bindings = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  SHEETS_WEBAPP_URL: string;
  SHEETS_API_SECRET: string;
};

const TZ = "America/Argentina/Buenos_Aires";

// Today's date in Buenos Aires time as ISO YYYY-MM-DD (en-CA formats exactly that).
function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Human-readable current BA datetime with weekday, for the OpenAI context:
// e.g. "2026-06-15 14:30 (domingo)".
function nowBA(): string {
  const date = todayISO();
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const weekday = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long" }).format(new Date());
  return `${date} ${time} (${weekday})`;
}

// "La anterior más cercana" según la hora de Buenos Aires. Es un HINT para el agente
// (devuelve fecha + comida); antes de las 06 => Cena del día anterior.
function comidaHint(): { fecha: string; comida: string } {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()),
  );
  if (h < 6) {
    const [y, m, d] = todayISO().split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    return { fecha: prev.toISOString().slice(0, 10), comida: "Cena" };
  }
  let comida = "Desayuno";
  if (h >= 19) comida = "Cena";
  else if (h >= 16) comida = "Merienda";
  else if (h >= 12) comida = "Almuerzo";
  return { fecha: todayISO(), comida };
}

function sheetClient(env: Bindings): SheetClient {
  return { url: env.SHEETS_WEBAPP_URL, secret: env.SHEETS_API_SECRET };
}

// --- Telegram helpers ---

type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

async function tg(token: string, method: string, body: object): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reply(
  token: string,
  chatId: number,
  text: string,
  opts: { keyboard?: InlineKeyboard; replyTo?: number } = {},
): Promise<void> {
  return tg(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: opts.keyboard,
    reply_to_message_id: opts.replyTo,
  });
}

// Replace a message's text and drop its buttons (so it can't be tapped twice).
function editText(token: string, chatId: number, messageId: number, text: string): Promise<void> {
  return tg(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
}

function answerCallback(token: string, callbackId: string): Promise<void> {
  return tg(token, "answerCallbackQuery", { callback_query_id: callbackId });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summary(entry: MealEntry): string {
  return `📅 ${entry.fecha} · 🍽️ ${entry.comida} · 📍 ${entry.modo} · ⭐ ${entry.calificacion}\n📝 ${entry.notas}`;
}

// Technical footer for dev use: which sheet op ran and on which row.
function tech(op: string, row: number): string {
  return `\n<code>${op} · fila ${row}</code>`;
}

// --- Cierres de ciclo (recaps) ---
// La Cena es el último momento del día. Al guardarla (append), si cierra día/semana/mes,
// le mandamos el resumen de ese período usando las views del Apps Script.

function fmtDiario(r: DiarioRow): string {
  const line = (emoji: string, label: string, val: string) => `${emoji} <b>${label}:</b> ${val || "—"}`;
  const parts = [
    `🌙 <b>Cierre del día ${r.fecha}</b>`,
    line("☀️", "Desayuno", r.desayuno),
    line("🍽️", "Almuerzo", r.almuerzo),
    line("🧉", "Merienda", r.merienda),
    line("🌆", "Cena", r.cena),
    `⭐ <b>Score del día:</b> ${r.score}`,
  ];
  if (r.evento) parts.push(`🎉 ${r.evento}`);
  return parts.join("\n");
}

function fmtPeriodo(titulo: string, emoji: string, r: PeriodoRow): string {
  const parts = [`${emoji} <b>Cierre ${titulo}: ${r.label}</b>`, `⭐ <b>Promedio:</b> ${r.promedio}`];
  if (r.eventos) parts.push(`🎉 ${r.eventos}`);
  return parts.join("\n");
}

// Parse a YYYY-MM-DD into UTC-safe parts (no timezone drift for weekday/last-day math).
function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

// After appending a Cena, send the recaps for the cycles it closes (day, + week if Sunday,
// + month if last day of the month). Based on the meal's fecha, so a late "ayer" cena still works.
async function sendCierres(env: Bindings, chatId: number, fecha: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const client = sheetClient(env);

  // Día: buscar la fila de esa fecha en la view diario (ventana corta por las dudas).
  const dia = (await readDiario(client, 7)).find((r) => r.fecha === fecha);
  if (dia) await reply(token, chatId, fmtDiario(dia));

  const { y, m, d } = parseISO(fecha);

  // Semana: si la cena es domingo (getUTCDay() === 0), cierra la semana.
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) {
    const [sem] = await readSemanal(client, 1);
    if (sem) await reply(token, chatId, fmtPeriodo("semana", "📊", sem));
  }

  // Mes: si es el último día del mes, cierra el mes. Día 0 del mes siguiente = último del actual.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d === lastDay) {
    const [mes] = await readMensual(client, 1);
    if (mes) await reply(token, chatId, fmtPeriodo("mes", "📈", mes));
  }
}

// --- Types for the incoming update ---

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  voice?: { file_id: string };
  audio?: { file_id: string };
  reply_to_message?: { text?: string };
}

// Resolve the user's text from a message: plain text, or a transcribed voice/audio note.
// `voice` is set only when the text came from transcription (so we can echo it for debugging).
// Returns { text: null } if the message carries neither text nor audio.
async function messageText(env: Bindings, msg: TgMessage): Promise<{ text: string | null; voice: boolean }> {
  if (msg.text) return { text: msg.text, voice: false };
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (!fileId) return { text: null, voice: false };
  const path = await getFilePath(env.TELEGRAM_BOT_TOKEN, fileId);
  const audio = await downloadFile(env.TELEGRAM_BOT_TOKEN, path);
  return { text: await transcribe(env.OPENAI_API_KEY, audio), voice: true };
}

// Dev footer echoing what we transcribed from a voice note (empty for plain text).
function transcriptNote(userText: string, voice: boolean): string {
  return voice ? `\n<code>🎤 ${escapeHtml(userText)}</code>` : "";
}

// Marker baked into the "editing" prompt so a reply can recover the row (stateless).
const EDIT_RE = /Editando la fila (\d+)/;
// Transcript echoed in the collision message (see transcriptNote); lets a callback re-extract
// from a voice note that has no `reply_to_message.text` of its own (stateless).
const TRANSCRIPT_RE = /🎤 (.+)$/;
const editKeyboard = (row: number): InlineKeyboard => ({
  inline_keyboard: [[{ text: "✏️ Editar", callback_data: `ed:${row}` }]],
});
interface TgCallback {
  id: string;
  data?: string;
  message: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { text?: string } };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("meal-tracker ok"));

app.post("/webhook", async (c) => {
  if (c.req.header("x-telegram-bot-api-secret-token") !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }

  const update = (await c.req.json()) as { message?: TgMessage; callback_query?: TgCallback };
  const env = c.env;

  try {
    if (update.callback_query) {
      await handleCallback(env, update.callback_query);
    } else if (update.message) {
      await handleMessage(env, update.message);
    }
  } catch (err) {
    console.error(err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message.chat.id;
    if (chatId) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await reply(env.TELEGRAM_BOT_TOKEN, chatId, `❌ <b>Error</b>\n<pre>${escapeHtml(detail)}</pre>`);
    }
  }

  return c.json({ ok: true });
});

async function handleMessage(env: Bindings, msg: TgMessage): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const { text: userText, voice } = await messageText(env, msg);
  if (!userText) {
    await reply(token, msg.chat.id, "Mandame un texto o una nota de voz describiendo la comida 📝🎤");
    return;
  }
  const note = transcriptNote(userText, voice);

  const now = nowBA();
  const hint = comidaHint();

  // Is this a reply to an "editing row N" prompt? → overwrite that row with the correction.
  const editMatch = msg.reply_to_message?.text?.match(EDIT_RE);
  if (editMatch) {
    const row = Number(editMatch[1]);
    const corrected = await extract(env.OPENAI_API_KEY, userText, now, hint);
    await overwrite(sheetClient(env), row, corrected);
    await reply(
      token,
      msg.chat.id,
      `✏️ <b>Editado</b>\n${summary(corrected)}${note}${tech("overwrite", row)}`,
      { keyboard: editKeyboard(row) },
    );
    return;
  }

  const entry = await extract(env.OPENAI_API_KEY, userText, now, hint);

  // Incomplete or ambiguous → ask, do NOT save.
  if (entry.aclaraciones.length > 0 || !entry.comida || !entry.modo || !entry.calificacion) {
    const v = (x: string) => (x ? x : "❓ no está claro");
    const lines = [
      "Esto entendí, pero falta confirmar algo:",
      `📅 <b>Fecha:</b> ${entry.fecha}`,
      `🍽️ <b>Comida:</b> ${v(entry.comida)}`,
      `📍 <b>Modo:</b> ${v(entry.modo)}`,
      `⭐ <b>Calificación:</b> ${v(entry.calificacion)}`,
      `📝 <b>Notas:</b> ${v(entry.notas)}`,
      "",
      "❓ <b>Para confirmar:</b>",
      ...entry.aclaraciones.map((a) => `• ${a}`),
    ];
    await reply(token, msg.chat.id, lines.join("\n") + note);
    return;
  }

  // Read-before-write: is there already an entry for this Comida on the target date?
  const existing = (await readDay(sheetClient(env), entry.fecha)).find((e) => e.comida === entry.comida);

  if (existing) {
    // Don't decide silently — ask. Row number rides in the callback_data (stateless).
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: "✏️ Reemplazar", callback_data: `ow:${existing.row}` },
          { text: "✖️ Cancelar", callback_data: "no" },
        ],
      ],
    };
    await reply(
      token,
      msg.chat.id,
      [
        `⚠️ Ya tenías <b>${entry.comida}</b> el ${entry.fecha}:`,
        `   ${existing.notas}`,
        "",
        "Lo nuevo sería:",
        `   ${entry.notas} (${entry.modo} · ${entry.calificacion})`,
        "",
        "¿Qué hago?",
      ].join("\n") + note,
      { keyboard, replyTo: msg.message_id }, // reply_to lets the callback re-read this text
    );
    return;
  }

  // No collision → save directly.
  const row = await append(sheetClient(env), entry);
  await reply(token, msg.chat.id, `✅ <b>Guardado</b>\n${summary(entry)}${note}${tech("append", row)}`, {
    keyboard: editKeyboard(row),
  });

  // Si la Cena cierra el día (y quizá semana/mes), mandar los recaps.
  if (entry.comida === "Cena") {
    await sendCierres(env, msg.chat.id, entry.fecha);
  }
}

async function handleCallback(env: Bindings, cq: TgCallback): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  await answerCallback(token, cq.id); // stop the button's loading spinner

  if (cq.data === "no") {
    await editText(token, chatId, messageId, "✖️ Cancelado, no guardé nada.");
    return;
  }

  // Edit: ask for the corrected version. The row is baked into the prompt text so the
  // user's reply can recover it (see EDIT_RE in handleMessage).
  if (cq.data?.startsWith("ed:")) {
    const row = Number(cq.data.slice(3));
    await editText(
      token,
      chatId,
      messageId,
      `✏️ <b>Editando la fila ${row}</b>\nRespondé a este mensaje con la versión corregida.`,
    );
    return;
  }

  // Re-extract from the original message the buttons replied to (stateless: no stored draft).
  // For text the original message carries it; for a voice note it has no text, so fall back to
  // the transcript echoed in this collision message's own footer (🎤 ...).
  const origText =
    cq.message.reply_to_message?.text || cq.message.text?.match(TRANSCRIPT_RE)?.[1];
  if (!origText) {
    await editText(token, chatId, messageId, "❌ Perdí el mensaje original, reenvialo por favor.");
    return;
  }

  const entry = await extract(env.OPENAI_API_KEY, origText, nowBA(), comidaHint());

  if (cq.data?.startsWith("ow:")) {
    const row = Number(cq.data.slice(3));
    await overwrite(sheetClient(env), row, entry);
    await editText(
      token,
      chatId,
      messageId,
      `✏️ <b>Reemplazado</b>\n${summary(entry)}${tech("overwrite", row)}`,
    );
  }
}

export default app;

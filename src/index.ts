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
  type SheetEntry,
} from "./sheets";
import { downloadFile, getFilePath } from "./telegram";
import {
  comidaHintAt,
  diff,
  escapeHtml,
  formatRecientes,
  isSavedMeal,
  parseRow,
  parseSummary,
  prevISO,
  summary,
  type Hint,
} from "./logic";

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

// Thin wrapper over comidaHintAt that reads the current BA hour/date. The pure logic lives
// in logic.ts so it can be unit-tested deterministically.
function comidaHint(hoy: SheetEntry[], ayer: SheetEntry[]): Hint {
  const hora = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()),
  );
  return comidaHintAt(hoy, ayer, hora, todayISO());
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

// Remove a message's inline buttons without touching its text (avoids double-tap on a
// resolved proposal, while keeping the message for traceability).
async function dropButtons(token: string, chatId: number, messageId: number): Promise<void> {
  try {
    await tg(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    // Ignore "message is not modified" / already buttonless.
  }
}

function answerCallback(token: string, callbackId: string): Promise<void> {
  return tg(token, "answerCallbackQuery", { callback_query_id: callbackId });
}

// Lines shown when an entry is incomplete/ambiguous (asks the user to confirm).
function askLines(entry: MealEntry): string[] {
  const v = (x: string) => (x ? x : "❓ no está claro");
  return [
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
}

// Visible (not collapsed) sheet action footer; goes above the collapsed LLM context.
// LOAD-BEARING FORMAT: parseRow recovers the row from "op · fila N".
function tech(op: string, row: number): string {
  return `\nacciones: <code>${op} · fila ${row}</code>`;
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

// Inner text echoing the ORIGINAL user message (a transcript for voice, the text otherwise).
// Always shown so any saved/proposed message can be replied to with full context.
function mensajeNote(userText: string, voice: boolean): string {
  return `${voice ? "🎤 transcript" : "💬 mensaje"}: ${escapeHtml(userText)}`;
}

// Inner text showing the context fed to the model (pending-meals hint + recent meals), for debugging.
function ctxNote(hintTexto: string, recientes: string): string {
  const lines = [`hint: ${hintTexto}`];
  if (recientes) lines.push("recientes:", recientes);
  return escapeHtml(lines.join("\n"));
}

// Wrap the LLM context bits (transcript + hint + recent meals) in one expandable blockquote
// so they show collapsed by default. Only the "🧩 Contexto del LLM" header shows until
// expanded. Skips empty parts; returns "" if nothing to show.
function llmFooter(...parts: string[]): string {
  const body = parts.filter(Boolean).join("\n");
  if (!body) return "";
  return `\n<blockquote expandable>🧩 Contexto del LLM\n\n\n<code>${body}</code></blockquote>`;
}

// Proposal buttons. Accept carries the target row; the proposed entry is re-parsed from the
// message's summary() on accept (stateless). Both edits and collisions are overwrites.
const proposalKeyboard = (row: number): InlineKeyboard => ({
  inline_keyboard: [
    [
      { text: "✅ Aceptar", callback_data: `ok:overwrite:${row}` },
      { text: "✖️ Rechazar", callback_data: "no" },
    ],
  ],
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
  const note = mensajeNote(userText, voice);
  const client = sheetClient(env);

  const now = nowBA();
  const today = todayISO();
  const yesterday = prevISO(today);
  const [hoyEntries, ayerEntries] = await Promise.all([readDay(client, today), readDay(client, yesterday)]);
  const hint = comidaHint(hoyEntries, ayerEntries);
  const recientes = formatRecientes([
    { fecha: yesterday, entries: ayerEntries },
    { fecha: today, entries: hoyEntries },
  ]);
  const ctx = ctxNote(hint.texto, recientes);

  // Replying to a saved-meal message is just strong context now (not a forced edit): we hand
  // that record to the model, and it decides agregar vs editar like for any other message.
  const repliedText = msg.reply_to_message?.text;
  const repliedSaved = repliedText && isSavedMeal(repliedText);
  const repliedEntry = repliedSaved ? parseSummary(repliedText) : null;
  const repliedRow = repliedSaved ? parseRow(repliedText) : null;

  const entry = await extract(
    env.OPENAI_API_KEY,
    userText,
    now,
    hint.texto,
    recientes,
    repliedEntry ? summary(repliedEntry) : "",
  );

  // Incomplete or ambiguous → ask, do NOT save.
  if (entry.aclaraciones.length > 0 || !entry.comida || !entry.modo || !entry.calificacion) {
    await reply(token, msg.chat.id, askLines(entry).join("\n") + llmFooter(note, ctx));
    return;
  }

  // Locate the row this would touch. A reply targets its exact row (handles a comida change);
  // otherwise we match the same comida already logged that date. If the model chose "agregar"
  // we still only treat a same-comida match as a collision (don't redirect a reply's row).
  const dayEntries = await readDay(client, entry.fecha);
  const byMatch = dayEntries.find((e) => e.comida === entry.comida);
  const byReply = repliedRow ? dayEntries.find((e) => e.row === repliedRow) : undefined;
  const target = entry.accion === "editar" ? (byReply ?? byMatch) : byMatch;

  // Edit, or a new meal that collides with an existing one → propose an overwrite to
  // accept/reject (never write silently). Both are "overwrite"; only clean appends auto-save.
  if (target) {
    const baseEntry: MealEntry = {
      fecha: entry.fecha,
      comida: target.comida,
      modo: target.modo,
      calificacion: target.calificacion,
      notas: target.notas,
      aclaraciones: [],
      accion: "editar",
    };
    const titulo =
      entry.accion === "editar"
        ? `✏️ <b>Propuesta de edición</b> (fila ${target.row})`
        : `⚠️ Ya tenías <b>${entry.comida}</b> el ${entry.fecha}. Propuesta de reemplazo:`;
    await reply(
      token,
      msg.chat.id,
      `${titulo}\n${diff(baseEntry, entry)}\n\n${summary(entry)}${tech("overwrite", target.row)}${llmFooter(note, ctx)}`,
      { keyboard: proposalKeyboard(target.row), replyTo: msg.message_id },
    );
    return;
  }

  // No target → save directly (new meals don't need accept/reject).
  const row = await append(client, entry);
  await reply(token, msg.chat.id, `✅ <b>Guardado</b>\n${summary(entry)}${tech("append", row)}${llmFooter(note, ctx)}`);

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

  // Reject: keep the proposal text for the record, just drop its buttons.
  if (cq.data === "no") {
    await dropButtons(token, chatId, messageId);
    await reply(token, chatId, "✖️ Descartado.", { replyTo: messageId });
    return;
  }

  // Accept: re-parse the proposed entry from the message's summary() and apply it.
  if (cq.data?.startsWith("ok:overwrite:")) {
    const row = Number(cq.data.split(":")[2]);
    const prop = parseSummary(cq.message.text ?? "");
    if (!prop) {
      await reply(token, chatId, "❌ No pude leer la propuesta, reenviá la corrección.", { replyTo: messageId });
      return;
    }
    await overwrite(sheetClient(env), row, prop);
    await dropButtons(token, chatId, messageId);
    await reply(token, chatId, `✅ <b>Aplicado</b>\n${summary(prop)}${tech("overwrite", row)}`, { replyTo: messageId });

    // Si la edición deja una Cena, recalcular los recaps del ciclo.
    if (prop.comida === "Cena") {
      await sendCierres(env, chatId, prop.fecha);
    }
  }
}

export default app;

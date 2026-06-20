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

const ORDEN = ["Desayuno", "Almuerzo", "Merienda", "Cena"];

// Yesterday's ISO date relative to a YYYY-MM-DD date.
function prevISO(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// HINT (fecha + comida) para el agente, según la hora de Buenos Aires.
// Antes de las 06 => Cena del día anterior. De día, la hora da un "techo" (la comida más
// tardía plausible) y, como las comidas se cargan en orden, el hint es la PRIMERA comida
// faltante hoy hasta ese techo (ej: 18h con Almuerzo sin cargar => Almuerzo, no Merienda).
// `hoy` son las comidas ya cargadas hoy (tab Comidas).
function comidaHint(hoy: SheetEntry[]): { fecha: string; comida: string } {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()),
  );
  if (h < 6) return { fecha: prevISO(todayISO()), comida: "Cena" };
  let techo = 0; // Desayuno
  if (h >= 19) techo = 3;
  else if (h >= 16) techo = 2;
  else if (h >= 12) techo = 1;
  const cargadas = new Set(hoy.map((e) => e.comida));
  // Primera comida OBLIGATORIA faltante hasta el techo (la merienda, índice 2, es opcional y
  // no cuenta como faltante). Si no falta ninguna, usar la comida del techo.
  const idx = ORDEN.slice(0, techo + 1).findIndex((c, i) => i !== 2 && !cargadas.has(c));
  return { fecha: todayISO(), comida: ORDEN[idx === -1 ? techo : idx] };
}

// Compact block of recent meals (one line per day) to give the model context.
function formatRecientes(days: { fecha: string; entries: SheetEntry[] }[]): string {
  return days
    .map(({ fecha, entries }) => {
      const items = entries.length
        ? entries.map((e) => `${e.comida}: ${e.notas}`).join("; ")
        : "(sin registros)";
      return `${fecha}: ${items}`;
    })
    .join("\n");
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// LOAD-BEARING FORMAT: parseSummary re-parses this exact layout from proposal messages to
// recover the entry on accept (stateless). Keep fecha/comida/modo/calificacion on line 1 and
// notas on its own line; don't reorder without updating parseSummary.
function summary(entry: MealEntry): string {
  return `📅 ${entry.fecha} · 🍽️ ${entry.comida} · 📍 ${entry.modo} · ⭐ ${entry.calificacion}\n📝 ${entry.notas}`;
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

// Recover the entry from a message built with summary(). Returns null if it doesn't match.
// The header line and the notas line must be adjacent (summary()'s exact layout), so a diff
// block above it — whose lines look like "📝 viejo → nuevo" — can't be mistaken for it.
function parseSummary(text: string): MealEntry | null {
  const m = text.match(/📅 (\S+) · 🍽️ (\S+) · 📍 (\S+) · ⭐ (\S+)\n📝 ([^\n]*)/);
  if (!m) return null;
  return { fecha: m[1], comida: m[2], modo: m[3], calificacion: m[4], notas: m[5].trim(), aclaraciones: [] };
}

// LOAD-BEARING FORMAT: parseRow recovers the row from this footer. Keep "op · fila N".
function tech(op: string, row: number): string {
  return `\n<code>${op} · fila ${row}</code>`;
}

function parseRow(text: string): number | null {
  const m = text.match(/(?:append|overwrite) · fila (\d+)/);
  return m ? Number(m[1]) : null;
}

// A saved-meal message carries a date line and a "fila N" footer; lets a reply target its row.
function isSavedMeal(text: string): boolean {
  return /📅 \d{4}-\d{2}-\d{2}/.test(text) && parseRow(text) !== null;
}

// Lines for the fields that change between the saved entry and the proposal.
function diff(base: MealEntry, prop: MealEntry): string {
  const rows: [string, string, string][] = [
    ["📅", base.fecha, prop.fecha],
    ["🍽️", base.comida, prop.comida],
    ["📍", base.modo, prop.modo],
    ["⭐", base.calificacion, prop.calificacion],
    ["📝", base.notas, prop.notas],
  ];
  const changed = rows
    .filter(([, a, b]) => a !== b)
    .map(([e, a, b]) => `${e} ${a || "—"} → <b>${b || "—"}</b>`);
  return changed.length ? changed.join("\n") : "(sin cambios)";
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

// Dev footer showing the context fed to the model (hint + recent meals), for debugging.
function ctxNote(hint: { fecha: string; comida: string }, recientes: string): string {
  const lines = [`🧩 hint: ${hint.comida} ${hint.fecha}`];
  if (recientes) lines.push("recientes:", recientes);
  return `\n<code>${escapeHtml(lines.join("\n"))}</code>`;
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
  const note = transcriptNote(userText, voice);

  const now = nowBA();
  const today = todayISO();
  const yesterday = prevISO(today);
  const [hoyEntries, ayerEntries] = await Promise.all([
    readDay(sheetClient(env), today),
    readDay(sheetClient(env), yesterday),
  ]);
  const hint = comidaHint(hoyEntries);
  const recientes = formatRecientes([
    { fecha: yesterday, entries: ayerEntries },
    { fecha: today, entries: hoyEntries },
  ]);
  const ctx = ctxNote(hint, recientes);

  // Reply to a saved-meal message? → treat the text as a correction of that row, with the
  // saved entry as context. Emit a proposal to accept/reject (does not write yet).
  const repliedText = msg.reply_to_message?.text;
  if (repliedText && isSavedMeal(repliedText)) {
    const row = parseRow(repliedText);
    const fecha = parseSummary(repliedText)?.fecha;
    const base = row && fecha ? (await readDay(sheetClient(env), fecha)).find((e) => e.row === row) : undefined;
    if (!row || !fecha || !base) {
      await reply(token, msg.chat.id, "No pude releer ese registro para editarlo (¿fuera de la ventana de 7 días?).");
      return;
    }
    const baseEntry: MealEntry = { fecha, comida: base.comida, modo: base.modo, calificacion: base.calificacion, notas: base.notas, aclaraciones: [] };
    const prop = await extract(env.OPENAI_API_KEY, userText, now, hint, recientes, baseEntry);
    if (prop.aclaraciones.length > 0) {
      await reply(token, msg.chat.id, askLines(prop).join("\n") + note);
      return;
    }
    await reply(
      token,
      msg.chat.id,
      `✏️ <b>Propuesta de edición</b> (fila ${row})\n${diff(baseEntry, prop)}\n\n${summary(prop)}${note}${tech("overwrite", row)}`,
      { keyboard: proposalKeyboard(row), replyTo: msg.message_id },
    );
    return;
  }

  const entry = await extract(env.OPENAI_API_KEY, userText, now, hint, recientes);

  // Incomplete or ambiguous → ask, do NOT save.
  if (entry.aclaraciones.length > 0 || !entry.comida || !entry.modo || !entry.calificacion) {
    await reply(token, msg.chat.id, askLines(entry).join("\n") + note + ctx);
    return;
  }

  // Read-before-write: is there already an entry for this Comida on the target date?
  const existing = (await readDay(sheetClient(env), entry.fecha)).find((e) => e.comida === entry.comida);

  if (existing) {
    // Don't decide silently — propose a replacement to accept/reject (same mechanism as edits).
    const existingEntry: MealEntry = {
      fecha: entry.fecha,
      comida: existing.comida,
      modo: existing.modo,
      calificacion: existing.calificacion,
      notas: existing.notas,
      aclaraciones: [],
    };
    await reply(
      token,
      msg.chat.id,
      `⚠️ Ya tenías <b>${entry.comida}</b> el ${entry.fecha}. Propuesta de reemplazo:\n${diff(existingEntry, entry)}\n\n${summary(entry)}${note}${tech("overwrite", existing.row)}`,
      { keyboard: proposalKeyboard(existing.row), replyTo: msg.message_id },
    );
    return;
  }

  // No collision → save directly (new meals don't need accept/reject).
  const row = await append(sheetClient(env), entry);
  await reply(token, msg.chat.id, `✅ <b>Guardado</b>\n${summary(entry)}${note}${ctx}${tech("append", row)}`);

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

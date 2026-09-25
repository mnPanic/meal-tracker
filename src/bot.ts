// The bot's behavior: from a Telegram update to sheet writes and replies. Every side effect goes
// through the interfaces in ports.ts, so tests drive this with fakes (see test/bot.test.ts).

import type { MealEntry } from "./openai";
import type { Chat, Clock, InlineKeyboard, Llm, MealStore } from "./ports";
import type { DiarioRow, PeriodoRow } from "./sheets";
import {
  validateMealWrite,
  diff,
  escapeHtml,
  formatRecientes,
  isSavedMeal,
  parseRow,
  parseSummary,
  prevISO,
  summary,
} from "./logic";

export interface BotDeps {
  llm: Llm;
  store: MealStore;
  chat: Chat;
  clock: Clock;
}

// --- Types for the incoming update ---

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  voice?: { file_id: string };
  audio?: { file_id: string };
  reply_to_message?: { text?: string };
}

export interface TgCallback {
  id: string;
  data?: string;
  message: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { text?: string } };
}

export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };

const TZ = "America/Argentina/Buenos_Aires";
const LOOKBACK_DAYS = 7;

// Date in Buenos Aires time as ISO YYYY-MM-DD (en-CA formats exactly that).
function isoBA(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Human-readable BA datetime with weekday, for the OpenAI context:
// e.g. "2026-06-15 14:30 (domingo)".
function nowBA(date: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const weekday = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long" }).format(date);
  return `${isoBA(date)} ${time} (${weekday})`;
}

// Lines shown when an entry is incomplete/ambiguous (asks the user to confirm).
function askLines(entry: MealEntry): string[] {
  const v = (x: string) => (x ? escapeHtml(x) : "❓ no está claro");
  return [
    "Esto entendí, pero falta confirmar algo:",
    `📅 <b>Fecha:</b> ${entry.fecha}`,
    `🍽️ <b>Comida:</b> ${v(entry.comida)}`,
    `📍 <b>Modo:</b> ${v(entry.modo)}`,
    `⭐ <b>Calificación:</b> ${v(entry.calificacion)}`,
    `📝 <b>Notas:</b> ${v(entry.notas)}`,
    "",
    "❓ <b>Para confirmar:</b>",
    ...entry.aclaraciones.map((a) => `• ${escapeHtml(a)}`),
  ];
}

// Visible (not collapsed) sheet action footer; goes above the collapsed LLM context.
// LOAD-BEARING FORMAT: parseRow recovers the row from "op · fila N".
function tech(op: string, row: number): string {
  return `\nacciones: <code>${op} · fila ${row}</code>`;
}

// --- Cierres de ciclo (recaps) ---
// La Cena es el último momento del día. Al guardarla, si cierra día/semana/mes, le mandamos
// el resumen de ese período usando las views del Apps Script.

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

// Inner text echoing the ORIGINAL user message (a transcript for voice, the text otherwise).
// Always shown so any saved/proposed message can be replied to with full context.
function mensajeNote(userText: string, voice: boolean): string {
  return `${voice ? "🎤 transcript" : "💬 mensaje"}: ${escapeHtml(userText)}`;
}

// Wrap the LLM context bits (transcript + meal table) in one expandable blockquote
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

export function createBot({ llm, store, chat, clock }: BotDeps) {
  async function readContext() {
    const fechas = [isoBA(clock.now())];
    while (fechas.length < LOOKBACK_DAYS) fechas.push(prevISO(fechas[fechas.length - 1]));
    return Promise.all(fechas.toReversed().map(async (fecha) => ({
      fecha, entries: await store.readDay(fecha),
    })));
  }

  // After saving a Cena, send the recaps for the cycles it closes (day, + week if Sunday,
  // + month if last day of the month). Based on the meal's fecha, so a late "ayer" cena still works.
  async function sendCierres(chatId: number, fecha: string): Promise<void> {
    // Día: buscar la fila de esa fecha en la view diario (ventana corta por las dudas).
    const dia = (await store.readDiario(7)).find((r) => r.fecha === fecha);
    if (dia) await chat.send(chatId, fmtDiario(dia));

    const { y, m, d } = parseISO(fecha);

    // Semana: si la cena es domingo (getUTCDay() === 0), cierra la semana.
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) {
      const [sem] = await store.readSemanal(1);
      if (sem) await chat.send(chatId, fmtPeriodo("semana", "📊", sem));
    }

    // Mes: si es el último día del mes, cierra el mes. Día 0 del mes siguiente = último del actual.
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d === lastDay) {
      const [mes] = await store.readMensual(1);
      if (mes) await chat.send(chatId, fmtPeriodo("mes", "📈", mes));
    }
  }

  // Resolve the user's text from a message: plain text, or a transcribed voice/audio note.
  // `voice` is set only when the text came from transcription (so we can echo it for debugging).
  async function messageText(msg: TgMessage): Promise<{ text: string | null; voice: boolean }> {
    if (msg.text) return { text: msg.text, voice: false };
    const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
    if (!fileId) return { text: null, voice: false };
    return { text: await llm.transcribe(await chat.downloadFile(fileId)), voice: true };
  }

  async function handleMessage(msg: TgMessage): Promise<void> {
    const { text: userText, voice } = await messageText(msg);
    if (!userText) {
      await chat.send(msg.chat.id, "Mandame un texto o una nota de voz describiendo la comida 📝🎤");
      return;
    }
    const note = mensajeNote(userText, voice);

    const dias = await readContext();
    const recientes = formatRecientes(dias);
    const ctx = escapeHtml(recientes);

    // Every reply supplies the full message as context, including clarification questions.
    // Saved messages additionally identify the row an edit should target.
    const repliedText = msg.reply_to_message?.text;
    const repliedSaved = repliedText && isSavedMeal(repliedText);
    const repliedRow = repliedSaved ? parseRow(repliedText) : null;

    const entry = await llm.extract({ text: userText, now: nowBA(clock.now()), recientes, replied: repliedText ?? "" });

    // Incomplete or ambiguous → ask, do NOT save.
    if (entry.aclaraciones.length > 0 || !entry.comida || !entry.modo || !entry.calificacion) {
      await chat.send(msg.chat.id, askLines(entry).join("\n") + llmFooter(note, ctx));
      return;
    }

    // Locate the row this would touch. A reply targets its exact row (handles a comida change);
    // otherwise we match the same comida already logged that date. If the model chose "agregar"
    // we still only treat a same-comida match as a collision (don't redirect a reply's row).
    const dayEntries = await store.readDay(entry.fecha);
    const byMatch = dayEntries.find((e) => e.comida === entry.comida);
    const byReply = repliedRow ? dayEntries.find((e) => e.row === repliedRow) : undefined;
    const target = entry.accion === "editar" ? (byReply ?? byMatch) : byMatch;
    validateMealWrite(dias, entry, target?.row);

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
      await chat.send(
        msg.chat.id,
        `${titulo}\n${diff(baseEntry, entry)}\n\n${summary(entry)}${tech("overwrite", target.row)}${llmFooter(note, ctx)}`,
        { keyboard: proposalKeyboard(target.row), replyTo: msg.message_id },
      );
      return;
    }

    // No target → save directly (new meals don't need accept/reject).
    const row = await store.append(entry);
    await chat.send(msg.chat.id, `✅ <b>Guardado</b>\n${summary(entry)}${tech("append", row)}${llmFooter(note, ctx)}`);

    // Si la Cena cierra el día (y quizá semana/mes), mandar los recaps.
    if (entry.comida === "Cena") {
      await sendCierres(msg.chat.id, entry.fecha);
    }
  }

  async function handleCallback(cq: TgCallback): Promise<void> {
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    await chat.answerCallback(cq.id); // stop the button's loading spinner

    // Reject: keep the proposal text for the record, just drop its buttons.
    if (cq.data === "no") {
      await chat.dropButtons(chatId, messageId);
      await chat.send(chatId, "✖️ Descartado.", { replyTo: messageId });
      return;
    }

    // Accept: re-parse the proposed entry from the message's summary() and apply it.
    if (cq.data?.startsWith("ok:overwrite:")) {
      const row = Number(cq.data.split(":")[2]);
      const prop = parseSummary(cq.message.text ?? "");
      if (!prop) {
        await chat.send(chatId, "❌ No pude leer la propuesta, reenviá la corrección.", { replyTo: messageId });
        return;
      }
      const dias = await readContext();
      validateMealWrite(dias, prop, row);
      await store.overwrite(row, prop);
      await chat.dropButtons(chatId, messageId);
      await chat.send(chatId, `✅ <b>Aplicado</b>\n${summary(prop)}${tech("overwrite", row)}`, { replyTo: messageId });

      // Si la edición deja una Cena, recalcular los recaps del ciclo.
      if (prop.comida === "Cena") {
        await sendCierres(chatId, prop.fecha);
      }
    }
  }

  // Processes one update. On failure, reports the error in the chat and rethrows so the
  // Workflow instance is marked failed.
  async function handleUpdate(update: TgUpdate): Promise<void> {
    try {
      if (update.callback_query) {
        await handleCallback(update.callback_query);
      } else if (update.message) {
        await handleMessage(update.message);
      }
    } catch (err) {
      console.error(err);
      const chatId = update.message?.chat.id ?? update.callback_query?.message.chat.id;
      if (chatId) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        await chat.send(chatId, `❌ <b>Error</b>\n<pre>${escapeHtml(detail)}</pre>`);
      }
      throw err;
    }
  }

  return { handleUpdate };
}

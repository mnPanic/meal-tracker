// The bot's behavior: from a Telegram update to sheet writes and replies. Every side effect goes
// through the interfaces in ports.ts, so tests drive this with fakes (see test/bot.test.ts).

import type { MealEntry } from "./openai";
import type { Chat, Clock, InlineKeyboard, Llm, MealStore } from "./ports";
import type { DiarioRow, PeriodoRow } from "./sheets";
import {
  validateBatch,
  diff,
  escapeHtml,
  formatRecientes,
  isSavedMeal,
  parseItems,
  parseRow,
  prevISO,
  summary,
  type BatchItem,
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

const isComplete = (e: MealEntry) => e.aclaraciones.length === 0 && Boolean(e.comida && e.modo && e.calificacion);

// Lines shown when any entry is incomplete/ambiguous: every meal understood, marked ✅/❓, and
// the questions. Nothing is saved until all of them are clear (one line per meal on purpose:
// parseItems must not mistake these for proposals).
function askLines(entries: MealEntry[]): string[] {
  const v = (x: string) => (x ? escapeHtml(x) : "❓");
  return [
    "Esto entendí, pero falta confirmar algo antes de guardar:",
    "",
    ...entries.map((e, i) =>
      `${i + 1}. ${isComplete(e) ? "✅" : "❓"} 📅 ${v(e.fecha)} · 🍽️ ${v(e.comida)} · 📍 ${v(e.modo)} · ⭐ ${v(e.calificacion)} · 📝 ${escapeHtml(e.notas) || "—"}`),
    "",
    "❓ <b>Para confirmar:</b>",
    ...entries.flatMap((e) => e.aclaraciones).map((a) => `• ${escapeHtml(a)}`),
  ];
}

// "(2/3)" when a message is one of several for the same batch.
const nth = (i: number, n: number) => (n > 1 ? ` (${i + 1}/${n})` : "");

// Visible (not collapsed) sheet action footer; goes above the collapsed LLM context.
// LOAD-BEARING FORMAT: parseRow recovers the row from "op · fila N".
function tech(op: string, row?: number): string {
  return `\nacciones: <code>${row === undefined ? op : `${op} · fila ${row}`}</code>`;
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
// Always shown so any saved/proposed message can be replied to with full context. When the
// message replies to one of ours, the original is carried over from it plus this latest answer
// (only the latest), so a chain of clarifications never loses the original batch.
function mensajeNote(userText: string, voice: boolean, repliedText?: string): string {
  const flat = (t: string) => escapeHtml(t.replace(/\n\s*\n/g, "\n").trim());
  const original = repliedText?.match(/(💬 mensaje|🎤 transcript): ([\s\S]*?)(?=\n↩️ respuesta|\n\n|$)/);
  if (!original) return `${voice ? "🎤 transcript" : "💬 mensaje"}: ${flat(userText)}`;
  return `${original[1]}: ${escapeHtml(original[2])}\n↩️ respuesta${voice ? " 🎤" : ""}: ${flat(userText)}`;
}

// Wrap the LLM context bits (transcript + meal table) in one expandable blockquote
// so they show collapsed by default. Only the "🧩 Contexto del LLM" header shows until
// expanded. Skips empty parts; returns "" if nothing to show. Parts are separated by a blank
// line, which mensajeNote relies on to find the end of the original message.
function llmFooter(...parts: string[]): string {
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return "";
  return `\n<blockquote expandable>🧩 Contexto del LLM\n\n\n<code>${body}</code></blockquote>`;
}

// Proposal buttons. The items (entries + target rows) are re-parsed from the message text on
// accept, so nothing is stored between proposal and accept.
const proposalKeyboard: InlineKeyboard = {
  inline_keyboard: [
    [
      { text: "✅ Aceptar", callback_data: "ok" },
      { text: "✖️ Rechazar", callback_data: "no" },
    ],
  ],
};

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

    const dias = await readContext();
    const recientes = formatRecientes(dias);
    const ctx = escapeHtml(recientes);

    // Every reply supplies the full message as context, including clarification questions.
    // Saved messages additionally identify the row an edit should target.
    const repliedText = msg.reply_to_message?.text;
    const repliedSaved = repliedText && isSavedMeal(repliedText);
    const repliedRow = repliedSaved ? parseRow(repliedText) : null;
    const footer = llmFooter(mensajeNote(userText, voice, repliedText), ctx);

    const entries = await llm.extract({ text: userText, now: nowBA(clock.now()), recientes, replied: repliedText ?? "" });

    if (entries.length === 0) {
      await chat.send(msg.chat.id, `No encontré ninguna comida en el mensaje 🤔${footer}`, { replyTo: msg.message_id });
      return;
    }

    // Any meal incomplete or ambiguous → ask about the whole batch, save NOTHING.
    if (!entries.every(isComplete)) {
      await chat.send(msg.chat.id, askLines(entries).join("\n") + footer, { replyTo: msg.message_id });
      return;
    }

    // Locate the row each meal would touch. A reply to a saved meal targets its exact row
    // (handles a comida change); otherwise we match the same comida already logged that date.
    // If the model chose "agregar" we still only treat a same-comida match as a collision.
    const items = entries.map((entry) => {
      const dayEntries = dias.find((d) => d.fecha === entry.fecha)?.entries ?? [];
      const byMatch = dayEntries.find((e) => e.comida === entry.comida);
      const byReply = repliedRow && entries.length === 1 ? dayEntries.find((e) => e.row === repliedRow) : undefined;
      const target = entry.accion === "editar" ? (byReply ?? byMatch) : byMatch;
      return { entry, target };
    });
    validateBatch(dias, items.map(({ entry, target }) => ({ entry, row: target?.row })));

    // Edits, or new meals that collide with existing ones → propose the whole batch to
    // accept/reject (never overwrite silently). Only batches of clean appends auto-save.
    if (items.some((i) => i.target)) {
      const blocks = items.map(({ entry, target }, i) => {
        const n = entries.length > 1 ? `${i + 1}. ` : "";
        if (!target) return `${n}➕ <b>Nueva</b>\n${summary(entry)}${tech("append")}`;
        const base: MealEntry = { ...entry, comida: target.comida, modo: target.modo, calificacion: target.calificacion, notas: target.notas };
        const titulo = entry.accion === "editar"
          ? `✏️ <b>Propuesta de edición</b> (fila ${target.row})`
          : `⚠️ Ya tenías <b>${escapeHtml(entry.comida)}</b> el ${entry.fecha} (fila ${target.row})`;
        return `${n}${titulo}\n${diff(base, entry)}\n\n${summary(entry)}${tech("overwrite", target.row)}`;
      });
      await chat.send(msg.chat.id, blocks.join("\n\n") + footer, { keyboard: proposalKeyboard, replyTo: msg.message_id });
      return;
    }

    // No targets → save directly, one message per meal (each can be replied to for edits).
    for (const [i, { entry }] of items.entries()) {
      const row = await store.append(entry);
      await chat.send(msg.chat.id, `✅ <b>Guardado</b>${nth(i, items.length)}\n${summary(entry)}${tech("append", row)}${footer}`, { replyTo: msg.message_id });
    }
    await sendCierresFor(msg.chat.id, entries);
  }

  // Si alguna Cena cierra el día (y quizá semana/mes), mandar los recaps, una vez por fecha.
  async function sendCierresFor(chatId: number, entries: MealEntry[]): Promise<void> {
    const fechas = new Set(entries.filter((e) => e.comida === "Cena").map((e) => e.fecha));
    for (const fecha of fechas) await sendCierres(chatId, fecha);
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

    // Accept: re-parse the items from the message text and apply them in order. "ok:overwrite:N"
    // is the single-row button of proposals sent before batches; its text parses the same way.
    if (cq.data === "ok" || cq.data?.startsWith("ok:overwrite:")) {
      const items: BatchItem[] = parseItems(cq.message.text ?? "");
      if (items.length === 0) {
        await chat.send(chatId, "❌ No pude leer la propuesta, reenviá la corrección.", { replyTo: messageId });
        return;
      }
      const dias = await readContext();
      validateBatch(dias, items);
      await chat.dropButtons(chatId, messageId);
      for (const [i, { entry, row }] of items.entries()) {
        const written = row === undefined ? await store.append(entry) : await store.overwrite(row, entry);
        const op = row === undefined ? "append" : "overwrite";
        await chat.send(chatId, `✅ <b>Aplicado</b>${nth(i, items.length)}\n${summary(entry)}${tech(op, written)}`, { replyTo: messageId });
      }
      await sendCierresFor(chatId, items.map((i) => i.entry));
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

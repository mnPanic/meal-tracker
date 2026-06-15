import { Hono } from "hono";
import { extract, type MealEntry } from "./openai";
import { append, overwrite, readDay, type SheetClient } from "./sheets";

interface DateParts {
  y: number;
  m: number;
  d: number;
}

type Bindings = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  SHEETS_WEBAPP_URL: string;
  SHEETS_API_SECRET: string;
};

const TZ = "America/Argentina/Buenos_Aires";

// Today's date in Buenos Aires time, as parts.
function today(): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function fmtDate({ y, m, d }: DateParts): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}/${pad(m)}/${pad(d)}`;
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

function summary(entry: MealEntry, fecha: string): string {
  return `📅 ${fecha} · 🍽️ ${entry.comida} · 📍 ${entry.modo} · ⭐ ${entry.calificacion}\n📝 ${entry.notas}`;
}

// Technical footer for dev use: which sheet op ran and on which row.
function tech(op: string, row: number): string {
  return `\n<code>${op} · fila ${row}</code>`;
}

// --- Types for the incoming update ---

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { text?: string };
}

// Marker baked into the "editing" prompt so a reply can recover the row (stateless).
const EDIT_RE = /Editando la fila (\d+)/;
const editKeyboard = (row: number): InlineKeyboard => ({
  inline_keyboard: [[{ text: "✏️ Editar", callback_data: `ed:${row}` }]],
});
interface TgCallback {
  id: string;
  data?: string;
  message: { message_id: number; chat: { id: number }; reply_to_message?: { text?: string } };
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
  if (!msg.text) {
    await reply(token, msg.chat.id, "Mandame un texto describiendo la comida 📝");
    return;
  }

  const fecha = today();

  // Is this a reply to an "editing row N" prompt? → overwrite that row with the correction.
  const editMatch = msg.reply_to_message?.text?.match(EDIT_RE);
  if (editMatch) {
    const row = Number(editMatch[1]);
    const corrected = await extract(env.OPENAI_API_KEY, msg.text, fmtDate(fecha));
    await overwrite(sheetClient(env), row, corrected);
    await reply(
      token,
      msg.chat.id,
      `✏️ <b>Editado</b>\n${summary(corrected, fmtDate(fecha))}${tech("overwrite", row)}`,
      { keyboard: editKeyboard(row) },
    );
    return;
  }

  const entry = await extract(env.OPENAI_API_KEY, msg.text, fmtDate(fecha));

  // Incomplete or ambiguous → ask, do NOT save.
  if (entry.aclaraciones.length > 0 || !entry.comida || !entry.modo || !entry.calificacion) {
    const v = (x: string) => (x ? x : "❓ no está claro");
    const lines = [
      "Esto entendí, pero falta confirmar algo:",
      `📅 <b>Fecha:</b> ${fmtDate(fecha)}`,
      `🍽️ <b>Comida:</b> ${v(entry.comida)}`,
      `📍 <b>Modo:</b> ${v(entry.modo)}`,
      `⭐ <b>Calificación:</b> ${v(entry.calificacion)}`,
      `📝 <b>Notas:</b> ${v(entry.notas)}`,
      "",
      "❓ <b>Para confirmar:</b>",
      ...entry.aclaraciones.map((a) => `• ${a}`),
    ];
    await reply(token, msg.chat.id, lines.join("\n"));
    return;
  }

  // Read-before-write: is there already an entry for this Comida today?
  const existing = (await readDay(sheetClient(env))).find((e) => e.comida === entry.comida);

  if (existing) {
    // Don't decide silently — ask. Row number rides in the callback_data (stateless).
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: "✏️ Reemplazar", callback_data: `ow:${existing.row}` },
          { text: "➕ Agregar igual", callback_data: "ap" },
        ],
        [{ text: "✖️ Cancelar", callback_data: "no" }],
      ],
    };
    await reply(
      token,
      msg.chat.id,
      [
        `⚠️ Ya tenías <b>${entry.comida}</b> hoy:`,
        `   ${existing.notas}`,
        "",
        "Lo nuevo sería:",
        `   ${entry.notas} (${entry.modo} · ${entry.calificacion})`,
        "",
        "¿Qué hago?",
      ].join("\n"),
      { keyboard, replyTo: msg.message_id }, // reply_to lets the callback re-read this text
    );
    return;
  }

  // No collision → save directly.
  const row = await append(sheetClient(env), entry);
  await reply(token, msg.chat.id, `✅ <b>Guardado</b>\n${summary(entry, fmtDate(fecha))}${tech("append", row)}`, {
    keyboard: editKeyboard(row),
  });
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
  const origText = cq.message.reply_to_message?.text;
  if (!origText) {
    await editText(token, chatId, messageId, "❌ Perdí el mensaje original, reenvialo por favor.");
    return;
  }

  const fecha = today();
  const entry = await extract(env.OPENAI_API_KEY, origText, fmtDate(fecha));

  if (cq.data?.startsWith("ow:")) {
    const row = Number(cq.data.slice(3));
    await overwrite(sheetClient(env), row, entry);
    await editText(
      token,
      chatId,
      messageId,
      `✏️ <b>Reemplazado</b>\n${summary(entry, fmtDate(fecha))}${tech("overwrite", row)}`,
    );
  } else if (cq.data === "ap") {
    const row = await append(sheetClient(env), entry);
    await editText(
      token,
      chatId,
      messageId,
      `➕ <b>Agregado</b>\n${summary(entry, fmtDate(fecha))}${tech("append", row)}`,
    );
  }
}

export default app;

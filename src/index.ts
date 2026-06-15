import { Hono } from "hono";
import { extract } from "./openai";
import { append } from "./sheets";

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

async function reply(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("meal-tracker ok"));

app.post("/webhook", async (c) => {
  if (c.req.header("x-telegram-bot-api-secret-token") !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }

  const update = (await c.req.json()) as { message?: { chat: { id: number }; text?: string } };
  const msg = update.message;
  if (!msg) return c.json({ ok: true });

  const env = c.env;

  if (!msg.text) {
    await reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, "Mandame un texto describiendo la comida 📝");
    return c.json({ ok: true });
  }

  try {
    const fecha = today();
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
      await reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, lines.join("\n"));
      return c.json({ ok: true });
    }

    // Complete & unambiguous → save it (server dates it today, BA time).
    await append({ url: env.SHEETS_WEBAPP_URL, secret: env.SHEETS_API_SECRET }, entry);
    await reply(
      env.TELEGRAM_BOT_TOKEN,
      msg.chat.id,
      [
        "✅ <b>Guardado</b>",
        `📅 ${fmtDate(fecha)} · 🍽️ ${entry.comida} · 📍 ${entry.modo} · ⭐ ${entry.calificacion}`,
        `📝 ${entry.notas}`,
      ].join("\n"),
    );
  } catch (err) {
    console.error(err);
    await reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, "❌ Error procesando, fijate los logs.");
  }

  return c.json({ ok: true });
});

export default app;

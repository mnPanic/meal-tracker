import { Hono } from "hono";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createBot, type BotDeps, type TgUpdate } from "./bot";
import { openAiLlm } from "./openai";
import { appsScriptStore, type SheetClient } from "./sheets";
import { telegramChat } from "./telegram";

type Bindings = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  SHEETS_WEBAPP_URL: string;
  SHEETS_API_SECRET: string;
  SHEETS_READ_RETRY_MINUTES?: string;
  MEAL_WORKFLOW: Workflow<TgUpdate>;
  // Chat id permitido (el tuyo). Candás el bot a un solo chat: cualquier otro se ignora.
  // Si queda vacío, no se filtra (útil en dev).
  ALLOWED_CHAT_ID?: string;
};

export function sheetClient(env: Bindings): SheetClient {
  return {
    url: env.SHEETS_WEBAPP_URL, secret: env.SHEETS_API_SECRET,
    readRetryBudgetMs: Number(env.SHEETS_READ_RETRY_MINUTES ?? "5") * 60_000,
  };
}

// The real adapters behind the bot's interfaces.
function deps(env: Bindings): BotDeps {
  return {
    llm: openAiLlm(env.OPENAI_API_KEY),
    store: appsScriptStore(sheetClient(env)),
    chat: telegramChat(env.TELEGRAM_BOT_TOKEN),
    clock: { now: () => new Date() },
  };
}

// The webhook only enqueues. A durable job can outlive Telegram's HTTP connection.
export class MealWorkflow extends WorkflowEntrypoint<Bindings, TgUpdate> {
  async run(event: WorkflowEvent<TgUpdate>, step: WorkflowStep) {
    // Only Sheets GETs retry internally. Replaying the entire handler could repeat a POST.
    await step.do("process telegram update", {
      retries: { limit: 0, delay: "1 second" }, timeout: "1 hour",
    }, () => createBot(deps(this.env)).handleUpdate(event.payload));
  }
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("meal-tracker ok"));

app.post("/webhook", async (c) => {
  if (c.req.header("x-telegram-bot-api-secret-token") !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }

  const update = (await c.req.json()) as TgUpdate;
  const env = c.env;

  // Candado por chat: el webhook secret solo prueba que el POST viene de Telegram, no QUIÉN
  // escribió. Sin esto, cualquier usuario que encuentre el bot puede escribir en el sheet.
  // Respondemos 200 (no 403) para no darle pistas al de afuera y que Telegram no reintente.
  const fromChat = update.message?.chat.id ?? update.callback_query?.message.chat.id;
  if (env.ALLOWED_CHAT_ID && String(fromChat) !== env.ALLOWED_CHAT_ID) {
    return c.json({ ok: true });
  }
  if (!update.message && !update.callback_query) return c.json({ ok: true });
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return c.text("invalid update_id", 400);
  }

  try {
    // createBatch skips existing IDs, so a Telegram redelivery cannot start another job.
    await env.MEAL_WORKFLOW.createBatch([{ id: `telegram-${update.update_id}`, params: update }]);
  } catch {
    console.error({ event: "meal_enqueue_failed", updateId: update.update_id });
    // Telegram should retry delivery only if durable acceptance failed.
    return c.text("temporarily unavailable", 503);
  }
  return c.json({ ok: true });
});

export default app;

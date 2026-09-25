import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, protected env: unknown) {}
  },
}));
vi.mock("../src/sheets", () => ({
  readDay: vi.fn(), append: vi.fn(), overwrite: vi.fn(),
  readDiario: vi.fn(), readSemanal: vi.fn(), readMensual: vi.fn(),
}));
vi.mock("../src/openai", () => ({ extract: vi.fn(), transcribe: vi.fn() }));

import app, { MealWorkflow } from "../src/index";
import { append, readDay } from "../src/sheets";
import { extract } from "../src/openai";

const update = { update_id: 123, message: { message_id: 9, chat: { id: 42 }, text: "merendé casa ok" } };
const env = {
  TELEGRAM_BOT_TOKEN: "test-bot", TELEGRAM_WEBHOOK_SECRET: "test-webhook",
  ALLOWED_CHAT_ID: "42", OPENAI_API_KEY: "test-ai",
  SHEETS_WEBAPP_URL: "https://example.com/exec", SHEETS_API_SECRET: "test-sheets",
  SHEETS_READ_RETRY_MINUTES: "5", MEAL_WORKFLOW: { createBatch: vi.fn() },
};

function webhook(payload = update, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return app.request("/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(payload),
  }, env);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true }))));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable webhook acceptance", () => {
  it("acknowledges after enqueue without executing the meal handler", async () => {
    env.MEAL_WORKFLOW.createBatch.mockResolvedValue([{ id: "telegram-123" }]);
    const r = await webhook();
    expect(r.status).toBe(200);
    expect(env.MEAL_WORKFLOW.createBatch).toHaveBeenCalledWith([{ id: "telegram-123", params: update }]);
    expect(readDay).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the same durable ID on redelivery and accepts skipped instances", async () => {
    env.MEAL_WORKFLOW.createBatch.mockResolvedValueOnce([{ id: "telegram-123" }]).mockResolvedValueOnce([]);
    expect((await webhook()).status).toBe(200);
    expect((await webhook()).status).toBe(200);
    expect(env.MEAL_WORKFLOW.createBatch.mock.calls[0]).toEqual(env.MEAL_WORKFLOW.createBatch.mock.calls[1]);
    expect(readDay).not.toHaveBeenCalled();
  });

  it("does not acknowledge before durable acceptance", async () => {
    let accept!: () => void;
    env.MEAL_WORKFLOW.createBatch.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
    let replied = false;
    const pending = webhook().then(r => { replied = true; return r; });
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    expect(replied).toBe(false);
    accept();
    expect((await pending).status).toBe(200);
  });

  it("returns 503 if enqueue fails so Telegram can redeliver", async () => {
    env.MEAL_WORKFLOW.createBatch.mockRejectedValue(new Error("unavailable"));
    expect((await webhook()).status).toBe(503);
    expect(readDay).not.toHaveBeenCalled();
  });

  it("rejects unauthorized traffic and malformed IDs before enqueue", async () => {
    expect((await webhook(update, "wrong")).status).toBe(403);
    expect((await webhook({ ...update, message: { ...update.message, chat: { id: 99 } } })).status).toBe(200);
    expect((await webhook({ ...update, update_id: -1 })).status).toBe(400);
    expect(env.MEAL_WORKFLOW.createBatch).not.toHaveBeenCalled();
  });
});

describe("background processing", () => {
  it("passes the five-minute read budget and never enables whole-handler retries", async () => {
    vi.mocked(readDay).mockResolvedValue([]);
    vi.mocked(extract).mockResolvedValue({
      fecha: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date()), comida: "Desayuno", modo: "Casa", calificacion: "OK",
      notas: "", accion: "agregar", aclaraciones: [],
    });
    vi.mocked(append).mockRejectedValue(new Error("write outcome unknown"));
    const step = { do: vi.fn(async (_name, _config, callback) => callback()) };
    // Runtime classes are mocked; exercise the real workflow callback and handler.
    const workflow = new MealWorkflow({} as never, env as never);
    await expect(workflow.run({ payload: update } as never, step as never)).rejects.toThrow("write outcome unknown");
    expect(step.do).toHaveBeenCalledWith("process telegram update", expect.objectContaining({
      retries: { limit: 0, delay: "1 second" },
    }), expect.any(Function));
    expect(readDay).toHaveBeenCalledWith(expect.objectContaining({ readRetryBudgetMs: 300_000 }), expect.any(String));
    expect(append).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1); // Reports the error to Telegram.
  });
});

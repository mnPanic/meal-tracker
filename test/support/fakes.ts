// In-memory stand-ins for the bot's interfaces (src/ports.ts), plus a harness that drives the
// bot the way Telegram does: every reply and button tap is built from what the bot really sent.

import { createBot, type TgUpdate } from "../../src/bot";
import type { MealEntry } from "../../src/openai";
import type { Chat, Clock, ExtractInput, InlineKeyboard, Llm, MealStore } from "../../src/ports";
import type { DiarioRow, PeriodoRow, SheetEntry } from "../../src/sheets";

// --- Llm: scripted responses, recording every input ---

export class ScriptedLlm implements Llm {
  readonly calls: ExtractInput[] = [];
  readonly transcripts: string[] = [];
  private queue: MealEntry[][] = [];

  // Queues one extract() result: the meals the LLM "understood" from the next message.
  willExtract(...entries: MealEntry[]): this {
    this.queue.push(entries);
    return this;
  }

  willTranscribe(text: string): this {
    this.transcripts.push(text);
    return this;
  }

  async transcribe(_audio: ArrayBuffer): Promise<string> {
    const text = this.transcripts.shift();
    if (text === undefined) throw new Error("ScriptedLlm: unexpected transcribe call");
    return text;
  }

  async extract(input: ExtractInput): Promise<MealEntry[]> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (!next) throw new Error("ScriptedLlm: unexpected extract call");
    return next;
  }
}

// --- MealStore: rows in memory, with the Apps Script semantics (apps-script/Code.gs) ---

export interface StoredRow extends SheetEntry {
  fecha: string;
}

const SCORE = { modo: { Casa: 2, Delivery: 1, Afuera: 0 }, calificacion: { OK: 3, Mid: 1, Bad: 0 } } as const;

function score(modo: string, calificacion: string): number {
  return (SCORE.modo[modo as keyof typeof SCORE.modo] ?? 0)
    + (SCORE.calificacion[calificacion as keyof typeof SCORE.calificacion] ?? 0);
}

function shiftISO(fecha: string, days: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export class FakeStore implements MealStore {
  readonly rows: StoredRow[] = [];
  semanal: PeriodoRow[] = [];
  mensual: PeriodoRow[] = [];
  readonly writes: { op: "append" | "overwrite"; row: number }[] = [];
  failNextWrite?: Error;

  constructor(private readonly today: () => string) {}

  // Seeds rows as if already in the sheet (no window check). Row 1 is the header.
  seed(...rows: Omit<StoredRow, "row" | "score">[]): this {
    for (const r of rows) this.rows.push({ ...r, row: this.rows.length + 2, score: score(r.modo, r.calificacion) });
    return this;
  }

  private withinWindow(fecha: string): boolean {
    const today = this.today();
    return /^\d{4}-\d{2}-\d{2}$/.test(fecha) && fecha <= today && fecha >= shiftISO(today, -6);
  }

  private takeFailure(): void {
    const err = this.failNextWrite;
    this.failNextWrite = undefined;
    if (err) throw err;
  }

  async readDay(fecha: string): Promise<SheetEntry[]> {
    return this.rows.filter((r) => r.fecha === fecha).map(({ fecha: _, ...entry }) => ({ ...entry }));
  }

  async append(entry: MealEntry): Promise<number> {
    this.takeFailure();
    if (!this.withinWindow(entry.fecha)) throw new Error(`sheets append failed: fecha fuera de la ventana permitida (últimos 7 días): ${entry.fecha}`);
    const row = this.rows.length + 2;
    const { fecha, comida, modo, calificacion, notas } = entry;
    this.rows.push({ row, fecha, comida, modo, calificacion, notas, score: score(modo, calificacion) });
    this.writes.push({ op: "append", row });
    return row;
  }

  // Like the Apps Script: keeps the row's existing date.
  async overwrite(row: number, entry: MealEntry): Promise<number> {
    this.takeFailure();
    const existing = this.rows.find((r) => r.row === row);
    if (!existing) throw new Error("sheets overwrite failed: row inválida");
    if (!this.withinWindow(existing.fecha)) throw new Error("sheets overwrite failed: row fuera de la ventana permitida (últimos 7 días)");
    const { comida, modo, calificacion, notas } = entry;
    Object.assign(existing, { comida, modo, calificacion, notas, score: score(modo, calificacion) });
    this.writes.push({ op: "overwrite", row });
    return row;
  }

  // Derived from the rows, one per day, like "View diario".
  async readDiario(last?: number): Promise<DiarioRow[]> {
    const fechas = [...new Set(this.rows.map((r) => r.fecha))].sort();
    const days = fechas.map((fecha) => {
      const of = (comida: string) => this.rows.find((r) => r.fecha === fecha && r.comida === comida);
      const cell = (comida: string) => { const r = of(comida); return r ? `${r.modo} - ${r.calificacion}` : ""; };
      const note = (comida: string) => of(comida)?.notas ?? "";
      const day = this.rows.filter((r) => r.fecha === fecha);
      return {
        fecha, evento: "",
        desayuno: cell("Desayuno"), almuerzo: cell("Almuerzo"), merienda: cell("Merienda"), cena: cell("Cena"),
        score: day.reduce((sum, r) => sum + r.score, 0) / day.length,
        notas: { desayuno: note("Desayuno"), almuerzo: note("Almuerzo"), merienda: note("Merienda"), cena: note("Cena") },
      };
    });
    return last ? days.slice(-last) : days;
  }

  async readSemanal(last?: number): Promise<PeriodoRow[]> {
    return last ? this.semanal.slice(-last) : this.semanal;
  }

  async readMensual(last?: number): Promise<PeriodoRow[]> {
    return last ? this.mensual.slice(-last) : this.mensual;
  }
}

// --- Chat: records what the bot sends, enforcing Telegram's HTML rules ---

export interface SentMessage {
  id: number;
  chatId: number;
  html: string;
  text: string; // what Telegram hands back in reply_to_message.text: tags stripped, entities decoded
  keyboard?: InlineKeyboard;
  replyTo?: number;
}

const ALLOWED_TAGS = new Set(["b", "i", "code", "pre", "blockquote"]);

// Telegram rejects the whole message on malformed HTML ("can't parse entities").
export function toPlainText(html: string): string {
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>|<|&(?!(?:lt|gt|amp|quot);)/g)) {
    if (m[0] === "<" || m[0] === "&") throw new Error(`Bad Request: can't parse entities: unescaped "${m[0]}"`);
    const [, closing, tag] = m;
    if (!ALLOWED_TAGS.has(tag)) throw new Error(`Bad Request: can't parse entities: unsupported tag <${tag}>`);
    if (!closing) open.push(tag);
    else if (open.pop() !== tag) throw new Error(`Bad Request: can't parse entities: unbalanced </${tag}>`);
  }
  if (open.length) throw new Error(`Bad Request: can't parse entities: unclosed <${open.at(-1)}>`);
  return html.replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export class FakeChat implements Chat {
  readonly messages: SentMessage[] = [];
  readonly buttonsDropped: number[] = [];
  readonly answeredCallbacks: string[] = [];
  readonly files = new Map<string, ArrayBuffer>();

  constructor(private readonly nextId: () => number) {}

  get last(): SentMessage {
    const msg = this.messages.at(-1);
    if (!msg) throw new Error("FakeChat: nothing sent");
    return msg;
  }

  async send(chatId: number, html: string, opts: { keyboard?: InlineKeyboard; replyTo?: number } = {}): Promise<number> {
    const text = toPlainText(html);
    if (text.length > 4096) throw new Error("Bad Request: message is too long");
    const id = this.nextId();
    this.messages.push({ id, chatId, html, text, keyboard: opts.keyboard, replyTo: opts.replyTo });
    return id;
  }

  async dropButtons(_chatId: number, messageId: number): Promise<void> {
    this.buttonsDropped.push(messageId);
  }

  async answerCallback(callbackId: string): Promise<void> {
    this.answeredCallbacks.push(callbackId);
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`FakeChat: unknown file ${fileId}`);
    return file;
  }
}

// --- Harness ---

export const CHAT_ID = 42;

// `now` is an ISO instant, e.g. "2026-09-25T21:00:00-03:00" (Buenos Aires is UTC-3).
export function harness(now: string) {
  let ids = 100;
  const nextId = () => ++ids;
  const clock: Clock = { now: () => new Date(now) };
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(clock.now());
  const llm = new ScriptedLlm();
  const store = new FakeStore(today);
  const chat = new FakeChat(nextId);
  const bot = createBot({ llm, store, chat, clock });
  let updateId = 0;
  const dispatch = (update: Omit<TgUpdate, "update_id">) => bot.handleUpdate({ update_id: ++updateId, ...update });

  return {
    llm, store, chat, today: today(),

    // Sends a text message, optionally as a reply to something the bot sent. Returns its id.
    async send(text: string, opts: { replyTo?: SentMessage } = {}): Promise<number> {
      const message_id = nextId();
      await dispatch({ message: {
        message_id, chat: { id: CHAT_ID }, text,
        reply_to_message: opts.replyTo && { text: opts.replyTo.text },
      } });
      return message_id;
    },

    async sendVoice(fileId = "voice-1"): Promise<number> {
      const message_id = nextId();
      chat.files.set(fileId, new ArrayBuffer(8));
      await dispatch({ message: { message_id, chat: { id: CHAT_ID }, voice: { file_id: fileId } } });
      return message_id;
    },

    // Taps the button labelled `label` on a message the bot sent.
    async tap(msg: SentMessage, label: string): Promise<void> {
      const button = msg.keyboard?.inline_keyboard.flat().find((b) => b.text.includes(label));
      if (!button) throw new Error(`No button "${label}" on message ${msg.id}`);
      await dispatch({ callback_query: {
        id: `cb-${msg.id}`, data: button.callback_data,
        message: { message_id: msg.id, chat: { id: CHAT_ID }, text: msg.text },
      } });
    },

    // Messages the bot sent after the given point (by count), for asserting one turn's output.
    sentSince(count: number): SentMessage[] {
      return chat.messages.slice(count);
    },
  };
}

export const meal = (e: Partial<MealEntry>): MealEntry => ({
  fecha: "2026-09-25",
  comida: "Desayuno",
  modo: "Casa",
  calificacion: "OK",
  notas: "",
  accion: "agregar",
  aclaraciones: [],
  ...e,
});

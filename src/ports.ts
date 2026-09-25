// The bot's dependencies, behind interfaces so tests can swap them: the real adapters live in
// openai.ts (Llm), sheets.ts (MealStore) and telegram.ts (Chat); the fakes in test/support.

import type { MealEntry } from "./openai";
import type { DiarioRow, PeriodoRow, SheetEntry } from "./sheets";

export interface ExtractInput {
  text: string; // the user's message, or the transcript of a voice note
  now: string; // human-readable BA datetime with weekday, e.g. "2026-06-15 14:30 (domingo)"
  recientes: string; // the 7-day meal table
  replied: string; // full text of the message being replied to, or ""
}

export interface Llm {
  transcribe(audio: ArrayBuffer): Promise<string>;
  extract(input: ExtractInput): Promise<MealEntry>;
}

export interface MealStore {
  readDay(fecha: string): Promise<SheetEntry[]>;
  append(entry: MealEntry): Promise<number>;
  overwrite(row: number, entry: MealEntry): Promise<number>;
  readDiario(last?: number): Promise<DiarioRow[]>;
  readSemanal(last?: number): Promise<PeriodoRow[]>;
  readMensual(last?: number): Promise<PeriodoRow[]>;
}

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

export interface Chat {
  // Sends an HTML message and returns its message_id.
  send(chatId: number, html: string, opts?: { keyboard?: InlineKeyboard; replyTo?: number }): Promise<number>;
  dropButtons(chatId: number, messageId: number): Promise<void>;
  answerCallback(callbackId: string): Promise<void>;
  downloadFile(fileId: string): Promise<ArrayBuffer>;
}

export interface Clock {
  now(): Date;
}

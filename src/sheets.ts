// Client for the Apps Script web app. See apps-script/README.md for the contract.
// Ops: readDay/readDiario/readSemanal/readMensual (GET), append/overwrite (POST).
// Every request carries the shared secret token; the script rejects anything without it.
// Writes are sandboxed server-side to a recent window (last 7 days, no future).

import type { MealEntry } from "./openai";

export interface SheetClient {
  url: string;
  secret: string;
}

export interface SheetEntry {
  row: number;
  comida: string;
  modo: string;
  calificacion: string;
  score: number;
  notas: string;
}

type Fields = Pick<MealEntry, "comida" | "modo" | "calificacion" | "notas">;

function fields(entry: MealEntry): Fields {
  return { comida: entry.comida, modo: entry.modo, calificacion: entry.calificacion, notas: entry.notas };
}

async function post(c: SheetClient, body: object): Promise<{ ok: boolean; row?: number; error?: string }> {
  const r = await fetch(c.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: c.secret, ...body }),
    redirect: "follow",
  });
  return (await r.json()) as { ok: boolean; row?: number; error?: string };
}

async function get<T>(c: SheetClient, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ token: c.secret, ...params });
  const r = await fetch(`${c.url}?${q}`, { redirect: "follow" });
  return (await r.json()) as T;
}

// Read all entries for a given day (default today, server-side BA time).
export async function readDay(c: SheetClient, fecha?: string): Promise<SheetEntry[]> {
  const j = await get<{ ok: boolean; entries?: SheetEntry[]; error?: string }>(
    c,
    fecha ? { fecha } : {},
  );
  if (!j.ok) throw new Error(`sheets read failed: ${j.error}`);
  return j.entries ?? [];
}

// Add a new row dated entry.fecha (YYYY-MM-DD). Returns the new row number.
// The backend rejects dates outside the allowed window (last 7 days, no future).
export async function append(c: SheetClient, entry: MealEntry): Promise<number> {
  const j = await post(c, { action: "append", fecha: entry.fecha, ...fields(entry) });
  if (!j.ok) throw new Error(`sheets append failed: ${j.error}`);
  return j.row ?? 0;
}

// Overwrite an existing row (only succeeds if that row is within the allowed window).
export async function overwrite(c: SheetClient, row: number, entry: MealEntry): Promise<number> {
  const j = await post(c, { action: "overwrite", row, ...fields(entry) });
  if (!j.ok) throw new Error(`sheets overwrite failed: ${j.error}`);
  return j.row ?? 0;
}

// --- Summary views (read-only) ---

export interface DiarioRow {
  fecha: string;
  evento: string;
  desayuno: string; // "Casa - OK" etc.
  almuerzo: string;
  merienda: string;
  cena: string;
  score: number; // daily average
  notas: { desayuno: string; almuerzo: string; merienda: string; cena: string };
}

export interface PeriodoRow {
  inicio: string; // week-start or month-start date
  label: string; // "2026-06 W2" or "2026-06"
  promedio: number; // average score for the period
  eventos: string;
}

async function getView<T>(c: SheetClient, view: string, last?: number): Promise<T[]> {
  const params: Record<string, string> = { view };
  if (last) params.last = String(last);
  const j = await get<{ ok: boolean; rows?: T[]; error?: string }>(c, params);
  if (!j.ok) throw new Error(`sheets view '${view}' failed: ${j.error}`);
  return j.rows ?? [];
}

// "View diario" — one row per day. `last` caps to the most recent N days.
export function readDiario(c: SheetClient, last?: number): Promise<DiarioRow[]> {
  return getView<DiarioRow>(c, "diario", last);
}

// Weekly summary table from "View semanalmensual".
export function readSemanal(c: SheetClient, last?: number): Promise<PeriodoRow[]> {
  return getView<PeriodoRow>(c, "semanal", last);
}

// Monthly summary table from "View semanalmensual".
export function readMensual(c: SheetClient, last?: number): Promise<PeriodoRow[]> {
  return getView<PeriodoRow>(c, "mensual", last);
}

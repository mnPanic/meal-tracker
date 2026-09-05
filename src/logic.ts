// Pure, side-effect-free helpers (no network): the meal table and sequence validation, the
// message (re)parsing and the diff/summary formatting. Kept apart from index.ts so they
// can be unit-tested deterministically (see test/logic.test.ts).

import type { MealEntry } from "./openai";
import type { SheetEntry } from "./sheets";

export const ORDEN = ["Desayuno", "Almuerzo", "Merienda", "Cena"];
// Merienda (índice 2) es opcional: nunca cuenta como "faltante" obligatoria.
const OPCIONAL = 2;

// Yesterday's ISO date relative to a YYYY-MM-DD date (UTC-safe, no tz drift).
export function prevISO(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export interface MealDay {
  fecha: string;
  entries: SheetEntry[];
}

// Callers supply consecutive calendar days. Leading empty days are outside the known sequence.
export function formatRecientes(days: MealDay[]): string {
  const ordered = days.toSorted((a, b) => a.fecha.localeCompare(b.fecha));
  const firstDay = ordered.findIndex((day) => day.entries.length > 0);
  const slots = ordered.flatMap((day) => ORDEN.map((comida) =>
    day.entries.find((entry) => entry.comida === comida)));
  const last = slots.findLastIndex((entry) => entry !== undefined);
  const holes: string[] = [];
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const rows = ordered.map((day, dayIndex) => {
    const values = ORDEN.map((comida, mealIndex) => {
      const index = dayIndex * ORDEN.length + mealIndex;
      const entry = slots[index];
      if (entry) return cell(`Cargada [${entry.modo}, ${entry.calificacion}]: ${entry.notas}`);
      if (firstDay < 0 || dayIndex < firstDay) return "Sin registros previos";
      if (index < last) {
        if (mealIndex === OPCIONAL) return "Omitida";
        holes.push(`${comida} del ${day.fecha}`);
        return "ERROR: hueco";
      }
      return mealIndex === OPCIONAL ? "Pendiente (opcional)" : "Pendiente";
    });
    return `| ${day.fecha} | ${values.join(" | ")} |`;
  });
  if (holes.length) throw new Error(`Hay huecos en la carga: ${holes.join(", ")}. Hay comidas posteriores registradas; corregí la planilla antes de continuar.`);
  return ["| Fecha | Desayuno | Almuerzo | Merienda | Cena |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

// Validate the resulting sequence, including edits that rename an existing meal.
export function validateMealWrite(days: MealDay[], entry: MealEntry, row?: number): void {
  if (!ORDEN.includes(entry.comida)) throw new Error(`Comida inválida: ${entry.comida}`);
  if (!days.some((day) => day.fecha === entry.fecha)) throw new Error("La fecha está fuera del contexto de 7 días.");
  const proposed = days.map((day) => ({
    ...day,
    entries: day.entries.filter((saved) => row === undefined || saved.row !== row),
  }));
  proposed.find((day) => day.fecha === entry.fecha)!.entries.push({ ...entry, row: row ?? -1, score: 0 });
  formatRecientes(proposed);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// LOAD-BEARING FORMAT: parseSummary re-parses this exact layout from proposal messages to
// recover the entry on accept (stateless). Keep fecha/comida/modo/calificacion on line 1 and
// notas on its own line; don't reorder without updating parseSummary.
export function summary(entry: MealEntry): string {
  return `📅 ${entry.fecha} · 🍽️ ${entry.comida} · 📍 ${entry.modo} · ⭐ ${entry.calificacion}\n📝 ${entry.notas}`;
}

// Recover the entry from a message built with summary(). Returns null if it doesn't match.
// The header line and the notas line must be adjacent (summary()'s exact layout), so a diff
// block above it — whose lines look like "📝 viejo → nuevo" — can't be mistaken for it.
export function parseSummary(text: string): MealEntry | null {
  const m = text.match(/📅 (\S+) · 🍽️ (\S+) · 📍 (\S+) · ⭐ (\S+)\n📝 ([^\n]*)/);
  if (!m) return null;
  return { fecha: m[1], comida: m[2], modo: m[3], calificacion: m[4], notas: m[5].trim(), aclaraciones: [], accion: "editar" };
}

// LOAD-BEARING FORMAT: parseRow recovers the row from this footer. Keep "op · fila N".
export function parseRow(text: string): number | null {
  const m = text.match(/(?:append|overwrite) · fila (\d+)/);
  return m ? Number(m[1]) : null;
}

// A saved-meal message carries a date line and a "fila N" footer; lets a reply target its row.
export function isSavedMeal(text: string): boolean {
  return /📅 \d{4}-\d{2}-\d{2}/.test(text) && parseRow(text) !== null;
}

// Lines for the fields that change between the saved entry and the proposal.
export function diff(base: MealEntry, prop: MealEntry): string {
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

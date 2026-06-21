// Pure, side-effect-free helpers (no network, no `new Date()`): the meal hint, the
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

export interface Hint {
  fecha: string; // fecha de la comida más probable
  comida: string; // comida más probable
  texto: string; // texto para el prompt y el bloque de contexto
}

// Deterministic hint from the BA hour and what's already logged. As meals are logged in
// order, this lists the PENDING mandatory meals (yesterday's Cena if missing, then today's
// up to the time ceiling), marks Merienda as optional, and points at the most probable one
// (the first pending). `hora` is the BA hour (0-23); `today` is YYYY-MM-DD in BA.
export function comidaHintAt(hoy: SheetEntry[], ayer: SheetEntry[], hora: number, today: string): Hint {
  const yest = prevISO(today);

  // Madrugada (antes de las 6): seguís en el día anterior; lo más probable es la Cena de ayer.
  if (hora < 6) {
    return { fecha: yest, comida: "Cena", texto: `Es de madrugada: probablemente la Cena del ${yest}.` };
  }

  // Techo: la comida más tardía plausible según la hora.
  let techo = 0; // Desayuno
  if (hora >= 19) techo = 3;
  else if (hora >= 16) techo = 2;
  else if (hora >= 12) techo = 1;

  const pendientes: { fecha: string; comida: string }[] = [];
  // Cena de ayer sin cargar => sigue pendiente (carga tardía a la madrugada/mañana siguiente).
  if (!ayer.some((e) => e.comida === "Cena")) pendientes.push({ fecha: yest, comida: "Cena" });
  // Comidas obligatorias de hoy faltantes hasta el techo.
  const cargadasHoy = new Set(hoy.map((e) => e.comida));
  ORDEN.slice(0, techo + 1).forEach((c, i) => {
    if (i !== OPCIONAL && !cargadasHoy.has(c)) pendientes.push({ fecha: today, comida: c });
  });

  const probable = pendientes[0] ?? { fecha: today, comida: ORDEN[techo] };
  const lista = pendientes.length
    ? pendientes.map((p) => `${p.comida} del ${p.fecha}`).join(", ")
    : "ninguna (todas las obligatorias ya están cargadas)";
  const texto =
    `Pendientes en orden: ${lista}. La Merienda es opcional. ` +
    `Lo más probable, salvo que el mensaje diga otra cosa, es la ${probable.comida} del ${probable.fecha}.`;
  return { fecha: probable.fecha, comida: probable.comida, texto };
}

// Compact block of recent meals (one line per day) with their modo/calificación/notas, so
// the model can edit a meal preserving the fields the message doesn't mention.
export function formatRecientes(days: { fecha: string; entries: SheetEntry[] }[]): string {
  return days
    .map(({ fecha, entries }) => {
      const items = entries.length
        ? entries.map((e) => `${e.comida} [${e.modo}, ${e.calificacion}]: ${e.notas}`).join("; ")
        : "(sin registros)";
      return `${fecha}: ${items}`;
    })
    .join("\n");
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

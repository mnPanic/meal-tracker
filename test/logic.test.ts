import { describe, it, expect } from "vitest";
import {
  comidaHintAt,
  diff,
  formatRecientes,
  isSavedMeal,
  parseRow,
  parseSummary,
  prevISO,
  summary,
} from "../src/logic";
import type { MealEntry } from "../src/openai";
import type { SheetEntry } from "../src/sheets";

const sheet = (comida: string, extra: Partial<SheetEntry> = {}): SheetEntry => ({
  row: 0,
  comida,
  modo: "Casa",
  calificacion: "OK",
  score: 0,
  notas: "",
  ...extra,
});

const meal = (e: Partial<MealEntry>): MealEntry => ({
  fecha: "2026-06-21",
  comida: "Almuerzo",
  modo: "Casa",
  calificacion: "OK",
  notas: "",
  accion: "agregar",
  aclaraciones: [],
  ...e,
});

describe("prevISO", () => {
  it("rolls back across month boundaries", () => {
    expect(prevISO("2026-06-01")).toBe("2026-05-31");
    expect(prevISO("2026-01-01")).toBe("2025-12-31");
  });
});

describe("comidaHintAt", () => {
  const today = "2026-06-21";

  it("madrugada → Cena del día anterior", () => {
    const h = comidaHintAt([], [], 3, today);
    expect(h).toMatchObject({ fecha: "2026-06-20", comida: "Cena" });
  });

  it("explicit-meal bug case: yesterday's Cena missing shows up as pending", () => {
    // 09:00, today empty, yesterday has everything but Cena.
    const ayer = ["Desayuno", "Almuerzo", "Merienda"].map((c) => sheet(c));
    const h = comidaHintAt([], ayer, 9, today);
    // Most probable is the oldest pending: yesterday's Cena.
    expect(h).toMatchObject({ fecha: "2026-06-20", comida: "Cena" });
    expect(h.texto).toContain("Cena del 2026-06-20");
    expect(h.texto).toContain("Desayuno del 2026-06-21");
  });

  it("lists pending mandatory meals up to the time ceiling, skipping optional Merienda", () => {
    // 18:00 (ceiling = Merienda), only Desayuno logged today, yesterday complete.
    const ayer = ORDEN_FULL.map((c) => sheet(c));
    const h = comidaHintAt([sheet("Desayuno")], ayer, 18, today);
    expect(h).toMatchObject({ comida: "Almuerzo", fecha: today });
    expect(h.texto).toContain("Almuerzo del 2026-06-21");
    expect(h.texto).not.toContain("Merienda del"); // optional, not listed as pending
    expect(h.texto).toContain("La Merienda es opcional");
  });

  it("nothing pending → points at the ceiling meal", () => {
    const ayer = ORDEN_FULL.map((c) => sheet(c));
    const hoy = [sheet("Desayuno"), sheet("Almuerzo")];
    const h = comidaHintAt(hoy, ayer, 13, today); // ceiling = Almuerzo, both logged
    expect(h.comida).toBe("Almuerzo");
    expect(h.texto).toContain("ninguna");
  });
});

const ORDEN_FULL = ["Desayuno", "Almuerzo", "Merienda", "Cena"];

describe("summary ⇄ parseSummary round-trip", () => {
  it("recovers the entry from its own summary", () => {
    const e = meal({ comida: "Cena", modo: "Afuera", calificacion: "Bad", notas: "Daiki - sushi" });
    const parsed = parseSummary(summary(e));
    expect(parsed).toMatchObject({
      fecha: e.fecha,
      comida: "Cena",
      modo: "Afuera",
      calificacion: "Bad",
      notas: "Daiki - sushi",
      accion: "editar",
    });
  });

  it("does not mistake a diff line for the summary notas", () => {
    const base = meal({ notas: "viejo" });
    const prop = meal({ notas: "nuevo" });
    const text = `✏️ Propuesta\n${diff(base, prop)}\n\n${summary(prop)}`;
    expect(parseSummary(text)?.notas).toBe("nuevo");
  });

  it("returns null on unrelated text", () => {
    expect(parseSummary("hola que tal")).toBeNull();
  });
});

describe("parseRow / isSavedMeal", () => {
  it("extracts the row from the action footer", () => {
    expect(parseRow("acciones: append · fila 436")).toBe(436);
    expect(parseRow("acciones: overwrite · fila 12")).toBe(12);
    expect(parseRow("no row here")).toBeNull();
  });

  it("isSavedMeal needs both a date line and a fila footer", () => {
    const saved = `${summary(meal({}))}\nacciones: append · fila 9`;
    expect(isSavedMeal(saved)).toBe(true);
    expect(isSavedMeal(summary(meal({})))).toBe(false); // no fila
    expect(isSavedMeal("acciones: append · fila 9")).toBe(false); // no date
  });
});

describe("diff", () => {
  it("only lists changed fields", () => {
    const base = meal({ modo: "Casa", notas: "a" });
    const prop = meal({ modo: "Afuera", notas: "a" });
    const d = diff(base, prop);
    expect(d).toContain("📍 Casa → <b>Afuera</b>");
    expect(d).not.toContain("📝");
  });

  it("reports no changes", () => {
    expect(diff(meal({}), meal({}))).toBe("(sin cambios)");
  });
});

describe("formatRecientes", () => {
  it("includes modo/calificación so edits can preserve fields", () => {
    const out = formatRecientes([
      { fecha: "2026-06-20", entries: [sheet("Desayuno", { notas: "yoghurt", calificacion: "OK" })] },
      { fecha: "2026-06-21", entries: [] },
    ]);
    expect(out).toContain("Desayuno [Casa, OK]: yoghurt");
    expect(out).toContain("2026-06-21: (sin registros)");
  });
});

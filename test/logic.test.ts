import { describe, it, expect } from "vitest";
import {
  validateBatch,
  diff,
  formatRecientes,
  isSavedMeal,
  parseRow,
  parseItems,
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


describe("summary ⇄ parseItems round-trip", () => {
  it("recovers the entry from its own summary", () => {
    const e = meal({ comida: "Cena", modo: "Afuera", calificacion: "Bad", notas: "Daiki - sushi" });
    const [parsed] = parseItems(summary(e));
    expect(parsed.entry).toMatchObject({
      fecha: e.fecha,
      comida: "Cena",
      modo: "Afuera",
      calificacion: "Bad",
      notas: "Daiki - sushi",
      accion: "editar",
    });
    expect(parsed.row).toBeUndefined();
  });

  it("does not mistake a diff line for the summary notas", () => {
    const base = meal({ notas: "viejo" });
    const prop = meal({ notas: "nuevo" });
    const text = `✏️ Propuesta\n${diff(base, prop)}\n\n${summary(prop)}`;
    expect(parseItems(text).map((i) => i.entry.notas)).toEqual(["nuevo"]);
  });

  it("reads every item with its action footer, in order", () => {
    const text = [
      `1. ⚠️ Ya tenías Desayuno\n${summary(meal({ comida: "Desayuno" }))}\nacciones: overwrite · fila 12`,
      `2. ➕ Nueva\n${summary(meal({ comida: "Almuerzo", notas: "" }))}\nacciones: append`,
    ].join("\n\n");
    expect(parseItems(text).map((i) => [i.entry.comida, i.entry.notas, i.row])).toEqual([
      ["Desayuno", "", 12], ["Almuerzo", "", undefined],
    ]);
  });

  it("returns nothing on unrelated text", () => {
    expect(parseItems("hola que tal")).toEqual([]);
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
    expect(out).toContain("Cargada [Casa, OK]: yoghurt");
    expect(out).toContain("| 2026-06-21 | Pendiente | Pendiente | Pendiente (opcional) | Pendiente |");
  });

  it("keeps Merienda pending until a later meal is recorded", () => {
    const entries = [sheet("Desayuno"), sheet("Almuerzo")];
    expect(formatRecientes([{ fecha: "2026-06-21", entries }])).toContain("Pendiente (opcional)");
    expect(formatRecientes([{ fecha: "2026-06-21", entries: [...entries, sheet("Cena")] }])).toContain("Omitida");
  });

  it("reports mandatory holes within a day", () => {
    expect(() => formatRecientes([{ fecha: "2026-06-21", entries: [sheet("Desayuno"), sheet("Cena")] }]))
      .toThrow("Almuerzo del 2026-06-21");
  });

  it("reports a missing dinner and an entirely empty intermediate day", () => {
    expect(() => formatRecientes([
      { fecha: "2026-06-20", entries: [sheet("Desayuno"), sheet("Almuerzo")] },
      { fecha: "2026-06-21", entries: [] },
      { fecha: "2026-06-22", entries: [sheet("Desayuno")] },
    ])).toThrow(/Cena del 2026-06-20.*Desayuno del 2026-06-21.*Almuerzo del 2026-06-21.*Cena del 2026-06-21/);
  });

  it("does not infer holes before the first recorded day or in an empty window", () => {
    const days = [{ fecha: "2026-06-20", entries: [] }];
    expect(formatRecientes(days)).toContain("Sin registros previos");
    expect(formatRecientes([...days, { fecha: "2026-06-21", entries: [sheet("Desayuno")] }]))
      .toContain("Sin registros previos");
  });

  it("detects a missing breakfast on the first recorded day", () => {
    expect(() => formatRecientes([{ fecha: "2026-06-21", entries: [sheet("Almuerzo")] }]))
      .toThrow("Desayuno del 2026-06-21");
  });

  it("sorts dates and escapes table separators and newlines in notes", () => {
    const out = formatRecientes([
      { fecha: "2026-06-21", entries: [] },
      { fecha: "2026-06-20", entries: [sheet("Desayuno", { notas: "a|b\nc" })] },
    ]);
    expect(out.indexOf("2026-06-20")).toBeLessThan(out.indexOf("2026-06-21"));
    expect(out).toContain("a\\|b c");
  });
});

describe("validateBatch", () => {
  const days = [{ fecha: "2026-06-21", entries: [sheet("Desayuno", { row: 1 }), sheet("Almuerzo", { row: 2 })] }];
  const one = (entry: ReturnType<typeof meal>, row?: number) => validateBatch(days, [{ entry, row }]);

  it("allows skipping Merienda for an explicit Cena", () => {
    expect(() => one(meal({ comida: "Cena" }))).not.toThrow();
  });

  it("rejects a new meal that skips a mandatory one", () => {
    expect(() => validateBatch([{ ...days[0], entries: [days[0].entries[0]] }], [{ entry: meal({ comida: "Cena" }) }]))
      .toThrow("Almuerzo del 2026-06-21");
  });

  it("rejects renaming Almuerzo to Cena, leaving a hole", () => {
    expect(() => one(meal({ comida: "Cena" }), 2)).toThrow("Almuerzo del 2026-06-21");
    expect(days[0].entries[1].comida).toBe("Almuerzo");
  });

  it("allows a correction that keeps the sequence intact", () => {
    expect(() => one(meal({ notas: "corregida" }), 2)).not.toThrow();
  });

  it("rejects dates outside the validated window", () => {
    expect(() => one(meal({ fecha: "2026-06-22" }))).toThrow("fuera del contexto");
  });

  it("counts earlier items of the batch as loaded, across days", () => {
    const window = [{ fecha: "2026-06-21", entries: [sheet("Desayuno", { row: 1 })] }, { fecha: "2026-06-22", entries: [] }];
    expect(() => validateBatch(window, [
      { entry: meal({ comida: "Almuerzo" }) },
      { entry: meal({ comida: "Cena" }) },
      { entry: meal({ fecha: "2026-06-22", comida: "Desayuno" }) },
    ])).not.toThrow();
    expect(window[0].entries).toHaveLength(1);
  });

  it("rejects appending a meal that is already in the sheet", () => {
    expect(() => one(meal({ comida: "Almuerzo" }))).toThrow("Ya hay Almuerzo del 2026-06-21");
  });

  it("rejects the same meal twice in one batch", () => {
    expect(() => validateBatch(days, [{ entry: meal({ comida: "Cena" }) }, { entry: meal({ comida: "Cena" }) }]))
      .toThrow("Cena del 2026-06-21 aparece dos veces");
  });
});

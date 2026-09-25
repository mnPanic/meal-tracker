// Integration tests: a Telegram update in, the LLM's (scripted) interpretation, and what the bot
// ends up writing and proposing. Real bot logic; fake sheet and chat; scripted LLM.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { harness, meal } from "./support/fakes";

const FRIDAY_NIGHT = "2026-09-25T21:00:00-03:00";

// A full day of meals, so the sequence continues cleanly from the next one.
const fullDay = (fecha: string) => (["Desayuno", "Almuerzo", "Merienda", "Cena"] as const)
  .map((comida) => ({ fecha, comida, modo: "Casa", calificacion: "OK", notas: `${comida} del ${fecha}` }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a new meal", () => {
  it("is appended and confirmed, with the sequence context given to the LLM", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.llm.willExtract(meal({ comida: "Desayuno", notas: "Yoghurt griego con granola" }));

    await h.send("hoy desayuné casa ok yoghurt griego con granola");

    expect(h.store.rows.at(-1)).toMatchObject({
      fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "OK", notas: "Yoghurt griego con granola",
    });
    expect(h.chat.last.text).toContain("✅ Guardado");
    expect(h.chat.last.text).toContain("📅 2026-09-25 · 🍽️ Desayuno · 📍 Casa · ⭐ OK\n📝 Yoghurt griego con granola");
    expect(h.chat.last.text).toContain("acciones: append · fila 6");

    const [call] = h.llm.calls;
    expect(call.text).toBe("hoy desayuné casa ok yoghurt griego con granola");
    expect(call.now).toBe("2026-09-25 21:00 (viernes)");
    expect(call.recientes).toContain("| 2026-09-24 | Cargada [Casa, OK]: Desayuno del 2026-09-24");
    expect(call.recientes).toContain("| 2026-09-25 | Pendiente |");
    expect(call.replied).toBe("");
  });

  it("escapes HTML-looking notes and still round-trips them", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.llm.willExtract(meal({ notas: "Tostadas <3 & mermelada" }));

    await h.send("desayuné casa ok tostadas <3 & mermelada");

    expect(h.store.rows.at(-1)?.notas).toBe("Tostadas <3 & mermelada");
    expect(h.chat.last.text).toContain("📝 Tostadas <3 & mermelada");
  });

  it("transcribes a voice note and echoes the transcript", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.llm.willTranscribe("desayuné en casa ok un café");
    h.llm.willExtract(meal({ notas: "Café" }));

    await h.sendVoice();

    expect(h.llm.calls[0].text).toBe("desayuné en casa ok un café");
    expect(h.store.rows.at(-1)?.notas).toBe("Café");
    expect(h.chat.last.text).toContain("🎤 transcript: desayuné en casa ok un café");
  });
});

describe("clarifications", () => {
  it("asks without saving, then saves from a reply that carries the original message", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.llm.willExtract(meal({ calificacion: "", aclaraciones: ["¿Fue OK, Mid o Bad?"] }));

    await h.send("desayuné casa medialunas");

    expect(h.store.rows).toHaveLength(4);
    const ask = h.chat.last;
    expect(ask.text).toContain("falta confirmar");
    expect(ask.text).toContain("¿Fue OK, Mid o Bad?");

    h.llm.willExtract(meal({ calificacion: "Mid", notas: "Medialunas" }));
    await h.send("mid", { replyTo: ask });

    expect(h.llm.calls[1].replied).toContain("💬 mensaje: desayuné casa medialunas");
    expect(h.store.rows.at(-1)).toMatchObject({ comida: "Desayuno", calificacion: "Mid", notas: "Medialunas" });
  });
});

describe("overwrites", () => {
  function withBreakfast() {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"), { fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "OK", notas: "Café" });
    return h;
  }

  it("proposes replacing a meal already logged, and applies it on accept", async () => {
    const h = withBreakfast();
    h.llm.willExtract(meal({ calificacion: "Mid", notas: "Medialunas" }));

    const userMsg = await h.send("desayuné casa mid medialunas");

    const proposal = h.chat.last;
    expect(h.store.writes).toEqual([]);
    expect(proposal.replyTo).toBe(userMsg);
    expect(proposal.text).toContain("Ya tenías Desayuno el 2026-09-25");
    expect(proposal.text).toContain("⭐ OK → Mid");

    await h.tap(proposal, "Aceptar");

    expect(h.store.writes).toEqual([{ op: "overwrite", row: 6 }]);
    expect(h.store.rows.at(-1)).toMatchObject({ fecha: "2026-09-25", comida: "Desayuno", calificacion: "Mid", notas: "Medialunas" });
    expect(h.chat.buttonsDropped).toEqual([proposal.id]);
    expect(h.chat.last.text).toContain("✅ Aplicado");
    expect(h.chat.last.replyTo).toBe(proposal.id);
  });

  it("discards on reject", async () => {
    const h = withBreakfast();
    h.llm.willExtract(meal({ calificacion: "Mid", notas: "Medialunas" }));
    await h.send("desayuné casa mid medialunas");
    const proposal = h.chat.last;

    await h.tap(proposal, "Rechazar");

    expect(h.store.writes).toEqual([]);
    expect(h.store.rows.at(-1)?.notas).toBe("Café");
    expect(h.chat.buttonsDropped).toEqual([proposal.id]);
    expect(h.chat.last.text).toBe("✖️ Descartado.");
  });

  it("edits the exact row of a saved message it replies to, and recaps a resulting Cena", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(
      ...fullDay("2026-09-24"),
      { fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "OK", notas: "Café" },
      { fecha: "2026-09-25", comida: "Almuerzo", modo: "Casa", calificacion: "OK", notas: "Ensalada" },
    );
    h.llm.willExtract(meal({ comida: "Merienda", notas: "Pizza" }));
    await h.send("merendé casa ok pizza");
    const saved = h.chat.last;
    expect(saved.text).toContain("append · fila 8");

    h.llm.willExtract(meal({ comida: "Cena", notas: "Pizza", accion: "editar" }));
    await h.send("era la cena", { replyTo: saved });

    expect(h.llm.calls.at(-1)?.replied).toContain("📅 2026-09-25 · 🍽️ Merienda");
    const proposal = h.chat.last;
    expect(proposal.text).toContain("Propuesta de edición (fila 8)");
    expect(proposal.text).toContain("🍽️ Merienda → Cena");

    const before = h.chat.messages.length;
    await h.tap(proposal, "Aceptar");

    expect(h.store.rows.find((r) => r.row === 8)).toMatchObject({ comida: "Cena", notas: "Pizza" });
    const [applied, cierre] = h.sentSince(before);
    expect(applied.text).toContain("✅ Aplicado");
    expect(cierre.text).toContain("🌙 Cierre del día 2026-09-25");
  });
});

describe("sequence validation", () => {
  it("rejects a meal that would leave a mandatory hole, without writing", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.llm.willExtract(meal({ comida: "Almuerzo" }));

    await expect(h.send("almorcé casa ok")).rejects.toThrow("Hay huecos en la carga: Desayuno del 2026-09-25");

    expect(h.store.writes).toEqual([]);
    expect(h.chat.last.text).toContain("❌ Error");
  });

  it("stops before calling the LLM when the sheet already has a hole", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24").filter((r) => r.comida !== "Almuerzo"));

    await expect(h.send("desayuné casa ok")).rejects.toThrow("Almuerzo del 2026-09-24");

    expect(h.llm.calls).toEqual([]);
  });
});

describe("cycle recaps after a Cena", () => {
  const upToMerienda = (fecha: string) => fullDay(fecha).filter((r) => r.comida !== "Cena");

  it("sends the day and week recaps on a Sunday", async () => {
    const h = harness("2026-09-27T22:00:00-03:00");
    h.store.seed(...upToMerienda("2026-09-27"));
    h.store.semanal = [{ inicio: "2026-09-21", label: "2026-09 W4", promedio: 4.5, eventos: "" }];
    h.llm.willExtract(meal({ fecha: "2026-09-27", comida: "Cena", modo: "Delivery", calificacion: "Mid" }));

    await h.send("cené delivery mid");

    const [saved, dia, semana] = h.sentSince(0);
    expect(saved.text).toContain("✅ Guardado");
    expect(dia.text).toContain("🌙 Cierre del día 2026-09-27");
    expect(dia.text).toContain("🌆 Cena: Delivery - Mid");
    expect(semana.text).toContain("📊 Cierre semana: 2026-09 W4");
    expect(h.chat.messages).toHaveLength(3);
  });

  it("sends the month recap on the last day of the month", async () => {
    const h = harness("2026-09-30T22:00:00-03:00");
    h.store.seed(...upToMerienda("2026-09-30"));
    h.store.mensual = [{ inicio: "2026-09-01", label: "2026-09", promedio: 4.1, eventos: "" }];
    h.llm.willExtract(meal({ fecha: "2026-09-30", comida: "Cena" }));

    await h.send("cené casa ok");

    expect(h.chat.messages.map((m) => m.text.split("\n")[0])).toEqual([
      "✅ Guardado", "🌙 Cierre del día 2026-09-30", "📈 Cierre mes: 2026-09",
    ]);
  });
});

describe("failures", () => {
  it("reports a failed write in the chat and rethrows", async () => {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    h.store.failNextWrite = new Error("write outcome unknown");
    h.llm.willExtract(meal({}));

    await expect(h.send("desayuné casa ok")).rejects.toThrow("write outcome unknown");

    expect(h.chat.last.text).toContain("❌ Error");
    expect(h.chat.last.text).toContain("write outcome unknown");
  });
});

describe("several meals in one message", () => {
  const BATCH = "hoy desayuné casa ok yoghurt griego con granola\nhoy almorcé delivery ok sanguche de pollo\nhoy merendé casa ok yoghurt griego con granola";
  const desayuno = meal({ comida: "Desayuno", notas: "Yoghurt griego con granola" });
  const almuerzo = meal({ comida: "Almuerzo", modo: "Delivery", notas: "Sanguche de pollo" });
  const merienda = meal({ comida: "Merienda", notas: "Yoghurt griego con granola" });

  function afterFullDay() {
    const h = harness(FRIDAY_NIGHT);
    h.store.seed(...fullDay("2026-09-24"));
    return h;
  }

  it("saves them in order from one LLM call, one reply per meal", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, almuerzo, merienda);

    const userMsg = await h.send(BATCH);

    expect(h.llm.calls).toHaveLength(1);
    expect(h.store.rows.slice(4).map((r) => [r.row, r.comida, r.modo])).toEqual([
      [6, "Desayuno", "Casa"], [7, "Almuerzo", "Delivery"], [8, "Merienda", "Casa"],
    ]);
    const replies = h.chat.messages;
    expect(replies.map((m) => m.text.split("\n")[0])).toEqual([
      "✅ Guardado (1/3)", "✅ Guardado (2/3)", "✅ Guardado (3/3)",
    ]);
    expect(replies.every((m) => m.replyTo === userMsg)).toBe(true);
    expect(replies[1].text).toContain("🍽️ Almuerzo · 📍 Delivery");
    expect(replies[1].text).toContain("append · fila 7");
  });

  it("saves nothing if any meal needs clarification, and saves all after the reply", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, { ...almuerzo, calificacion: "", aclaraciones: ["¿El almuerzo fue OK, Mid o Bad?"] }, merienda);

    const userMsg = await h.send(BATCH);

    expect(h.store.writes).toEqual([]);
    expect(h.chat.messages).toHaveLength(1);
    const ask = h.chat.last;
    expect(ask.replyTo).toBe(userMsg);
    expect(ask.text).toContain("1. ✅ 📅 2026-09-25 · 🍽️ Desayuno · 📍 Casa · ⭐ OK · 📝 Yoghurt griego con granola");
    expect(ask.text).toContain("2. ❓ 📅 2026-09-25 · 🍽️ Almuerzo · 📍 Delivery · ⭐ ❓ · 📝 Sanguche de pollo");
    expect(ask.text).toContain("• ¿El almuerzo fue OK, Mid o Bad?");

    h.llm.willExtract(desayuno, { ...almuerzo, calificacion: "Mid" }, merienda);
    await h.send("mid", { replyTo: ask });

    expect(h.llm.calls[1].replied).toContain(`💬 mensaje: ${BATCH}`);
    expect(h.store.rows.slice(4).map((r) => [r.comida, r.calificacion])).toEqual([
      ["Desayuno", "OK"], ["Almuerzo", "Mid"], ["Merienda", "OK"],
    ]);
  });

  it("carries the original message (not every answer) through repeated clarifications", async () => {
    const h = afterFullDay();
    const unsure = { ...almuerzo, calificacion: "", aclaraciones: ["¿El almuerzo fue OK, Mid o Bad?"] };
    h.llm.willExtract(desayuno, unsure, merienda);
    await h.send(BATCH);

    h.llm.willExtract(desayuno, unsure, merienda);
    await h.send("ni idea", { replyTo: h.chat.last });
    const secondAsk = h.chat.last;
    expect(secondAsk.text).toContain(`💬 mensaje: ${BATCH}\n↩️ respuesta: ni idea`);

    h.llm.willExtract(desayuno, { ...almuerzo, calificacion: "Mid" }, merienda);
    await h.send("mid", { replyTo: secondAsk });

    expect(h.llm.calls[2].replied).toContain(`💬 mensaje: ${BATCH}`);
    const thirdFooter = h.chat.last.text;
    expect(thirdFooter).toContain(`💬 mensaje: ${BATCH}\n↩️ respuesta: mid`);
    expect(thirdFooter).not.toContain("ni idea");
    expect(h.store.rows).toHaveLength(7);
  });

  it("proposes the whole batch when one meal collides, and applies it all on accept", async () => {
    const h = afterFullDay();
    h.store.seed({ fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "Mid", notas: "Medialunas" });
    h.llm.willExtract(desayuno, almuerzo, merienda);

    const userMsg = await h.send(BATCH);

    expect(h.store.writes).toEqual([]);
    const proposal = h.chat.last;
    expect(proposal.replyTo).toBe(userMsg);
    expect(proposal.text).toContain("1. ⚠️ Ya tenías Desayuno el 2026-09-25 (fila 6)");
    expect(proposal.text).toContain("⭐ Mid → OK");
    expect(proposal.text).toContain("2. ➕ Nueva");
    expect(proposal.text).toContain("acciones: overwrite · fila 6");

    const before = h.chat.messages.length;
    await h.tap(proposal, "Aceptar");

    expect(h.store.writes).toEqual([
      { op: "overwrite", row: 6 }, { op: "append", row: 7 }, { op: "append", row: 8 },
    ]);
    expect(h.store.rows.find((r) => r.row === 6)).toMatchObject({ calificacion: "OK", notas: "Yoghurt griego con granola" });
    const applied = h.sentSince(before);
    expect(applied.map((m) => m.text.split("\n")[0])).toEqual([
      "✅ Aplicado (1/3)", "✅ Aplicado (2/3)", "✅ Aplicado (3/3)",
    ]);
    expect(applied[0].text).toContain("overwrite · fila 6");
    expect(applied[2].text).toContain("append · fila 8");
    expect(h.chat.buttonsDropped).toEqual([proposal.id]);
  });

  it("revalidates on accept and writes nothing if the sheet changed meanwhile", async () => {
    const h = afterFullDay();
    h.store.seed({ fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "Mid", notas: "Medialunas" });
    h.llm.willExtract(desayuno, almuerzo);
    await h.send(BATCH);
    h.store.seed({ fecha: "2026-09-25", comida: "Almuerzo", modo: "Casa", calificacion: "OK", notas: "Fideos" });

    await expect(h.tap(h.chat.last, "Aceptar")).rejects.toThrow("Ya hay Almuerzo del 2026-09-25");

    expect(h.store.writes).toEqual([]);
  });

  it("rejects a batch that leaves a mandatory hole, writing nothing", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, meal({ comida: "Cena" }));

    await expect(h.send("desayuné casa ok y cené casa ok")).rejects.toThrow("Almuerzo del 2026-09-25");

    expect(h.store.writes).toEqual([]);
  });

  it("rejects a batch with the same meal twice", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, { ...desayuno, notas: "Café" });

    await expect(h.send("desayuné yoghurt y desayuné café")).rejects.toThrow("Desayuno del 2026-09-25 aparece dos veces");

    expect(h.store.writes).toEqual([]);
  });

  it("sends the recaps once, after the whole batch is saved", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, almuerzo, meal({ comida: "Cena", notas: "Pizza" }));

    await h.send("desayuné..., almorcé..., cené...");

    expect(h.chat.messages.map((m) => m.text.split("\n")[0])).toEqual([
      "✅ Guardado (1/3)", "✅ Guardado (2/3)", "✅ Guardado (3/3)", "🌙 Cierre del día 2026-09-25",
    ]);
  });

  it("edits only the replied meal of a saved batch", async () => {
    const h = afterFullDay();
    h.llm.willExtract(desayuno, almuerzo, merienda);
    await h.send(BATCH);
    const savedAlmuerzo = h.chat.messages[1];

    h.llm.willExtract({ ...almuerzo, calificacion: "Mid", accion: "editar" });
    await h.send("fue mid", { replyTo: savedAlmuerzo });

    expect(h.llm.calls[1].replied).toContain("🍽️ Almuerzo · 📍 Delivery");
    const proposal = h.chat.last;
    expect(proposal.text).toContain("Propuesta de edición (fila 7)");
    await h.tap(proposal, "Aceptar");
    expect(h.store.writes.at(-1)).toEqual({ op: "overwrite", row: 7 });
    expect(h.store.rows.find((r) => r.row === 7)?.calificacion).toBe("Mid");
  });

  it("asks when the LLM finds no meal at all", async () => {
    const h = afterFullDay();
    h.llm.willExtract();

    await h.send("hola");

    expect(h.store.writes).toEqual([]);
    expect(h.chat.last.text).toContain("No encontré ninguna comida");
  });

  it("still applies proposals sent before batches existed (single-row callback)", async () => {
    const h = afterFullDay();
    h.store.seed({ fecha: "2026-09-25", comida: "Desayuno", modo: "Casa", calificacion: "Mid", notas: "Medialunas" });
    const legacy = {
      id: 1, chatId: 42, html: "",
      text: "✏️ Propuesta de edición (fila 6)\n⭐ Mid → OK\n\n📅 2026-09-25 · 🍽️ Desayuno · 📍 Casa · ⭐ OK\n📝 Medialunas\nacciones: overwrite · fila 6",
      keyboard: { inline_keyboard: [[{ text: "✅ Aceptar", callback_data: "ok:overwrite:6" }]] },
    };

    await h.tap(legacy, "Aceptar");

    expect(h.store.writes).toEqual([{ op: "overwrite", row: 6 }]);
    expect(h.store.rows.find((r) => r.row === 6)?.calificacion).toBe("OK");
  });
});

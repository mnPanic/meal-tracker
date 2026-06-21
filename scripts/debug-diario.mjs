// Debug del recap de cierre de día. Corre: node --env-file=.dev.vars scripts/debug-diario.mjs [YYYY-MM-DD]
// Compara lo que devuelve "View diario" (fórmulas) contra las comidas crudas (tab Comidas)
// para una fecha, para aislar si el recap vacío es timing de fórmula o parsing.

const URL = process.env.SHEETS_WEBAPP_URL;
const SECRET = process.env.SHEETS_API_SECRET;
const fecha = process.argv[2] || "2026-06-20";

if (!URL || !SECRET) {
  console.error("Faltan SHEETS_WEBAPP_URL / SHEETS_API_SECRET. Corré con: node --env-file=.dev.vars scripts/debug-diario.mjs");
  process.exit(1);
}

async function get(params) {
  const q = new URLSearchParams({ token: SECRET, ...params });
  const r = await fetch(`${URL}?${q}`, { redirect: "follow" });
  return r.json();
}

console.log(`\n=== Comidas crudas (tab Comidas) para ${fecha} ===`);
const dia = await get({ fecha });
console.log(JSON.stringify(dia, null, 2));

console.log(`\n=== View diario (últimos 7) ===`);
const diario = await get({ view: "diario", last: "7" });
if (diario.ok) {
  for (const r of diario.rows) {
    const mark = r.fecha === fecha ? " <<< ESTA" : "";
    console.log(
      `${r.fecha}${mark}  D:${r.desayuno || "-"} | A:${r.almuerzo || "-"} | M:${r.merienda || "-"} | C:${r.cena || "-"} | score:${r.score}`,
    );
  }
  const target = diario.rows.find((r) => r.fecha === fecha);
  console.log(`\nFila ${fecha} en View diario:`);
  console.log(JSON.stringify(target ?? "(no encontrada)", null, 2));
} else {
  console.log(JSON.stringify(diario, null, 2));
}

// OpenAI transcription + structured extraction.

export interface MealEntry {
  fecha: string; // YYYY-MM-DD (resuelta: hoy por defecto, o la fecha relativa/explícita mencionada)
  comida: string; // Desayuno|Almuerzo|Merienda|Cena, o "" si no está claro
  modo: string; // Casa|Delivery|Afuera, o "" si no está claro
  calificacion: string; // OK|Mid|Bad, o "" si no está claro
  notas: string;
  // Por cada campo que no esté claro, una aclaración/pregunta para el usuario.
  aclaraciones: string[];
}

export async function transcribe(apiKey: string, audio: ArrayBuffer): Promise<string> {
  const form = new FormData();
  // Telegram voice notes are OGG/Opus.
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "note.ogg");
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "es");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`transcribe failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { text: string };
  return j.text;
}

const SYSTEM_PROMPT = `Extraés registros de comidas a partir de un mensaje en español argentino.

FECHA: el usuario te da la fecha y hora actual (zona Argentina). Por defecto la comida es de HOY.
Pero si el mensaje menciona otra fecha, RESOLVELA relativa al ahora y usá esa:
- "ayer" = el día anterior; "anteayer" = dos días antes; "el lunes/martes..." = ese día de la
  semana más reciente ya pasado; "el 12" o "12/06" = esa fecha del mes actual.
Devolvé "fecha" siempre en formato YYYY-MM-DD. Si no se menciona ninguna fecha, usá hoy.

HORA: usá la hora actual como pista para inferir cuál de las 4 comidas es cuando el mensaje no lo
dice explícitamente. Horarios típicos en Argentina: Desayuno 06–11, Almuerzo 12–15,
Merienda 16–19, Cena 20–24. Ojo: si el mensaje dice "ayer" u otra fecha, la hora actual ya no es
buena pista para la comida de ESE día → en ese caso, si la comida no está clara, preguntala.

Campos:
- comida: cuál de las 4 comidas del día (Desayuno | Almuerzo | Merienda | Cena).
- modo: de dónde salió la comida (Casa | Delivery | Afuera).
- calificacion: calidad NUTRICIONAL de la comida (OK | Mid | Bad), es decir qué tan saludable es,
  NO cuánto le gustó a la persona. Una pizza o fritura rica es nutricionalmente Bad; una comida
  balanceada con verduras y proteína es OK; algo intermedio es Mid. Juzgá por el alimento en sí,
  ignorando si dijo que estaba rico o no.
- notas: descripción de la comida, en estilo telegráfico (sin verbos como "comí/cené"), conciso.

FORMATO DE NOTAS: "{lugar|evento} - plato". Es decir, si hay un lugar o un evento, va como prefijo
seguido de " - " y después el plato. Reglas:
- modo Casa: normalmente NO hay lugar; las notas son solo el plato (ej: "Yoghurt con chía y granola",
  "Milanesa de soja con arroz"). Si hay un evento/contexto social, usalo de prefijo
  (ej: "Cumple de Nico - picada y pizza").
- modo Delivery o Afuera: SE ESPERA el nombre del lugar/local como prefijo
  (ej: "Audaz - milanesa de pollo con ensalada", "La Cabrera - mila napo con papas", "Daiki - sushi").
- Estilo: español argentino, breve (~3-6 palabras el plato), items separados por coma o "con".

REGLA IMPORTANTE: NO inventes ni infieras datos. Si un campo no está claro o no se menciona,
dejalo como cadena vacía "" y agregá una entrada en "aclaraciones" explicándole al usuario qué
falta o qué no está claro, sugiriendo opciones cuando tenga sentido. Ejemplo de aclaración:
"No me queda claro el modo: ¿fue en Casa, Delivery o Afuera?". Escribí las aclaraciones en español.
EN PARTICULAR: si el modo es Delivery o Afuera y no se menciona el lugar, NO lo inventes: dejá las
notas con el plato pero agregá una aclaración pidiendo el lugar (ej: "¿De qué lugar fue el delivery?").
Si todos los campos están claros, "aclaraciones" debe ser una lista vacía.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fecha: { type: "string", description: "fecha de la comida en formato YYYY-MM-DD (hoy por defecto, o la mencionada)" },
    comida: { type: "string", description: "Desayuno|Almuerzo|Merienda|Cena, o \"\" si no está claro" },
    modo: { type: "string", description: "Casa|Delivery|Afuera, o \"\" si no está claro" },
    calificacion: { type: "string", description: "OK|Mid|Bad (calidad nutricional), o \"\" si no está claro" },
    notas: { type: "string", description: "estilo '{lugar|evento} - plato'; lugar esperado en Delivery/Afuera" },
    aclaraciones: {
      type: "array",
      items: { type: "string" },
      description: "preguntas/aclaraciones para el usuario por cada campo que no esté claro; vacío si todo claro",
    },
  },
  required: ["fecha", "comida", "modo", "calificacion", "notas", "aclaraciones"],
} as const;

// `now` is a human-readable BA datetime with weekday, e.g. "2026-06-15 14:30 (domingo)".
export async function extract(apiKey: string, transcript: string, now: string): Promise<MealEntry> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Ahora es ${now} (Argentina).\nMensaje: ${transcript}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "meal_entry", strict: true, schema: SCHEMA },
      },
    }),
  });
  if (!r.ok) throw new Error(`extract failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(j.choices[0].message.content) as MealEntry;
}

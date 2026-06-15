// OpenAI transcription + structured extraction.

export interface MealEntry {
  fecha: string; // DD/MM/YY
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

Campos:
- comida: cuál de las 4 comidas del día (Desayuno | Almuerzo | Merienda | Cena).
- modo: de dónde salió la comida (Casa | Delivery | Afuera).
- calificacion: calidad NUTRICIONAL de la comida (OK | Mid | Bad), es decir qué tan saludable es,
  NO cuánto le gustó a la persona. Una pizza o fritura rica es nutricionalmente Bad; una comida
  balanceada con verduras y proteína es OK; algo intermedio es Mid. Juzgá por el alimento en sí,
  ignorando si dijo que estaba rico o no.
- notas: texto libre describiendo la comida.

REGLA IMPORTANTE: NO inventes ni infieras datos. Si un campo no está claro o no se menciona,
dejalo como cadena vacía "" y agregá una entrada en "aclaraciones" explicándole al usuario qué
falta o qué no está claro, sugiriendo opciones cuando tenga sentido. Ejemplo de aclaración:
"No me queda claro el modo: ¿fue en Casa, Delivery o Afuera?". Escribí las aclaraciones en español.
Si todos los campos están claros, "aclaraciones" debe ser una lista vacía.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fecha: { type: "string", description: "fecha de hoy en formato DD/MM/YY" },
    comida: { type: "string", description: "Desayuno|Almuerzo|Merienda|Cena, o \"\" si no está claro" },
    modo: { type: "string", description: "Casa|Delivery|Afuera, o \"\" si no está claro" },
    calificacion: { type: "string", description: "OK|Mid|Bad (calidad nutricional), o \"\" si no está claro" },
    notas: { type: "string" },
    aclaraciones: {
      type: "array",
      items: { type: "string" },
      description: "preguntas/aclaraciones para el usuario por cada campo que no esté claro; vacío si todo claro",
    },
  },
  required: ["fecha", "comida", "modo", "calificacion", "notas", "aclaraciones"],
} as const;

export async function extract(apiKey: string, transcript: string, todayDDMMYY: string): Promise<MealEntry> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Today is ${todayDDMMYY}.\nTranscript: ${transcript}` },
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

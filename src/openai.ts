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

HORA: junto al ahora recibís una "comida probable" (comida + fecha) calculada
automáticamente a partir de la hora actual de Argentina (tomando la comida anterior más
cercana; en la madrugada eso es la Cena del día anterior). Usá ESA comida y ESA fecha por
defecto cuando el mensaje no diga otra cosa. Apartate del hint si el mensaje menciona o
implica explícitamente otra comida o fecha (gana lo explícito; resolvé las fechas relativas
como se indica arriba). Si el mensaje es de otra fecha distinta a la del hint y la comida no
está clara, ignorá el hint y preguntala.

CONTEXTO: puede que recibas un resumen de las comidas recientes (últimos días). Usalo solo
como apoyo para entender el mensaje y desambiguar (qué comida del día falta, lugares/eventos
ya mencionados, etc.). No copies datos de ahí: el registro es siempre sobre el mensaje actual.

Campos:
- comida: cuál de las 4 comidas del día (Desayuno | Almuerzo | Merienda | Cena).
- modo: de dónde salió la comida (Casa | Delivery | Afuera).
- calificacion: calidad NUTRICIONAL de la comida (OK | Mid | Bad), es decir qué tan saludable es,
  NO cuánto le gustó a la persona. Una pizza o fritura rica es nutricionalmente Bad; una comida
  balanceada con verduras y proteína es OK; algo intermedio es Mid. Juzgá por el alimento en sí,
  ignorando si dijo que estaba rico o no.
- notas: descripción de la comida en estilo telegráfico (sin verbos como "comí/cené"), conciso
  pero sin dejar detalles afuera (no descartes ingredientes ni cantidades que se mencionen).
  No repitas el modo (Casa/Delivery/Afuera) en las notas, ya va en su propio campo.
  Las notas van SIEMPRE en una sola línea (sin saltos de línea).

FORMATO DE NOTAS: "{lugar|evento} - plato". Es decir, si hay un lugar o un evento, va como prefijo
seguido de " - " y después el plato. Reglas:
- modo Casa: normalmente NO hay lugar; las notas son solo el plato (ej: "Yoghurt con chía y granola",
  "Milanesa de soja con arroz"). Si hay un evento/contexto social, usalo de prefijo
  (ej: "Cumple de Nico - picada y pizza").
- modo Delivery o Afuera: SE ESPERA el nombre del lugar/local como prefijo
  (ej: "Audaz - milanesa de pollo con ensalada", "La Cabrera - mila napo con papas", "Daiki - sushi").
- Estilo: español argentino, conciso pero completo, items separados por coma o "con".

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

// Sección extra del prompt para cuando se está editando un registro existente.
const EDIT_SECTION = `

EDICIÓN: estás editando un registro que YA existe (te paso "Registro actual"). El mensaje es
una corrección sobre ese registro. Aplicá SOLO los cambios que la corrección indica
explícitamente y conservá tal cual todos los campos no mencionados. Devolvé el registro
COMPLETO ya actualizado. La fecha del registro actual NO cambia salvo que la corrección la
cambie explícitamente. No pidas aclaraciones por campos que ya estaban completos en el
registro actual; "aclaraciones" queda vacío salvo que la corrección introduzca una ambigüedad
nueva (ej: cambiar el modo a Delivery/Afuera sin dar el lugar).`;

// `now` is a human-readable BA datetime with weekday, e.g. "2026-06-15 14:30 (domingo)".
// `hint` is the deterministic meal+date guessed from the current BA hour.
// `recientes` is an optional preformatted block with the last days' meals, for context.
// `base` (when set) is the currently-saved entry being edited; `transcript` is the correction.
export async function extract(
  apiKey: string,
  transcript: string,
  now: string,
  hint: { fecha: string; comida: string },
  recientes = "",
  base?: MealEntry,
): Promise<MealEntry> {
  const contexto = recientes ? `\nComidas recientes (contexto):\n${recientes}` : "";
  const system = base ? SYSTEM_PROMPT + EDIT_SECTION : SYSTEM_PROMPT;
  const userContent = base
    ? `Ahora es ${now} (Argentina).${contexto}\nRegistro actual: ${JSON.stringify({
        fecha: base.fecha,
        comida: base.comida,
        modo: base.modo,
        calificacion: base.calificacion,
        notas: base.notas,
      })}\nCorrección: ${transcript}`
    : `Ahora es ${now} (Argentina).\nPor la hora, lo más probable es la ${hint.comida} del ${hint.fecha}.${contexto}\nMensaje: ${transcript}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
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

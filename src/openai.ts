// OpenAI transcription + structured extraction.

export interface MealEntry {
  fecha: string; // YYYY-MM-DD (resuelta: hoy por defecto, o la fecha relativa/explícita mencionada)
  comida: string; // Desayuno|Almuerzo|Merienda|Cena, o "" si no está claro
  modo: string; // Casa|Delivery|Afuera, o "" si no está claro
  calificacion: string; // OK|Mid|Bad, o "" si no está claro
  notas: string;
  accion: string; // "agregar" (comida nueva) | "editar" (corrección de una ya registrada)
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

PRIORIDAD: lo que dice el usuario sobre fecha, comida, detalles y correcciones SIEMPRE
prevalece sobre cualquier inferencia del contexto. Nunca reasignes una comida explícita para
llenar un pendiente. Si esa indicación dejaría un hueco obligatorio, explicá el error en
"aclaraciones" y pedí resolverlo; no cambies su intención para hacerla encajar.

CONTEXTO: recibís una única tabla de los últimos 7 días, ordenada de antiguo a reciente.
Cada celda contiene el registro completo (modo/calificación/notas) o su estado:
- Pendiente: todavía no se cargó y no hay una comida posterior registrada.
- Pendiente (opcional): Merienda sin cargar y sin ningún registro posterior.
- Omitida: Merienda sin cargar que tiene una comida posterior, incluso de otro día. No la pidas.
- Sin registros previos: está antes del inicio conocido; no implica que deba rellenarse.
Los pendientes son posiciones de la secuencia aún sin cargar, no una afirmación de que ya
ocurrieron por la hora actual. No hay un hint ni una lista separada de pendientes.
Usá los valores cargados para conservar campos al editar, pero no copies detalles hacia comidas nuevas.

ORDEN DE CARGA: el usuario SIEMPRE carga en orden y sin agujeros:
Desayuno → Almuerzo → Merienda → Cena → Desayuno del día siguiente.
Desayuno, Almuerzo y Cena son obligatorias. Merienda es opcional: si el usuario indica Cena,
puede omitir Merienda; si no especifica comida, Merienda sigue pendiente y no se saltea por defecto.
Para mensajes sin comida/fecha, continuá desde la primera pendiente de la secuencia conocida,
de atrás hacia adelante. No saltes días o comidas por la hora del reloj.
Una obligatoria vacía antes de un registro posterior es un ERROR de consistencia, no un pendiente
normal. Si la nueva carga generaría ese hueco, reportalo en "aclaraciones" y no inventes registros.
Si no hay registros o no alcanza el contexto para identificar la comida, preguntá.
Las correcciones explícitas pueden apuntar a registros anteriores.

FECHA: resolvé las fechas explícitas según el mensaje y el reloj de Argentina.
- "ayer" = día calendario anterior; "anteayer" = dos días antes.
- "el lunes/martes..." = ese día de la semana más reciente ya pasado.
- "el 12" o "12/06" = esa fecha del mes actual.
- Entre las 00:00 y las 05:59, "hoy" se refiere al día calendario anterior hasta irse a dormir,
  salvo que el usuario diga que ya durmió, se despertó o comenzó el nuevo día, o dé otra fecha explícita.
- Sin fecha explícita, seguí la secuencia de la tabla; la hora no adelanta la carga.
Devolvé "fecha" siempre como YYYY-MM-DD.

EJEMPLOS:
- Si la última cargada es Desayuno de anteayer, un mensaje sin fecha/comida sigue con Almuerzo
  de anteayer, aunque ahora sea la hora de cenar.
- Si la última cargada es Almuerzo, un mensaje sin comida sigue con Merienda; "cené..." va a Cena
  y deja Merienda omitida.
- Si el usuario dice "hoy almorcé" y ya está cargado, editá ese Almuerzo; no lo reasignes.
- Si falta Almuerzo y el usuario dice "cené", mantené Cena y reportá que falta Almuerzo.
- Si ahora es 2026-07-23 02:00, "hoy merendé" es Merienda del 2026-07-22; "ya dormí y desayuné"
  es Desayuno del 2026-07-23. Validá que la carga no deje huecos obligatorios.

ACCIÓN: elegí una de dos y devolvela en "accion":
- "agregar": es una comida NUEVA, que todavía no figura en las comidas recientes de ese día.
- "editar": es una corrección o complemento de una comida que YA figura en las comidas recientes
  (mismo día y misma comida). Si la comida que estás registrando ya aparece cargada ese día,
  usá "editar". Al editar, devolvé el registro COMPLETO ya actualizado: partí de los valores
  actuales de esa comida (te los paso en el contexto) y aplicá SOLO los cambios que el mensaje
  indica, conservando lo demás. No pidas aclaraciones por campos que ya estaban completos.
Si el usuario está respondiendo a un registro ya guardado (te lo paso aparte), casi siempre es
"editar" ese registro.

Campos:
- comida: cuál de las 4 comidas del día (Desayuno | Almuerzo | Merienda | Cena).
- modo: de dónde salió la comida (Casa | Delivery | Afuera).
- calificacion: calidad NUTRICIONAL de la comida (OK | Mid | Bad), es decir qué tan saludable es,
  NO cuánto le gustó a la persona. Conservá la calificación que indica el usuario; si falta,
  preguntala, no la inventes a partir del plato.
- notas: descripción de la comida en estilo telegráfico (sin verbos como "comí/cené"), conciso
  pero sin dejar detalles afuera (no descartes ingredientes ni cantidades que se mencionen).
  No repitas el modo (Casa/Delivery/Afuera) en las notas, ya va en su propio campo.
  Las notas van SIEMPRE en una sola línea (sin saltos de línea).

FORMATO DE NOTAS: incluí únicamente los detalles mencionados. Lugar, evento, plato, ingredientes
y cantidades son OPCIONALES. Si hay lugar/evento y plato, usá "{lugar|evento} - plato".
Si solo hay uno, escribí solo ese dato, sin guiones vacíos. Si no hay detalles, notas = "". Reglas:
- modo Casa: normalmente NO hay lugar; las notas son solo el plato (ej: "Yoghurt con chía y granola",
  "Milanesa de soja con arroz"). Si hay un evento/contexto social, usalo de prefijo
  (ej: "Cumple de Nico - picada y pizza").
- modo Delivery o Afuera: si se menciona el lugar/local, usalo como prefijo cuando también haya plato
  (ej: "Audaz - milanesa de pollo con ensalada", "La Cabrera - mila napo con papas", "Daiki - sushi").
- Estilo: español argentino, conciso pero completo, items separados por coma o "con".

DATOS OBLIGATORIOS: solo modo y calificación requieren que el usuario los aporte (en el mensaje
o en el contexto del registro que está completando/editando). Si falta alguno, dejalo en "" y
preguntalo en "aclaraciones", en español. Fecha y comida se resuelven con el mensaje y la secuencia;
si no se puede identificar el registro o hay un hueco obligatorio, reportá ese problema.
No pidas lugar, plato ni detalles de notas: su ausencia no bloquea guardar, desde el primer mensaje,
sin necesidad de que el usuario responda "irrelevante" o "no importa". No agregues avisos como
"el lugar queda sin especificar" a aclaraciones: esa lista es solo para preguntas o errores
que realmente impiden guardar. Si modo, calificación y la ubicación en la secuencia están resueltos,
aclaraciones = [], aunque notas esté vacío. Nunca inventes los datos omitidos.
Ejemplos con fecha/comida resueltas y sin huecos:
- "delivery mid pizza" → modo Delivery, calificacion Mid, notas "pizza", aclaraciones [].
- "el 2/9 almorcé delivery ok, lugar cilantro" → notas "Cilantro", aclaraciones []; no preguntes plato.
- "casa ok" → modo Casa, calificacion OK, notas "", aclaraciones [].`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fecha: { type: "string", description: "fecha de la comida en formato YYYY-MM-DD (hoy por defecto, o la mencionada)" },
    comida: { type: "string", description: "Desayuno|Almuerzo|Merienda|Cena, o \"\" si no está claro" },
    modo: { type: "string", description: "Casa|Delivery|Afuera, o \"\" si no está claro" },
    calificacion: { type: "string", description: "OK|Mid|Bad (calidad nutricional), o \"\" si no está claro" },
    notas: { type: "string", description: "Detalles opcionales mencionados, sin inventar ni pedir faltantes; vacío si no hay detalles. Separador ' - ' solo si hay lugar/evento y plato." },
    accion: { type: "string", enum: ["agregar", "editar"], description: "agregar = comida nueva; editar = corrección de una ya registrada ese día" },
    aclaraciones: {
      type: "array",
      items: { type: "string" },
      description: "Solo modo/calificación faltantes o problemas para identificar el registro o mantener la secuencia. Nunca preguntar por lugar, plato o notas; [] si se puede guardar.",
    },
  },
  required: ["fecha", "comida", "modo", "calificacion", "notas", "accion", "aclaraciones"],
} as const;

// `now` is a human-readable BA datetime with weekday, e.g. "2026-06-15 14:30 (domingo)".
// `recientes` is the meal table, including pending and skipped slots.
// `replied` is the full text of the message the user is replying to.
export async function extract(
  apiKey: string,
  transcript: string,
  now: string,
  recientes = "",
  replied = "",
): Promise<MealEntry> {
  const contexto = recientes
    ? `\nComidas recientes (contexto, con modo/calificación/notas):\n${recientes}`
    : "";
  const replyCtx = replied
    ? `\nMensaje completo al que el usuario está RESPONDIENDO (contexto previo, puede ser una aclaración o un registro guardado; no implica que ya esté guardado). Conservá los datos ya entendidos salvo que el mensaje actual los corrija. La tabla actual prevalece sobre cualquier tabla histórica incluida en este mensaje:\n${replied}\nFin del mensaje respondido.\n`
    : "";
  const system = SYSTEM_PROMPT;
  const userContent = `Ahora es ${now} (Argentina).${contexto}${replyCtx}\nMensaje: ${transcript}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
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

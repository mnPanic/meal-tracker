# meal-tracker

Bot de Telegram para registrar comidas en un Google Sheet desde el celular. Mandás un mensaje
de texto **o una nota de voz** ("almorcé milanesa con ensalada en casa"), el bot lo transcribe y
estructura con OpenAI y escribe la fila en la planilla. Stateless, uso personal (~10 mensajes/día),
corre gratis en Cloudflare Workers.

## Arquitectura

```mermaid
flowchart TD
    U[📱 Telegram] -->|webhook POST| W

    subgraph CF[Cloudflare Worker · Hono]
      W[/webhook/] --> AUTH{secret token OK?}
      AUTH -->|no| F[403]
      AUTH -->|sí| K{tipo de update}
      K -->|message| M[handleMessage]
      K -->|callback_query| CB[handleCallback]
    end

    M -->|voz/audio| TR[OpenAI: transcribe]
    M -->|texto| EX
    TR --> EX[OpenAI: extract → JSON]
    CB -->|re-extrae texto/transcript| EX
    EX --> OK{completo y claro?}
    OK -->|no| ASK[pregunta aclaraciones · no guarda]
    OK -->|sí| RB[readDay fecha]
    RB --> COL{ya existe esa Comida?}
    COL -->|no| AP[append]
    COL -->|sí| BTN[botones: Reemplazar / Cancelar]
    BTN -.callback.-> CB

    AP --> GS
    CB --> GS

    subgraph G[Apps Script Web App]
      GS[doGet / doPost] --> SH[(Sheet 'Comidas')]
    end

    AP --> R[✅ respuesta + botón Editar]
    AP -->|si es Cena| REC[recap día/semana/mes · readDiario/Semanal/Mensual]
    REC --> GS
    EX -. OpenAI API .-> OAI[gpt-4o-mini]
    TR -. OpenAI API .-> OAI
```

### Componentes

| Pieza | Archivo | Rol |
|---|---|---|
| Worker / webhook | `src/index.ts` | Recibe updates de Telegram, orquesta el flujo, responde. |
| Telegram | `src/telegram.ts` | Helpers de la Bot API (descarga de archivos para notas de voz). |
| Transcripción + extracción | `src/openai.ts` | `gpt-4o-mini-transcribe` (voz→texto) + `gpt-4o-mini` structured outputs → `MealEntry`. |
| Cliente del sheet | `src/sheets.ts` | Llama al Apps Script (read/append/overwrite + views), con token. |
| Backend del sheet | `apps-script/Code.gs` | Web app que lee/escribe la planilla. Contrato en `apps-script/README.md`. |

## Flujo

1. **Mensaje de texto o nota de voz** → la voz se transcribe con `transcribe()`, después
   `extract()` saca `comida / modo / calificacion / notas`. Ambos caminos comparten el pipeline.
2. **No infiere**: si falta algo o el modo es Delivery/Afuera sin lugar, **pregunta** y no guarda.
3. **Read-before-write**: lee el día; si ya hay esa comida, ofrece **Reemplazar / Cancelar**
   (la fila viaja en el `callback_data`, stateless). No se agregan duplicados de la misma comida.
4. **Guarda** → `append`, responde `✅ Guardado` con botón **✏️ Editar**.
5. **Editar**: tocás el botón → respondés (texto o voz) con la corrección → `overwrite` de esa fila.
6. **Cierres de ciclo**: la Cena es el último momento del día. Al hacer `append` de una Cena, el bot
   manda el **recap del día** (`readDiario`); si esa fecha es domingo, también el **semanal**
   (`readSemanal`); si es el último día del mes, el **mensual** (`readMensual`). Event-driven, sin cron.

Las respuestas que vienen de una nota de voz incluyen el transcript en un footer (`🎤 …`) para
debugging; ese mismo footer es lo que deja al flujo de colisión re-extraer de forma stateless.

### Reglas de dominio

- **`calificacion`** (OK/Mid/Bad) = calidad **nutricional**, no cuánto gustó.
- **`Score`** (columna E) es **fórmula del sheet**: `SWITCH(Modo) + SWITCH(Calificacion)`, rango 0–5.
  El bot nunca lo setea; el Apps Script reescribe la fórmula por fila (con `;`, locale español).
- **`Notas`**: formato `{lugar|evento} - plato`. Casa = solo el plato; Delivery/Afuera = lugar + plato.
- **`Fecha`**: hoy por defecto (`America/Argentina/Buenos_Aires`), pero si el mensaje menciona otra
  fecha ("ayer", "el lunes", "12/06") OpenAI la resuelve y se usa esa. Se le pasa fecha+hora actual
  al modelo para inferir la comida (horarios típicos: desayuno 06–11, almuerzo 12–15, etc.).

### Garantías del backend (Apps Script)

- `append`/`overwrite` solo tocan filas dentro de una **ventana reciente** (últimos 7 días, sin
  futuro), con chequeo server-side usando el reloj de BA. `append` exige `fecha` (sin default).
- Acceso "Anyone" + **secret token** en cada request (la URL puede ser pública, el token no).
- Detalle completo del contrato: [`apps-script/README.md`](apps-script/README.md).

## Datos del sheet

Pestañas: **Comidas** (datos), Eventos, **View diario**, **View semanalmensual**.
Columnas de Comidas: `Fecha | Comida | Modo | Calificacion | Score | Notas`.
Las views (diario/semanal/mensual) se leen pero no se escriben.

## Deploy

```bash
npm install
npx wrangler deploy
```

### Secrets (Worker)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # de @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # random; valida cada webhook
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SHEETS_WEBAPP_URL        # URL /exec del Apps Script
npx wrangler secret put SHEETS_API_SECRET        # = Script Property API_SECRET
```

Registrar el webhook (una vez):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"<WORKER_URL>/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

### Apps Script

Pegar `apps-script/Code.gs` en Extensions → Apps Script de la planilla, setear el Script Property
`API_SECRET`, y **Deploy → Web app** (Execute as: Me, Who has access: Anyone). Cada cambio de
código requiere **New version** sobre el mismo deployment para que tome.

## Desarrollo

```bash
npx tsc --noEmit     # typecheck
npx wrangler dev     # local (usa .dev.vars)
npx wrangler tail    # logs en vivo
```

Los mensajes del bot incluyen detalle técnico (modo dev): operación + fila ejecutada
(`append · fila 413`) y, ante un error, el stack crudo formateado.

## Pendientes / futuro

- (sin pendientes grandes por ahora)

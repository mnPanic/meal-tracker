# Operación (runbook)

Guía operativa del día a día: deployar el Worker, deployar cambios en el Apps Script, ver logs,
rotar secrets y diagnosticar problemas. El detalle de arquitectura está en [`README.md`](README.md);
el contrato del backend del sheet en [`apps-script/README.md`](apps-script/README.md).

## Las dos piezas que se deployan por separado

| Pieza | Dónde vive | Cómo se deploya |
|---|---|---|
| **Worker** (`src/`) | Cloudflare | `npx wrangler deploy` |
| **Backend del sheet** (`apps-script/Code.gs`) | Google Apps Script | pegar en el editor + **New version** sobre el deployment |

Un cambio en `src/` **no** afecta al Apps Script y viceversa. Si tocaste el contrato entre ambos
(formato de request/response), deployá **los dos**.

---

## Worker (Cloudflare)

### Deployar

```bash
npm install            # solo la primera vez o si cambió package.json
npx tsc --noEmit       # typecheck antes de deployar
npm test               # corre vitest (test/logic.test.ts)
npx wrangler deploy
```

`wrangler deploy` sube `src/index.ts` (entrypoint, ver `wrangler.toml`) y deja la nueva versión
activa al instante. No hace falta re-registrar el webhook salvo que cambie la URL del Worker.

### Desarrollo local

```bash
npx wrangler dev       # corre el Worker local leyendo .dev.vars
```

`.dev.vars` (no commiteado, ver `.dev.vars.example`) reemplaza a los secrets en local. Para probar
el webhook contra el local necesitás exponerlo (p.ej. túnel) y apuntar el `setWebhook` ahí, o
mandar POSTs a mano.

### Ver logs

```bash
npx wrangler tail                          # stream de logs en vivo
npx wrangler tail --format pretty          # más legible
npx wrangler tail --status error           # solo requests con error
npx wrangler tail --search "append"        # filtrar por texto
```

`wrangler tail` muestra solo eventos nuevos mientras el comando corre. `wrangler.toml` habilita
Workers Logs persistentes con muestreo al 100%; se activa al deployar el Worker. Para historial,
usar el dashboard de Cloudflare (Workers & Pages → meal-tracker → Logs / Observability).
La retención y los límites dependen del plan; habilitar logs no recupera eventos anteriores.
Además, **los propios mensajes del bot en Telegram traen detalle técnico** (operación + fila, p.ej.
`append · fila 413`, y el stack crudo ante un error) — suele ser el primer lugar para mirar.

### Diagnosticar respuestas de Apps Script

Buscar `sheets_request_failed` en Workers Logs o ver los eventos en vivo:

```bash
npx wrangler tail --format json --search sheets_request_failed
```

Cada fallo registra `operation`, `fecha`/`view`/`row` cuando corresponda, `attempt`, `status`,
`contentType`, `finalHost`, `redirected`, `durationMs`, `retry` y `delayMs`.
Si la respuesta no es JSON, `preview` contiene hasta 600 caracteres de texto legible: elimina
etiquetas, scripts y estilos, decodifica entidades comunes y oculta tokens y URLs. No se registra
el cuerpo de la petición ni el contenido JSON de comidas. Si no hubo respuesta HTTP, `status`
queda ausente y `error` indica timeout o fallo de red/lectura del stream.

Las lecturas GET hacen hasta **3 intentos**, con timeout de **10 segundos por intento**, pausas de
500 ms y 1 s más hasta 249 ms aleatorios. Reintentan HTTP 408/429/5xx, fallos de transporte y
respuestas 2xx que no cumplen el contrato JSON. Respetan `Retry-After`; si pide más de 10 s de
espera, terminan con error en lugar de reintentar antes de tiempo. HTTP 401/403/404 y errores de
aplicación `{ok:false}` no se reintentan. `sheets_recovered` confirma una lectura recuperada.

POST (`append`/`overwrite`) usa el mismo diagnóstico, pero **nunca se reintenta automáticamente**:
la escritura puede haberse completado aunque falle la respuesta. Antes de repetirla, verificar
la planilla. El cuerpo de una respuesta tiene un límite de 1 MiB.

No filtrar solo por `--status error`: el webhook captura las excepciones y responde HTTP 200,
por lo que un fallo de Apps Script puede aparecer dentro de una invocación exitosa.
Un HTML/500 que luego desaparece no demuestra un cold start. Correlacionar hora y mensaje con
**Executions** del Apps Script para distinguir errores del script, cuotas y fallos de Google.

### Secrets (Worker)

Listar / setear / borrar:

```bash
npx wrangler secret list
npx wrangler secret put <NOMBRE>           # pide el valor por stdin
npx wrangler secret delete <NOMBRE>
```

Secrets que usa (detalle en `wrangler.toml`):

| Secret | Qué es |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token de @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | random; valida que el POST viene de Telegram |
| `OPENAI_API_KEY` | de platform.openai.com |
| `SHEETS_WEBAPP_URL` | URL `/exec` del Apps Script |
| `SHEETS_API_SECRET` | = Script Property `API_SECRET` del Apps Script |
| `ALLOWED_CHAT_ID` | tu chat id de Telegram (candá el bot a vos) |

### Webhook de Telegram

Registrar (una vez, o si cambió la URL del Worker o el webhook secret):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"<WORKER_URL>/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

Diagnóstico del webhook (muy útil: muestra último error de entrega, pending updates, etc.):

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

---

## Apps Script (backend del sheet)

Proyecto: <https://script.google.com/u/0/home/projects/16G6Owv9DC6VCiun7yB2rlCktHyz8ZYq5peur-iEB8uSlQDeKz3zoScAP/edit>

(También se llega desde la planilla: **Extensions → Apps Script**.)

### Deployar un cambio de código

El Apps Script **no se deploya desde la terminal** (no usamos `clasp`); es copy-paste + versionado
en el editor web:

1. Editar `apps-script/Code.gs` en el repo (fuente de verdad).
2. Abrir el proyecto (link de arriba) y **pegar el contenido completo** de `Code.gs` en el editor.
3. **Deploy → Manage deployments → ✏️ (editar el deployment existente) → Version: New version → Deploy.**
   - Crear *New version* sobre el **mismo deployment** mantiene la **misma URL `/exec`**, así no hay
     que tocar el secret `SHEETS_WEBAPP_URL`.
   - **Ojo:** guardar (💾) en el editor **no** publica el cambio. La web app sigue sirviendo la
     última *version* deployada hasta que crees una nueva.
4. Si es la primera vez: **Deploy → New deployment → Web app**, con **Execute as: Me** y
   **Who has access: Anyone** (necesario para que el Worker llame sin login interactivo). Eso da una
   URL nueva → actualizar el secret `SHEETS_WEBAPP_URL` del Worker.

### Secret del Apps Script (`API_SECRET`)

Vive como **Script Property**. Setearlo/cambiarlo:

- **Project Settings → Script Properties → Add/edit `API_SECRET`**, o
- pegar el valor en `setSecret()` (`Code.gs:38`) y ejecutar esa función una vez desde el editor.

Tiene que **coincidir** con el secret `SHEETS_API_SECRET` del Worker. Para rotarlo: cambiar en los
dos lados (Script Property + `wrangler secret put SHEETS_API_SECRET`).

### Ver logs / debug del Apps Script

- **Executions**: en el editor, panel izquierdo → **Executions** (▶). Lista cada `doGet`/`doPost`
  con estado y duración. Click → ver `console.log` y errores/stack.
- **Probar a mano** sin pasar por el bot:

  ```bash
  # read (GET): requiere token
  curl "<SHEETS_WEBAPP_URL>?fecha=2026-06-15&token=<API_SECRET>"

  # append (POST)
  curl -X POST "<SHEETS_WEBAPP_URL>" -H "content-type: application/json" \
    -d '{"action":"append","token":"<API_SECRET>","fecha":"2026-06-15",
         "comida":"Cena","modo":"Casa","calificacion":"OK","notas":"tofu salteado"}'
  ```

  Recordá que todas las respuestas son HTTP 200; el éxito/error está en el campo `ok` del JSON.

---

## Troubleshooting rápido

| Síntoma | Mirar |
|---|---|
| El bot no responde nada | `getWebhookInfo` (¿last_error?), `wrangler tail`, y que `ALLOWED_CHAT_ID` sea tu chat. |
| Responde pero no escribe en el sheet | `wrangler tail` + Executions del Apps Script; ¿`unauthorized`? → desajuste `SHEETS_API_SECRET` ↔ `API_SECRET`. |
| `fecha fuera de la ventana permitida` | Es por diseño: append/overwrite solo tocan los últimos 7 días (sin futuro). |
| Cambié el `Code.gs` y no toma | Faltó crear **New version** del deployment (guardar no alcanza). |
| Cambié la URL del Worker | Re-registrar el webhook (`setWebhook`). |
| Error de OpenAI / transcripción | `wrangler tail`; verificar `OPENAI_API_KEY` y saldo en platform.openai.com. |

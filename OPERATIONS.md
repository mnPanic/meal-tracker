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
`contentType`, `finalHost`, `redirected`, `durationMs`, `timeoutMs`, `elapsedMs`, `budgetMs`,
`remainingMs`, `retry` y `delayMs`.
Si la respuesta no es JSON, `preview` contiene hasta 600 caracteres de texto legible: elimina
etiquetas, scripts y estilos, decodifica entidades comunes y oculta tokens y URLs. No se registra
el cuerpo de la petición ni el contenido JSON de comidas. Si no hubo respuesta HTTP, `status`
queda ausente y `error` indica timeout o fallo de red/lectura del stream. Los timeouts distinguen
si se estaba esperando la respuesta HTTP o leyendo su cuerpo. `sheets_slow_response` registra
lecturas/escrituras exitosas de 10 s o más; incluye duración y estado, sin contenido de comidas.

Cada lectura GET dispone de **hasta 5 minutos en total**, incluyendo solicitudes y pausas.
`SHEETS_READ_RETRY_MINUTES` en `wrangler.toml` configura ese presupuesto (también se puede
sobrescribir en `.dev.vars` para pruebas locales). Cada intento tiene un timeout de **hasta 30 s**,
acortado al tiempo restante. Las pausas crecen **1, 2, 4, 8, 16, 30 s**, con hasta 999 ms de
variación aleatoria y un máximo de 30 s. No se espera si la lectura responde bien.
Reintentan HTTP 408/429/5xx, fallos de transporte y respuestas 2xx sin el contrato JSON.
Respetan `Retry-After`, incluso si excede los 30 s; si la pausa no deja tiempo para otro intento,
terminan con error. HTTP 401/403/404 y errores de aplicación `{ok:false}` no se reintentan.
`sheets_recovered` confirma recuperación e incluye `elapsedMs` con el tiempo total de esa lectura.
El presupuesto es **por lectura**, no por mensaje: el contexto, la lectura previa a escritura y
los resúmenes pueden acumular más tiempo.

POST (`append`/`overwrite`) usa el mismo diagnóstico, pero **nunca se reintenta automáticamente**:
la escritura puede haberse completado aunque falle la respuesta. Antes de repetirla, verificar
la planilla. El cuerpo de una respuesta tiene un límite de 1 MiB.

El webhook confirma HTTP 200 al aceptar el trabajo persistente; los fallos posteriores aparecen
en el Workflow, no en esa respuesta HTTP. No limitar la búsqueda al evento HTTP del webhook.
Un HTML/500 que luego desaparece no demuestra un cold start. Correlacionar hora y mensaje con
**Executions** del Apps Script para distinguir errores del script, cuotas y fallos de Google.

### Procesamiento persistente de Telegram

El deploy configura el Workflow `meal-tracker-processing` (binding `MEAL_WORKFLOW`, clase
`MealWorkflow`). El webhook espera a que `createBatch` acepte `telegram-<update_id>` y responde
enseguida; las consultas, OpenAI, escrituras y respuestas de Telegram se ejecutan en el Workflow.
Los reenvíos del mismo update se omiten mientras la instancia siga retenida por Cloudflare.
Si falla la aceptación persistente, el webhook devuelve 503 para permitir que Telegram reenvíe.

El paso del Workflow tiene **cero reintentos** y un límite de una hora: solo el cliente de Sheets
reintenta GET. Esto evita reejecutar todo el mensaje ante un error de escritura o de respuesta.
Si hay un error, el bot intenta avisarlo en Telegram y la instancia queda fallida.
No reiniciar manualmente una instancia fallida sin comprobar antes si llegó a guardar la comida.
`wrangler dev` permite probar el Workflow localmente. El cambio requiere desplegar el Worker;
no requiere cambios en Apps Script ni volver a registrar el webhook.

Antes de activar en producción, comprobar el plan de Workers: el plan Free limita las
subrequests externas a 50 por invocación. Las siete lecturas paralelas y sus redirecciones
pueden consumir ese límite antes de agotar los cinco minutos si los fallos son persistentes.
Esta implementación no elimina ese límite; para ese caso hace falta un plan con mayor cupo
o reducir las siete lecturas a una consulta de rango en Apps Script.
Ver [límites de Workflows](https://developers.cloudflare.com/workflows/reference/limits/).

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

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

Los logs salen en vivo mientras el comando corre; no hay retención larga en el plan free. Para
historial usar el dashboard de Cloudflare (Workers & Pages → meal-tracker → Logs / Observability).
Además, **los propios mensajes del bot en Telegram traen detalle técnico** (operación + fila, p.ej.
`append · fila 413`, y el stack crudo ante un error) — suele ser el primer lugar para mirar.

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

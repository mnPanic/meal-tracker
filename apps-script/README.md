# Sheets web app — interface contract

A single deployed Apps Script web app URL backs all sheet access. Treat it as a black box with
three operations. The Worker holds the URL in the `SHEETS_WEBAPP_URL` secret.

All responses are JSON. Failures return `{ "ok": false, "error": "<reason>" }` with HTTP 200
(Apps Script web apps don't expose status codes cleanly, so check `ok`).

## Auth

The web app is deployed with access **"Anyone"** (required so the Worker can call it without an
interactive Google login), so every request must carry a **shared secret token**:
- GET: `&token=<secret>` query param.
- POST: `"token":"<secret>"` field in the JSON body.

Requests without the matching token get `{ "ok": false, "error": "unauthorized" }`. The secret
lives as a **Script Property** named `API_SECRET` (Project Settings → Script Properties, or run the
`setSecret()` helper once), and as the `SHEETS_API_SECRET` Worker secret. Rotate by changing both.

## read — `GET ?fecha=YYYY-MM-DD`

`fecha` is optional; defaults to **today** (Buenos Aires time).

```
GET <url>?fecha=2026-06-15
→ {
    "ok": true,
    "fecha": "2026-06-15",
    "entries": [
      { "row": 412, "comida": "Almuerzo", "modo": "Casa",
        "calificacion": "OK", "score": 5, "notas": "milanesa con ensalada" }
    ]
  }
```

Read-only. `row` is the sheet row number, used to target an `overwrite`.

## append — `POST {action:"append", ...}`

```
POST <url>   body: { "action":"append", "fecha":"2026-06-15",
                     "comida":"Cena", "modo":"Casa",
                     "calificacion":"OK", "notas":"tofu salteado" }
→ { "ok": true, "row": 413 }
→ { "ok": false, "error":"falta fecha" }                                 // fecha is required
→ { "ok": false, "error":"fecha fuera de la ventana permitida ..." }     // outside last 7 days
```

Adds a **new** row dated **`fecha`** (REQUIRED, no default). Score is written as the per-row
formula. Never overwrites. `fecha` must fall within the allowed window (last 7 days, no future).

## overwrite — `POST {action:"overwrite", row, ...}`

```
POST <url>   body: { "action":"overwrite", "row":413,
                     "comida":"Cena", "modo":"Delivery",
                     "calificacion":"Mid", "notas":"pedí sushi" }
→ { "ok": true, "row": 413 }                                          // success
→ { "ok": false, "error":"row fuera de la ventana permitida ..." }    // row too old / future
```

Updates fields + Score formula in `row`, **only if that row's Fecha is within the allowed window**
(last 7 days). The date itself is preserved (not changed). This is the only way to change existing
data, and it is sandboxed to the recent window so a stale/wrong row number cannot corrupt history.

## read views — `GET ?view=diario|semanal|mensual` (read-only)

Summary tabs, for reporting when a day/week/month ends. Optional `&last=N` caps to the most
recent N rows.

```
GET <url>?view=diario&last=7
→ { "ok":true, "view":"diario", "rows":[
     { "fecha":"2026-06-15", "evento":"", "desayuno":"Casa - OK",
       "almuerzo":"Delivery - Mid", "merienda":"", "cena":"Casa - OK",
       "score":3.5, "notas":{ "desayuno":"...", "almuerzo":"...", "merienda":"", "cena":"..." } } ] }

GET <url>?view=semanal&last=1
→ { "ok":true, "view":"semanal", "rows":[
     { "inicio":"2026-06-08", "label":"2026-06 W2", "promedio":3.95, "eventos":"" } ] }

GET <url>?view=mensual&last=1
→ { "ok":true, "view":"mensual", "rows":[
     { "inicio":"2026-06-01", "label":"2026-06", "promedio":4.19, "eventos":"FDE Rosario day 1 · ..." } ] }
```

`semanal` reads cols A–D and `mensual` cols F–I of the single "View semanalmensual" tab (two
side-by-side tables). `score`/`promedio` are the sheet's computed averages — read straight through.

## Guarantees

- append and overwrite **only ever affect rows within a recent window** (last 7 days, no future).
- The window is computed inside the script in `America/Argentina/Buenos_Aires` — not trusted from the caller.
- append never overwrites; overwrite never appends.
- Score is always (re)written by the script; callers never set it.
- Writes are serialized with a script lock.

# Telegram Meal-Tracker Bot — Build Notes

A voice-note → Google Sheets meal logger. Stateless, personal use, ~10 messages/day.

## The pick: Cloudflare Workers (free)

Decided after a full serverless comparison. Workers wins on: permanent free tier, ~0ms cold start, a Buenos Aires edge PoP, no hard wall-clock limit on HTTP requests, free AI Gateway, and no credit card to start. At ~10 invocations/day this sits at ~0.0003% of the free tier — it will never cost anything.

- **Free tier:** 100,000 requests/day, 10ms CPU per invocation, 50 external subrequests per invocation, 128MB RAM.
- **Paid ($5/mo)**, only if ever needed: raises subrequests to 10,000 default and CPU time to 5 minutes. Not needed for this project.
- **Runtime:** V8 isolates. Write in TypeScript/JS. Use [Hono](https://hono.dev) as the web framework.
- **Deploy:** `wrangler deploy`. Webhook = your `*.workers.dev` URL.

## Architecture

```
Telegram voice note
  → Telegram webhook POST to Worker
  → Worker: getFile + download audio from Telegram
  → OpenAI transcription (Spanish)
  → OpenAI chat → structured JSON matching sheet columns
  → append row to Google Sheet
  → reply "✅ guardado" to Telegram
```

~6–7 outbound calls per invocation, well under the 50-subrequest cap. The 10ms CPU limit is fine: waiting on OpenAI / Telegram / Sheets is I/O, which doesn't count against CPU time. Only JSON parsing and JWT signing burn CPU here.

## Sheet columns (from existing DB)

`Fecha ; Comida ; Modo ; Calificacion ; Score ; Notas`

- **Fecha:** date, format like `dom 08/02/26`
- **Comida:** Desayuno | Almuerzo | Merienda | Cena
- **Modo:** Casa | Delivery | Afuera
- **Calificacion:** OK | Mid | Bad
- **Score:** 1–5 (keep consistent with Calificacion: OK=4–5, Mid=2–3, Bad=1)
- **Notas:** free text

## Extractor prompt (starting point)

```
You extract meal log entries from a voice note transcript in Argentine Spanish.
Return strict JSON: fecha (today, DD/MM/YY), comida (Desayuno|Almuerzo|Merienda|Cena),
modo (Casa|Delivery|Afuera), calificacion (OK|Mid|Bad), score (1-5), notas (free text).
Infer reasonably from context if a field isn't stated. Keep score and calificacion consistent
(OK=4-5, Mid=2-3, Bad=1). Output only the JSON object, no preamble or markdown.
```

Use OpenAI structured outputs / JSON mode so responses never need messy parsing.

## Google Sheets — two paths

1. **Apps Script web app (start here).** Bind a script to the sheet exposing `doPost(e)`; Worker just `fetch`es your script URL. No JWTs, no Google Cloud setup. Fastest to working.
2. **Service account + Sheets API (the "proper" way).** Google's Node SDK doesn't run on Workers, so sign the JWT manually with the Web Crypto API (`crypto.subtle`). ~30 lines; well-documented recipes exist. Do this if you outgrow #1.

## OpenAI cost

Two calls per voice note:
- Transcription: `gpt-4o-mini-transcribe` @ **$0.003/min** (~$0.001 for a 20s note)
- Extraction: `gpt-4o-mini` (~$0.0001/call)

≈ **$0.001–0.002 per meal logged**, so ~**$0.20/month** at 120 meals. The OpenAI API is separate from a ChatGPT Plus subscription — they don't share credits.

Optional: route OpenAI calls through **Cloudflare AI Gateway** (free) for caching, retries, and per-call analytics at zero markup. Or replace transcription entirely with **Workers AI's native `whisper-large-v3-turbo`** (10,000 free Neurons/day) to drop one external dependency.

## Argentina notes

- Workers needs no card to start; the OpenAI API does (international USD card, same as ChatGPT Plus).
- Foreign-card markup is now ~30% (post Impuesto PAIS), refundable via ARCA, or skippable by paying the card statement in USD from a MEP-funded dollar account.
- Latency: deploy concerns are moot — Workers auto-routes the webhook to its nearest edge, and OpenAI round-trips dominate wall time regardless.

## Status check (June 2026) — watch items

- **Cloudflare Workers:** unchanged. Free still $0, paid still $5/mo. ✅
- **OpenAI transcription:** unchanged ($0.003/min mini, $0.006/min standard). ✅
- Two alternatives that *used* to be backups got worse, so Workers is now an even stronger relative pick:
  - **Val.town** free tier is now public-vals-only for new accounts (code would be visible).
  - **Koyeb** closed its free tier to new users (Mistral acquisition).

## Build order

1. Create the bot via @BotFather, get the token.
2. Scaffold a Worker (`npm create cloudflare`), add Hono, store secrets via `wrangler secret put`.
3. Handle the webhook: parse update → download voice → transcribe → extract → append → reply.
4. Wire the Google Sheet (Apps Script web app first).
5. Set the webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<worker-url>` (add a secret token for security).
6. Send a test voice note, confirm the row lands.
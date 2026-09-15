// Client for the Apps Script web app. See apps-script/README.md for the contract.
// Ops: readDay/readDiario/readSemanal/readMensual (GET), append/overwrite (POST).
// Every request carries the shared secret token; the script rejects anything without it.
// Writes are sandboxed server-side to a recent window (last 7 days, no future).

import type { MealEntry } from "./openai";

export interface SheetClient {
  url: string;
  secret: string;
}

export interface SheetEntry {
  row: number;
  comida: string;
  modo: string;
  calificacion: string;
  score: number;
  notas: string;
}

type Fields = Pick<MealEntry, "comida" | "modo" | "calificacion" | "notas">;

function fields(entry: MealEntry): Fields {
  return { comida: entry.comida, modo: entry.modo, calificacion: entry.calificacion, notas: entry.notas };
}

class SheetsResponseError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "SheetsResponseError";
  }
}

// Diagnostic text only: never expose URLs, tokens, scripts, or full response bodies.
function responsePreview(text: string, c: SheetClient): string {
  text = text.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
      const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n <= 0x10ffff ? String.fromCodePoint(n) : entity;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name.toLowerCase()]!);
  for (const value of [c.secret, encodeURIComponent(c.secret), new URLSearchParams({ t: c.secret }).toString().slice(2), c.url]) {
    if (value) text = text.split(value).join("[redacted]");
  }
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\b(token|secret|user_content_key)\s*[=:]\s*[^\s&<>]+/gi, "$1=[redacted]")
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
}

// Bound memory use even if an upstream proxy returns an unexpectedly large page.
async function responseText(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new SheetsResponseError("response exceeds 1 MiB", false);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

type WriteBody = { action: string; row?: number } & Record<string, unknown>;

async function request<T>(c: SheetClient, params: Record<string, string>, body?: WriteBody): Promise<T> {
  const method = body ? "POST" : "GET";
  const url = new URL(c.url);
  if (!body) {
    url.searchParams.set("token", c.secret);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  const operation = body?.action ?? params.view ?? "readDay";
  const attempts = body ? 1 : 3; // POST may have committed even if its response failed.
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let r: Response | undefined;
    let preview: string | undefined;
    try {
      r = await fetch(url.toString(), {
        method, redirect: "follow", signal: AbortSignal.timeout(10_000),
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify({ token: c.secret, ...body }) : undefined,
      });
      const text = await responseText(r);
      let json: unknown;
      try { json = JSON.parse(text); } catch { preview = responsePreview(text, c); }
      const valid = json !== null && typeof json === "object" && "ok" in json && typeof json.ok === "boolean";
      if (!r.ok || !valid) {
        const transient = r.status === 408 || r.status === 429 || r.status >= 500 || (r.ok && !valid);
        throw new SheetsResponseError(`HTTP ${r.status}; ${valid ? "upstream error" : "expected JSON with ok:boolean"}`, transient);
      }
      if (attempt > 1) console.info({ event: "sheets_recovered", operation, ...params, attempt, status: r.status });
      return json as T;
    } catch (cause) {
      // Fetch errors can contain the request URL (including the token). Never log them raw.
      const error = cause instanceof SheetsResponseError ? cause : new SheetsResponseError(
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
          ? "request timed out" : "network or response stream error", true,
      );
      const retryAfter = r?.headers.get("retry-after");
      const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      const delayMs = Math.max(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
      const retry = error.retryable && attempt < attempts && delayMs <= 10_000;
      const detail = {
        event: "sheets_request_failed", method, operation, ...params, row: body?.row, attempt,
        status: r?.status, contentType: r?.headers.get("content-type"),
        finalHost: r?.url ? new URL(r.url).hostname : undefined, redirected: r?.redirected,
        durationMs: Date.now() - started, error: error.message, preview, retry, delayMs: retry ? delayMs : undefined,
      };
      if (retry) console.warn(detail); else console.error(detail);
      if (!retry) throw new SheetsResponseError(
        `Apps Script ${operation} failed after ${attempt} attempt(s): ${error.message}${preview ? `; ${preview}` : ""}`, false,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function post(c: SheetClient, body: WriteBody): Promise<{ ok: boolean; row?: number; error?: string }> {
  return request(c, {}, body);
}

function get<T>(c: SheetClient, params: Record<string, string>): Promise<T> {
  return request<T>(c, params);
}

// Read all entries for a given day (default today, server-side BA time).
export async function readDay(c: SheetClient, fecha?: string): Promise<SheetEntry[]> {
  const j = await get<{ ok: boolean; entries?: SheetEntry[]; error?: string }>(
    c,
    fecha ? { fecha } : {},
  );
  if (!j.ok) throw new Error(`sheets read failed: ${j.error}`);
  return j.entries ?? [];
}

// Add a new row dated entry.fecha (YYYY-MM-DD). Returns the new row number.
// The backend rejects dates outside the allowed window (last 7 days, no future).
export async function append(c: SheetClient, entry: MealEntry): Promise<number> {
  const j = await post(c, { action: "append", fecha: entry.fecha, ...fields(entry) });
  if (!j.ok) throw new Error(`sheets append failed: ${j.error}`);
  return j.row ?? 0;
}

// Overwrite an existing row (only succeeds if that row is within the allowed window).
export async function overwrite(c: SheetClient, row: number, entry: MealEntry): Promise<number> {
  const j = await post(c, { action: "overwrite", row, ...fields(entry) });
  if (!j.ok) throw new Error(`sheets overwrite failed: ${j.error}`);
  return j.row ?? 0;
}

// --- Summary views (read-only) ---

export interface DiarioRow {
  fecha: string;
  evento: string;
  desayuno: string; // "Casa - OK" etc.
  almuerzo: string;
  merienda: string;
  cena: string;
  score: number; // daily average
  notas: { desayuno: string; almuerzo: string; merienda: string; cena: string };
}

export interface PeriodoRow {
  inicio: string; // week-start or month-start date
  label: string; // "2026-06 W2" or "2026-06"
  promedio: number; // average score for the period
  eventos: string;
}

async function getView<T>(c: SheetClient, view: string, last?: number): Promise<T[]> {
  const params: Record<string, string> = { view };
  if (last) params.last = String(last);
  const j = await get<{ ok: boolean; rows?: T[]; error?: string }>(c, params);
  if (!j.ok) throw new Error(`sheets view '${view}' failed: ${j.error}`);
  return j.rows ?? [];
}

// "View diario" — one row per day. `last` caps to the most recent N days.
export function readDiario(c: SheetClient, last?: number): Promise<DiarioRow[]> {
  return getView<DiarioRow>(c, "diario", last);
}

// Weekly summary table from "View semanalmensual".
export function readSemanal(c: SheetClient, last?: number): Promise<PeriodoRow[]> {
  return getView<PeriodoRow>(c, "semanal", last);
}

// Monthly summary table from "View semanalmensual".
export function readMensual(c: SheetClient, last?: number): Promise<PeriodoRow[]> {
  return getView<PeriodoRow>(c, "mensual", last);
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { append, overwrite, readDay, readDiario } from "../src/sheets";
import type { MealEntry } from "../src/openai";

const client = { url: "https://script.google.com/macros/s/example/exec", secret: "private & token" };
const meal: MealEntry = {
  fecha: "2026-09-15", comida: "Almuerzo", modo: "Casa", calificacion: "OK",
  notas: "private meal", accion: "agregar", aclaraciones: [],
};
const html = (status = 500, headers = {}) => new Response(
  '<!DOCTYPE html><html><head><title>Server error</title><style>hidden style</style></head>' +
  '<body><script>hidden script</script>Try again &amp; retry</body></html>',
  { status, headers: { "content-type": "text/html", ...headers } },
);
const ok = () => Response.json({ ok: true, entries: [], rows: [], row: 12 });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Attach the rejection handler before advancing timers to detect unhandled rejections.
async function failure(promise: Promise<unknown>) {
  const result = promise.catch((error: Error) => error);
  await vi.runAllTimersAsync();
  return result;
}

describe("Apps Script reads", () => {
  it("recovers from HTML 500 with a diagnostic and backoff", async () => {
    fetchMock.mockResolvedValueOnce(html()).mockResolvedValueOnce(ok());
    const pending = readDay(client, meal.fecha);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "sheets_request_failed", status: 500, attempt: 1, fecha: meal.fecha,
      preview: "Server error Try again & retry", retry: true, delayMs: expect.any(Number),
    }));
    expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ event: "sheets_recovered", attempt: 2 }));
  });

  it.each([200, 408, 429, 502, 503, 504])("retries transient HTTP %s for views too", async (status) => {
    fetchMock.mockResolvedValueOnce(html(status)).mockResolvedValueOnce(ok());
    const pending = readDiario(client, 1);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three failed attempts and includes the readable upstream message", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html()));
    const error = await failure(readDay(client));
    expect(error).toMatchObject({ message: expect.stringContaining("after 3 attempt(s): HTTP 500") });
    expect(error).toMatchObject({ message: expect.stringContaining("Server error Try again & retry") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3, retry: false }));
  });

  it.each([401, 403, 404])("does not retry HTTP %s", async (status) => {
    fetchMock.mockResolvedValueOnce(html(status));
    await failure(readDay(client));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a JSON application rejection", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: "unauthorized" }));
    await expect(readDay(client)).rejects.toThrow("sheets read failed: unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "text", {}])("rejects invalid JSON envelopes: %j", async (value) => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(value)));
    expect(await failure(readDay(client))).toMatchObject({ message: expect.stringContaining("expected JSON with ok:boolean") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([new TypeError("fetch failed with a secret URL"), new DOMException("timeout", "TimeoutError")])(
    "retries transport errors with a timeout signal", async (error) => {
      fetchMock.mockRejectedValueOnce(error).mockResolvedValueOnce(ok());
      const pending = readDay(client);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual([]);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(error.message);
    },
  );

  it("honors Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(html(429, { "retry-after": "2" })).mockResolvedValueOnce(ok());
    const pending = readDay(client);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry early when Retry-After exceeds the wait budget", async () => {
    fetchMock.mockResolvedValueOnce(html(429, { "retry-after": "60" }));
    await failure(readDay(client));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts secrets and URLs before truncating diagnostics", async () => {
    fetchMock.mockResolvedValueOnce(new Response(`<title>Error</title><p>private &amp; token ${encodeURIComponent(client.secret)} ` +
      `${new URLSearchParams({ t: client.secret })} ${client.url}?token=abc user_content_key=abc ${"x".repeat(1000)}</p>`, { status: 403 }));
    const error = await failure(readDay(client));
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls) + String(error);
    expect(logs).not.toContain(client.secret);
    expect(logs).not.toContain(encodeURIComponent(client.secret));
    expect(logs).not.toContain("private");
    expect(logs).not.toContain(client.url);
    expect(logs).not.toContain("abc");
    expect(vi.mocked(console.error).mock.calls[0][0].preview.length).toBeLessThanOrEqual(600);
  });

  it("bounds upstream response size", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    expect(await failure(readDay(client))).toMatchObject({ message: expect.stringContaining("response exceeds 1 MiB") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Apps Script writes", () => {
  it.each(["append", "overwrite"])("never retries %s after HTML 500", async (action) => {
    fetchMock.mockResolvedValueOnce(html());
    await failure(action === "append" ? append(client, meal) : overwrite(client, 12, meal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(meal.notas);
  });

  it("preserves the authenticated POST payload", async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await expect(append(client, meal)).resolves.toBe(12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(client.url);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ token: client.secret, action: "append", fecha: meal.fecha, notas: meal.notas });
  });
});

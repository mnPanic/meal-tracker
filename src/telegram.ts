// Thin Telegram Bot API helpers.

const API = "https://api.telegram.org";

export interface TgUpdate {
  message?: {
    chat: { id: number };
    voice?: { file_id: string; duration: number };
    audio?: { file_id: string };
    text?: string;
  };
}

export async function getFilePath(token: string, fileId: string): Promise<string> {
  const r = await fetch(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = (await r.json()) as { ok: boolean; result?: { file_path: string } };
  if (!j.ok || !j.result) throw new Error("getFile failed");
  return j.result.file_path;
}

export async function downloadFile(token: string, filePath: string): Promise<ArrayBuffer> {
  const r = await fetch(`${API}/file/bot${token}/${filePath}`);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  return r.arrayBuffer();
}

export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

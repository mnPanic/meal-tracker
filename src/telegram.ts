// Thin Telegram Bot API adapter.

import type { Chat } from "./ports";

const API = "https://api.telegram.org";

async function call<T>(token: string, method: string, body: object): Promise<T> {
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description ?? r.status}`);
  return j.result as T;
}

async function downloadFile(token: string, fileId: string): Promise<ArrayBuffer> {
  const { file_path } = await call<{ file_path: string }>(token, "getFile", { file_id: fileId });
  const r = await fetch(`${API}/file/bot${token}/${file_path}`);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  return r.arrayBuffer();
}

export function telegramChat(token: string): Chat {
  return {
    async send(chatId, html, opts = {}) {
      const msg = await call<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: opts.keyboard,
        reply_to_message_id: opts.replyTo,
      });
      return msg.message_id;
    },
    // Remove a message's inline buttons without touching its text (avoids double-tap on a
    // resolved proposal, while keeping the message for traceability).
    async dropButtons(chatId, messageId) {
      try {
        await call(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // Ignore "message is not modified" / already buttonless.
      }
    },
    async answerCallback(callbackId) {
      await call(token, "answerCallbackQuery", { callback_query_id: callbackId });
    },
    downloadFile: (fileId) => downloadFile(token, fileId),
  };
}

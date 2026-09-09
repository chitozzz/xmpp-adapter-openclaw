/**
 * ingress.ts — входящие XMPP-сообщения → agent turns (OpenClaw).
 *
 * Использует dispatchInboundDirectDmWithRuntime из plugin-sdk/channel-inbound:
 * шлюз сам занимается сессиями, allowlist-гейтом, pairing и доставкой ответа.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { getSharedClient, resolveAccount } from "./channel.js";
import type { XmppIncomingMessage } from "./xmpp-client.js";

let wired = false;

/**
 * Привязать обработчик входящих сообщений к shared XMPP-клиенту.
 * Вызывается после старта runtime (когда известен PluginRuntime и cfg).
 */
export async function wireIngress(
  runtime?: PluginRuntime,
  cfg?: any,
): Promise<void> {
  if (wired) return;
  const client = getSharedClient();
  wired = true;

  client.on("message", (msg: XmppIncomingMessage) => {
    void handleIncoming(msg, runtime, cfg);
  });
}

async function handleIncoming(
  msg: XmppIncomingMessage,
  runtime?: PluginRuntime,
  cfg?: any,
): Promise<void> {
  if (!runtime || !cfg) {
    console.warn("[xmpp] drop: runtime/config not available yet");
    return;
  }

  const isMuc = msg.chatType === "groupchat";
  const account = resolveAccount(cfg);

  // MUC: отвечаем только при упоминании ника бота
  if (isMuc) {
    const nick = account.mucNick ?? account.jid.split("@")[0];
    const mentioned = new RegExp(`@?${escapeRe(nick)}\\b`, "i").test(msg.text);
    if (!mentioned) return;
    // Убираем упоминание из текста для агента
    msg = { ...msg, text: msg.text.replace(new RegExp(`@?${escapeRe(nick)}[:,]?\\s*`, "i"), "") };
  }

  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg,
      channel: "xmpp",
      channelLabel: "XMPP",
      accountId: "default",
      peer: { id: msg.from } as any,
      senderId: msg.from,
      senderAddress: msg.from,
      recipientAddress: account.jid,
      conversationLabel: isMuc ? `${msg.from} (MUC)` : msg.from,
      rawBody: msg.text,
      messageId: msg.stanzaId ?? `${Date.now()}`,
      provider: "xmpp",
      deliver: async (payload: any) => {
        const text = String(payload?.text ?? "");
        if (!text) return;
        const c = getSharedClient();
        if (isMuc) {
          await c.sendGroupchat(msg.from, text);
        } else {
          await c.sendChat(msg.from, text, msg.thread);
        }
      },
      onRecordError: (err: unknown) => console.error("[xmpp] record error:", err),
      onDispatchError: (err: unknown, info: { kind?: string }) =>
        console.error("[xmpp] dispatch error:", info?.kind, err),
      runtime,
    } as any);
  } catch (err) {
    console.error("[xmpp] ingress failed:", err);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

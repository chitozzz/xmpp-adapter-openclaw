/**
 * channel.ts — ChannelPlugin для XMPP (OpenClaw).
 *
 * API: createChatChannelPlugin (openclaw/plugin-sdk/channel-core)
 * Docs: https://docs.openclaw.ai/plugins/sdk-channel-plugins
 */

import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { XmppClient } from "./xmpp-client.js";
import { stripMarkdown } from "./markdown.js";
import { randomUUID } from "node:crypto";

const CHANNEL_ID = "xmpp";

export type ResolvedAccount = {
  accountId: string | null;
  jid: string;
  password: string;
  host?: string;
  port?: number;
  tls?: boolean;
  mucNick?: string;
  homeChannel?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.[CHANNEL_ID];
  const jid = section?.jid;
  if (!jid) throw new Error("xmpp: jid is required");
  const password = section?.password ?? process.env.XMPP_PASSWORD;
  if (!password) {
    throw new Error(
      "xmpp: password is required (channels.xmpp.password or XMPP_PASSWORD env)",
    );
  }
  return {
    accountId: accountId ?? null,
    jid,
    password,
    host: section?.host,
    port: section?.port,
    tls: section?.tls,
    mucNick: section?.mucNick,
    homeChannel: section?.homeChannel,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmSecurity,
  };
}

export const xmppPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: CHANNEL_ID,

    // Основные возможности канала
    capabilities: {
      chatTypes: ["direct", "group"],
      media: false,
    },

    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount(cfg: any) {
        const section = (cfg.channels as Record<string, any>)?.[CHANNEL_ID];
        const configured = Boolean(section?.jid);
        return {
          enabled: configured,
          configured,
          credentialStatus: section?.password ? "available" : "missing",
        } as any;
      },
    } as any,

    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...(cfg.channels as any)?.[CHANNEL_ID],
            ...input,
          },
        },
      }),
    },
  }) as any,

  // DM security: кто может писать боту (allowlist по bare JID)
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // Pairing: подтверждение новых DM-контактов кодом
  pairing: {
    text: {
      idLabel: "XMPP JID",
      message: "Send this code to verify your identity:",
      notify: async ({ id, meta, cfg }) => {
        // id — JID контакта (см. ChannelPairingAdapter.notifyApproval)
        const target = id;
        const code = meta?.code ?? "";
        const client = getSharedClient();
        await client.sendChat(target, `Pairing code: ${code}`);
        void cfg;
      },
    },
  },

  // Threading: XMPP thread ids (XEP-0201) для ответов
  threading: {
    topLevelReplyToMode: "reply",
  },

  // Outbound: отправка сообщений в XMPP
  outbound: {
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => {
        const client = getSharedClient();
        const to = ctx.to;
        const text = stripMarkdown(ctx.text);
        const sendFn = XmppClient.isMuc(to)
          ? (t: string) => client.sendGroupchat(to, t)
          : (t: string) => client.sendChat(to, t, undefined);
        // Чанкинг делает core через chunker (ниже) — тут уже кусок.
        await sendFn(text);
        return {
          messageId: randomUUID(),
          target: { kind: "conversation", id: to },
        };
      },
    },
    base: {
      // Чанкинг: limit задаёт core; режим — простой текст
      chunker: (text: string, limit: number) => {
        return chunkByLimit(text, limit);
      },
      chunkerMode: "text" as const,
      textChunkLimit: 4000,
      deliveryMode: "direct" as const,
    },
  },
});

/** Разбивка текста на куски ≤ limit по границам строк/слов. */
function chunkByLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ── Shared client runtime ─────────────────────────────────────

let sharedClient: XmppClient | null = null;

export function getSharedClient(): XmppClient {
  if (!sharedClient) throw new Error("xmpp: client not started");
  return sharedClient;
}

/** Запуск XMPP-клиента (вызывается из entry point при старте канала). */
export async function startXmppRuntime(cfg: OpenClawConfig): Promise<void> {
  const account = resolveAccount(cfg);
  if (sharedClient) await sharedClient.stop();
  sharedClient = new XmppClient({
    jid: account.jid,
    password: account.password,
    host: account.host,
    port: account.port,
    tls: account.tls,
    mucNick: account.mucNick,
    homeChannel: account.homeChannel,
  });
  await sharedClient.start();
}

export async function stopXmppRuntime(): Promise<void> {
  if (sharedClient) {
    await sharedClient.stop();
    sharedClient = null;
  }
}

/**
 * channel.ts — ChannelPlugin для XMPP (OpenClaw).
 *
 * API: createChatChannelPlugin (openclaw/plugin-sdk/channel-core)
 * Контракт запуска: base.gateway.startAccount(ctx) — вызывается gateway
 * для каждого включённого аккаунта канала (см. ANALYSIS.md §2.4).
 */

import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  channelIngressRoutes,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-auth";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  uploadService?: string;
  allowInsecureTls?: boolean;
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
    uploadService: section?.uploadService,
    allowInsecureTls: section?.allowInsecureTls,
  };
}

// ── Shared client runtime ─────────────────────────────────────

let sharedClient: XmppClient | null = null;

export function getSharedClient(): XmppClient {
  if (!sharedClient) throw new Error("xmpp: client not started");
  return sharedClient;
}

export async function stopXmppRuntime(): Promise<void> {
  if (sharedClient) {
    await sharedClient.stop();
    sharedClient = null;
  }
}

/** Старт аккаунта: подключение + ingress + statusSink для health-monitor. */
async function startXmppGatewayAccount(ctx: any): Promise<void> {
  const account: ResolvedAccount = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });

  if (!account.jid) {
    throw new Error(`xmpp is not configured for account "${ctx.accountId}"`);
  }
  ctx.log?.info?.(
    `[${ctx.accountId}] starting XMPP provider (${account.jid}${account.host ? ` @ ${account.host}:${account.port ?? 5222}` : ""})`,
  );

  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () => {
      const client = new XmppClient({
        jid: account.jid,
        password: account.password,
        host: account.host,
        port: account.port,
        tls: account.tls,
        mucNick: account.mucNick,
        homeChannel: account.homeChannel,
        uploadService: account.uploadService,
        allowInsecureTls: account.allowInsecureTls,
      });

      // Ingress: входящие → dispatch в agent runtime
      client.onMessage( (msg: any) => {
        void dispatchIncoming(msg, ctx, statusSink);
      });

      await client.start();
      sharedClient = client;
      client.onMessage((msg: any) => {
        void dispatchIncoming(msg, ctx, statusSink);
      });

      // Готовность: statusSink + presence
      statusSink(channelReadyPatch());
      if (account.homeChannel) {
        await client.joinMuc(account.homeChannel).catch(() => {});
      }
      return { stop: async () => { await client.stop(); sharedClient = null; } };
    },
    stop: async (monitor: any) => {
      await monitor?.stop?.();
    },
  });
}

const xmppIngressIdentity = defineStableChannelIngressIdentity({
  key: "jid",
  normalize: (v) => normalizeLowercaseStringOrEmpty(String(v).split("/")[0]),
  isWildcardEntry: () => false,
});

/** Входящее сообщение → agent turn (через dispatchInboundDirectDm). */
  async function dispatchIncoming(
    msg: any,
    ctx: any,
    statusSink: any,
  ): Promise<void> {
    try {
      statusSink?.({ lastInboundAt: Date.now() });
      const account: ResolvedAccount = ctx.account;
      const isMuc = msg.chatType === "groupchat";

      const fromBare = String(msg.from).split("/")[0];
      const senderBare = fromBare.toLowerCase();

      // Пароль доверия: Pairing (DM). Если DM в allowlist/pairing, но не в списке — выдать код.
      if (!isMuc) {
        const policy = account.dmPolicy ?? "allowlist";
        if (policy === "disabled") {
          return;
        }
        const allowed = (account.allowFrom ?? []).map((s) => String(s).toLowerCase());
        if (policy === "allowlist" || policy === "pairing") {
          if (!allowed.includes(senderBare)) {
            if (policy === "pairing") {
              const code = Math.random().toString(36).slice(2, 8).toUpperCase();
              try {
                await getSharedClient().sendChat(
                  msg.from,
                  `Pairing code: ${code}\n` + `Send this code back to me to confirm your identity.`,
                );
                ctx.log?.info?.(`[xmpp] pairing code ${code} sent to ${msg.from}`);
              } catch (err) {
                ctx.log?.warn?.(`[xmpp] pairing send failed:`, err);
              }
            } else {
              ctx.log?.info?.(
                `[xmpp] blocked DM from ${msg.from} (not in allowFrom)`,
              );
            }
            return;
          }
        }
      }

      const { dispatchInboundDirectDm } = await import(
        "openclaw/plugin-sdk/channel-inbound"
      );

      // MUC: отвечаем только при упоминании ника бота
      let text = msg.text;
      const rawTextForCommand = msg.text;
      if (isMuc) {
        const nick = account.mucNick ?? account.jid.split("@")[0];
        const mentioned = new RegExp(`@?${escapeRe(nick)}\\b`, "i").test(text);
        if (!mentioned) return;
        text = text.replace(new RegExp(`@?${escapeRe(nick)}[:,]?\\s*`, "i"), "");
      }

      const config = ctx.cfg as OpenClawConfig;
      const channelId = CHANNEL_ID;
      const accountId = String(ctx.accountId ?? "default");

      const allowFrom = (account.allowFrom ?? []).map((s) => String(s));
      const groupAllowFrom = [] as string[];

      const resolver = createChannelIngressResolver({
        channelId,
        accountId,
        identity: xmppIngressIdentity,
        cfg: config,
        defaultDmPolicy: (account.dmPolicy ?? "allowlist") as any,
        useDefaultPairingStore: true,
      });

      const hasControlCommand = isControlCommandMessage(text, config);
      const allowTextCommands = true;

      const routeGroupAllowFrom = [] as string[];
      const routeDescriptors = isMuc
        ? channelIngressRoutes({
            id: "xmpp:room",
            configured: true,
            matched: true,
            allowed: true,
            precedence: 0,
            matchId: "xmpp-room",
          })
        : [];

      const ingress = await resolver.message({
        subject: { stableId: senderBare },
        conversation: {
          kind: isMuc ? "group" : "direct",
          id: isMuc ? fromBare : senderBare,
        },
        event: { kind: "message", authMode: "inbound", mayPair: !isMuc },
        dmPolicy: (account.dmPolicy ?? "allowlist") as any,
        groupPolicy: "allowlist" as any,
        policy: {
          groupAllowFromFallbackToAllowFrom: false,
          activation: {
            requireMention: isMuc,
            allowTextCommands,
          },
        },
        allowFrom,
        groupAllowFrom,
        route: routeDescriptors,
        mentionFacts: isMuc
          ? {
              canDetectMention: true,
              wasMentioned: true,
              hasAnyMention: true,
            }
          : undefined,
        command: { allowTextCommands, hasControlCommand },
      });

      await dispatchInboundDirectDm({
        cfg: config,
        channel: channelId,
        channelLabel: "XMPP",
        accountId,
        peer: { kind: "direct", id: msg.from },
        senderId: msg.from,
        senderAddress: msg.from,
        recipientAddress: account.jid,
        conversationLabel: isMuc ? `${fromBare} (MUC)` : msg.from,
        rawBody: text,
        messageId: msg.stanzaId ?? `${Date.now()}-${randomUUID().slice(0, 8)}`,
        provider: "xmpp",
        commandAuthorized: ingress.commandAccess?.authorized,
        channelIngress: ingress as any,
        deliver: async (payload: any) => {
          const out = String(payload?.text ?? "");
          if (!out) return;
          const client = getSharedClient();
          if (isMuc) {
            await client.sendGroupchat(msg.from, stripMarkdown(out));
          } else {
            await client.sendChat(msg.from, stripMarkdown(out), msg.thread);
          }
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onRecordError: (err: unknown) =>
          ctx.log?.error?.("[xmpp] record error:", err),
        onDispatchError: (err: unknown, info: { kind?: string }) =>
          ctx.log?.error?.("[xmpp] dispatch error:", info?.kind, err),
      } as any);
    } catch (err) {
      console.error("[xmpp] ingress failed:", err);
    }
  }

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Plugin object ─────────────────────────────────────────────

export const xmppPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: CHANNEL_ID,

    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
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

    // ... (setup) ...
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
      notify: async ({ id, meta }: any) => {
        const target = id;
        const code = meta?.code ?? "";
        await getSharedClient().sendChat(target, `Pairing code: ${code}`);
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
      sendText: async (ctx: any) => {
        const client = getSharedClient();
        const to = ctx.to;
        const text = stripMarkdown(ctx.text);
        if (XmppClient.isMuc(to)) {
          await client.sendGroupchat(to, text);
        } else {
          await client.sendChat(to, text);
        }
        return {
          messageId: randomUUID(),
          target: { kind: "conversation", id: to },
        };
      },
      sendMedia: async (ctx: any) => {
        const client = getSharedClient();
        const to = ctx.to;
        const text = stripMarkdown(String(ctx.text ?? ""));
        const mediaUrl = String(ctx.mediaUrl ?? "");
        if (!mediaUrl) throw new Error("xmpp sendMedia: mediaUrl is required");
        const url = await client.sendMedia(to, text, mediaUrl, {
          thread: ctx.threadId != null ? String(ctx.threadId) : undefined,
          groupchat: XmppClient.isMuc(to),
        });
        return {
          messageId: randomUUID(),
          target: { kind: "conversation", id: to },
          url,
        };
      },
    },
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 4000,
    },
  },
});


// gateway-контракт: runtime вызывает startAccount(ctx) для аккаунтов канала.
// Поле отсутствует в типах CreateChannelPluginBaseOptions, но runtime его
// читает (см. IRC-плагин); добавляем пост-фактум.
(xmppPlugin as any).gateway = {
  startAccount: async (ctx: any) => {
    await startXmppGatewayAccount(ctx);
  },
};


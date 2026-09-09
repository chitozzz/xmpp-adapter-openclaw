/**
 * xmpp-client.ts — обёртка над @xmpp/client для OpenClaw-канала XMPP.
 *
 * Порт функционала Hermes xmpp-adapter (Python/slixmpp):
 *   - connect + auth (SASL, STARTTLS, SRV-lookup)
 *   - presence, MUC (XEP-0045), typing (XEP-0085), ping keepalive (XEP-0199)
 *   - sendChat / sendGroupchat
 */

import { client, xml } from "@xmpp/client";

export interface XmppConfig {
  jid: string;
  password: string;
  host?: string;
  port?: number;
  tls?: boolean;
  mucNick?: string;
  homeChannel?: string;
  allowFrom?: string[];
}

export interface XmppIncomingMessage {
  /** bare JID отправителя (user@server) или MUC room (room@conference.server) */
  from: string;
  /** resource (для DM) или nick в MUC (для groupchat) */
  fromResource: string;
  /** chat = 1:1, groupchat = MUC */
  chatType: "chat" | "groupchat";
  text: string;
  /** XMPP thread id (XEP-0201), если задан */
  thread?: string;
  /** исходная stanza id */
  stanzaId?: string;
}

type Stanza = any; // @xmpp/client xml element
export type XmppEvent = "message" | "online" | "offline" | "error";

export class XmppClient {
  private xmpp: any;
  private cfg: XmppConfig;
  private online = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private handlers: Record<string, any> = {};
  private pendingIq = new Map<string, (s: Stanza | null) => void>();

  constructor(cfg: XmppConfig) {
    this.cfg = cfg;
  }

  on(event: XmppEvent, cb: any): void {
    this.handlers[event] = cb;
  }

  // ── JID helpers ──────────────────────────────────────────────

  static bare(jid: string): string {
    return jid.split("/")[0];
  }

  static resource(jid: string): string {
    return jid.split("/")[1] ?? "";
  }

  /** MUC-адрес по эвристике поддомена (conference|muc|rooms|chat). */
  static isMuc(jid: string): boolean {
    return /@(conference|muc|rooms|chat)\./i.test(XmppClient.bare(jid));
  }

  mucNick(): string {
    return this.cfg.mucNick || this.cfg.jid.split("@")[0];
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    const [username, domain] = this.cfg.jid.split("@");
    // Если host задан — коннектимся напрямую; иначе SRV-lookup из домена.
    const service = this.cfg.host
      ? `xmpp://${this.cfg.host}:${this.cfg.port ?? 5222}`
      : "xmpp://" + domain; // resolve = SRV + fallback

    this.xmpp = client({
      service,
      resource: "openclaw",
      username,
      password: this.cfg.password,
      domain,
    });

    this.xmpp.on("online", async (address: any) => {
      this.online = true;
      console.log(`[xmpp] online as ${String(address)}`);
      this.sendPresence("chat", "OpenClaw XMPP channel").catch(() => {});
      this.startPing();
      this.handlers.online?.();
    });

    this.xmpp.on("offline", () => {
      this.online = false;
      this.stopPing();
      this.handlers.offline?.();
    });

    this.xmpp.on("error", (err: Error) => {
      this.handlers.error?.(err);
    });

    this.xmpp.on("stanza", (stanza: Stanza) => {
      if (stanza.is("message")) {
        this.emitMessage(stanza);
        return;
      }
      if (stanza.is("iq") && this.pendingIq.has(stanza.attrs.id)) {
        const resolve = this.pendingIq.get(stanza.attrs.id)!;
        this.pendingIq.delete(stanza.attrs.id);
        resolve(stanza);
      }
    });

    // @xmpp/reconnect встроен в @xmpp/client: обрывы обрабатываются им сам.
    await this.xmpp.start();
  }

  async stop(): Promise<void> {
    this.stopPing();
    if (this.xmpp) {
      await this.xmpp.stop();
    }
  }

  isOnline(): boolean {
    return this.online;
  }

  // ── Presence ─────────────────────────────────────────────────

  private async sendPresence(show?: string, status?: string): Promise<void> {
    if (!this.online) return;
    await this.xmpp.send(
      xml(
        "presence",
        show ? { show } : {},
        status ? xml("status", {}, status) : "",
      ),
    );
  }

  async setStatus(statusText: string): Promise<void> {
    await this.sendPresence("chat", statusText);
  }

  // ── Ping (XEP-0199) ──────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(
      () => this.ping().catch(() => {}),
      60_000,
    );
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  async ping(): Promise<void> {
    if (!this.online) return;
    await this.sendIq(
      xml("iq", { type: "get", id: `ping-${Date.now()}` },
        xml("ping", { xmlns: "urn:xmpp:ping" })),
      10_000,
    );
  }

  private sendIq(stanza: Stanza, timeoutMs: number): Promise<Stanza | null> {
    const id = stanza.attrs.id as string;
    const timeout = setTimeout(() => {
      if (this.pendingIq.has(id)) {
        const resolve = this.pendingIq.get(id)!;
        this.pendingIq.delete(id);
        resolve(null);
      }
    }, timeoutMs);
    const p = new Promise<Stanza | null>((resolve) => {
      this.pendingIq.set(id, (s) => {
        clearTimeout(timeout);
        resolve(s);
      });
    });
    this.xmpp.send(stanza).catch(() => {
      if (this.pendingIq.has(id)) {
        const resolve = this.pendingIq.get(id)!;
        this.pendingIq.delete(id);
        clearTimeout(timeout);
        resolve(null);
      }
    });
    return p;
  }

  // ── Inbound ──────────────────────────────────────────────────

  private emitMessage(stanza: Stanza): void {
    const from = String(stanza.attrs.from ?? "");
    if (!from) return;

    const type = String(stanza.attrs.type ?? "normal");
    if (type !== "chat" && type !== "groupchat") return;

    // Текст — из body; пустого body нет → это chatstate/рейсипт, пропускаем.
    let text = "";
    let thread: string | undefined;
    for (const child of stanza.children ?? []) {
      if (child?.name === "body" && child.children?.[0]?.value) {
        text = String(child.children[0].value);
      } else if (child?.name === "thread" && child.children?.[0]?.value) {
        thread = String(child.children[0].value);
      }
    }
    if (!text) return;

    const chatType = type === "groupchat" ? "groupchat" : "chat";
    const fromBare = XmppClient.bare(from);
    const fromResource =
      chatType === "groupchat"
        ? XmppClient.resource(from) // ник в MUC
        : XmppClient.resource(from);

    // Игнорируем собственные эхо.
    if (fromBare === XmppClient.bare(this.cfg.jid)) return;
    if (chatType === "groupchat" && fromResource === this.mucNick()) return;

    this.handlers.message?.({
      from: fromBare,
      fromResource,
      chatType,
      text,
      thread,
      stanzaId: stanza.attrs.id ? String(stanza.attrs.id) : undefined,
    });
  }

  // ── Outbound ─────────────────────────────────────────────────

  private async send(stanza: Stanza): Promise<void> {
    if (!this.online) throw new Error("XMPP client is offline");
    await this.xmpp.send(stanza);
  }

  /** Отправить 1:1 сообщение (type=chat, thread для reply-threading). */
  async sendChat(to: string, text: string, thread?: string): Promise<void> {
    await this.send(
      xml(
        "message",
        { type: "chat", to },
        xml("body", {}, text),
        thread ? xml("thread", {}, thread) : "",
        xml("active", { xmlns: "http://jabber.org/protocol/chatstates" }),
      ),
    );
  }

  /** Отправить сообщение в MUC. */
  async sendGroupchat(to: string, text: string): Promise<void> {
    await this.send(
      xml(
        "message",
        { type: "groupchat", to },
        xml("body", {}, text),
        xml("active", { xmlns: "http://jabber.org/protocol/chatstates" }),
      ),
    );
  }

  /** Зайти в MUC-комнату (XEP-0045, presence с muc x). */
  async joinMuc(roomJid: string, nick: string = this.mucNick()): Promise<void> {
    if (!this.online) return;
    await this.xmpp.send(
      xml(
        "presence",
        { to: `${roomJid}/${nick}` },
        xml("x", { xmlns: "http://jabber.org/protocol/muc" }),
      ),
    );
  }

  /** Покинуть MUC. */
  async leaveMuc(roomJid: string, nick: string = this.mucNick()): Promise<void> {
    if (!this.online) return;
    await this.xmpp.send(
      xml("presence", { to: `${roomJid}/${nick}`, type: "unavailable" }),
    );
  }

  /** Индикатор печати (XEP-0085): composing = печатает, active = finished. */
  async setTyping(to: string, typing: boolean): Promise<void> {
    if (!this.online) return;
    const state = typing ? "composing" : "active";
    await this.xmpp.send(
      xml(
        "message",
        { type: "chat", to },
        xml(state, { xmlns: "http://jabber.org/protocol/chatstates" }),
      ),
    );
  }
}

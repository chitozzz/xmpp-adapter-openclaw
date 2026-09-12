/**
 * xmpp-client.ts — обёртка над @xmpp/client для OpenClaw-канала XMPP.
 *
 * Порт функционала Hermes xmpp-adapter (Python/slixmpp):
 *   - connect + auth (SASL, STARTTLS, SRV-lookup)
 *   - presence, MUC (XEP-0045), typing (XEP-0085), ping keepalive (XEP-0199)
 *   - sendChat / sendGroupchat
 *   - HTTP File Upload (XEP-0363) + OOB (XEP-0066) → sendMedia
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import { client, xml } from "@xmpp/client";

const UPLOAD_NS = "urn:xmpp:http:upload:0";
const DISCO_ITEMS_NS = "http://jabber.org/protocol/disco#items";
const DISCO_INFO_NS = "http://jabber.org/protocol/disco#info";
const OOB_NS = "jabber:x:oob";
const CHATSTATES_NS = "http://jabber.org/protocol/chatstates";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

export function guessMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface XmppConfig {
  jid: string;
  password: string;
  host?: string;
  port?: number;
  tls?: boolean;
  mucNick?: string;
  homeChannel?: string;
  allowFrom?: string[];
  /** Явный JID XEP-0363 сервиса (иначе — disco#items по домену). */
  uploadService?: string;
  /** Разрешить self-signed TLS при загрузке на share-хост (внутренний Snikket). */
  allowInsecureTls?: boolean;
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

export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  headers: Record<string, string>;
}

export class XmppClient {
  private xmpp: any;
  private cfg: XmppConfig;
  private online = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private uploadServiceCache: string | null = null;
  private static handlers: Record<string, any> = {};
  private pendingIq = new Map<string, (s: Stanza | null) => void>();

  constructor(cfg: XmppConfig) {
    this.cfg = cfg;
  }

  on(event: XmppEvent, cb: any): void {
    XmppClient.handlers[event] = cb;
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

  private domain(): string {
    return this.cfg.jid.split("@")[1] ?? "";
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
      XmppClient.handlers.online?.();
    });

    this.xmpp.on("offline", () => {
      this.online = false;
      this.stopPing();
      XmppClient.handlers.offline?.();
    });

    this.xmpp.on("error", (err: Error) => {
      XmppClient.handlers.error?.(err);
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

  onMessage(cb: (msg: any) => void) {
    XmppClient.handlers.message = cb;
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

    // Текст — используем правильный API ltx Element
    const text = stanza.getChildText("body") ?? "";
    const thread = stanza.getChildText("thread") ?? undefined;
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

    XmppClient.handlers.message?.({
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
        xml("active", { xmlns: CHATSTATES_NS }),
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
        xml("active", { xmlns: CHATSTATES_NS }),
      ),
    );
  }

  // ── XEP-0363: HTTP File Upload ───────────────────────────────

  /**
   * Найти upload-сервис. Порядок: явный cfg.uploadService → disco#items
   * по домену (+ disco#info на фичу) → эвристика share./upload.<domain>.
   */
  async findUploadService(): Promise<string | null> {
    if (this.cfg.uploadService) return this.cfg.uploadService;
    if (this.uploadServiceCache) return this.uploadServiceCache;

    const domain = this.domain();
    if (!domain) return null;

    const res = await this.sendIq(
      xml("iq", { type: "get", to: domain, id: `disco-items-${Date.now()}` },
        xml("query", { xmlns: DISCO_ITEMS_NS })),
      10_000,
    );

    const candidates: string[] = [];
    const query = res?.getChild?.("query", DISCO_ITEMS_NS);
    for (const item of query?.getChildren?.("item") ?? []) {
      const jid = item.attrs?.jid;
      if (jid) candidates.push(String(jid));
    }

    for (const jid of candidates.slice(0, 8)) {
      const info = await this.sendIq(
        xml("iq", { type: "get", to: jid, id: `disco-info-${Date.now()}` },
          xml("query", { xmlns: DISCO_INFO_NS })),
        8_000,
      );
      const feats = info?.getChild?.("query", DISCO_INFO_NS)?.getChildren?.("feature") ?? [];
      if (feats.some((f: any) => f.attrs?.var === UPLOAD_NS)) {
        this.uploadServiceCache = jid;
        return jid;
      }
    }

    // Эвристика: типовые поддомены Prosody/Snikket.
    for (const guess of [`share.${domain}`, `upload.${domain}`]) {
      const info = await this.sendIq(
        xml("iq", { type: "get", to: guess, id: `disco-info-${Date.now()}` },
          xml("query", { xmlns: DISCO_INFO_NS })),
        8_000,
      );
      const feats = info?.getChild?.("query", DISCO_INFO_NS)?.getChildren?.("feature") ?? [];
      if (feats.some((f: any) => f.attrs?.var === UPLOAD_NS)) {
        this.uploadServiceCache = guess;
        return guess;
      }
    }
    return null;
  }

  /** Запросить слот (XEP-0363 §4). */
  async requestUploadSlot(
    service: string,
    filename: string,
    size: number,
    contentType: string,
  ): Promise<UploadSlot> {
    const res = await this.sendIq(
      xml("iq", { type: "get", to: service, id: `slot-${Date.now()}` },
        xml("request", {
          xmlns: UPLOAD_NS,
          filename,
          size: String(size),
          "content-type": contentType,
        })),
      20_000,
    );

    if (!res) throw new Error("upload slot: no response from " + service);
    if (String(res.attrs?.type ?? "") === "error") {
      const cond = res.getChild?.("error")?.getChildren?.()[0]?.name ?? "unknown";
      throw new Error(`upload slot error: ${cond}`);
    }

    const slot = res.getChild?.("slot", UPLOAD_NS);
    const put = slot?.getChild?.("put");
    const get = slot?.getChild?.("get");
    const putUrl = put?.attrs?.url;
    const getUrl = get?.attrs?.url;
    if (!putUrl || !getUrl) throw new Error("upload slot: malformed response");

    const headers: Record<string, string> = {};
    for (const h of put.getChildren?.("header") ?? []) {
      if (h.attrs?.name) headers[String(h.attrs.name)] = h.getText?.() ?? "";
    }
    return { putUrl, getUrl, headers };
  }

  /** PUT байтов в слот. */
  private putFile(
    putUrl: string,
    headers: Record<string, string>,
    data: Buffer,
    contentType: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(putUrl);
      } catch {
        reject(new Error(`upload: bad slot URL ${putUrl}`));
        return;
      }
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          method: "PUT",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(data.length),
            ...headers,
          },
          // Строгая проверка TLS по умолчанию; self-signed Snikket требует
          // явного allowInsecureTls: true в конфиге канала.
          rejectUnauthorized: this.cfg.allowInsecureTls !== true,
        } as any,
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else {
              const body = Buffer.concat(chunks).toString("utf8").slice(0, 300);
              reject(new Error(`upload PUT ${code}: ${body}`));
            }
          });
        },
      );
      req.setTimeout(120_000, () => req.destroy(new Error("upload PUT timeout")));
      req.on("error", reject);
      req.end(data);
    });
  }

  /** Загрузить локальный файл, вернуть публичный GET-URL. */
  async uploadLocalFile(localPath: string): Promise<string> {
    const clean = localPath.startsWith("file://")
      ? new URL(localPath).pathname
      : localPath;

    let data: Buffer;
    try {
      data = await fs.promises.readFile(clean);
    } catch (err: any) {
      throw new Error(`upload: cannot read ${clean}: ${err?.message ?? err}`);
    }

    const service = await this.findUploadService();
    if (!service) throw new Error("upload: no XEP-0363 service found");

    const filename = path.basename(clean);
    const contentType = guessMime(clean);
    const slot = await this.requestUploadSlot(service, filename, data.length, contentType);
    await this.putFile(slot.putUrl, slot.headers, data, contentType);
    console.log(`[xmpp] uploaded ${filename} (${data.length} B) -> ${slot.getUrl}`);
    return slot.getUrl;
  }

  /**
   * Отправить вложение: локальный путь грузим через XEP-0363, готовый
   * http(s)-URL шлём как есть. Ссылка идёт в OOB (XEP-0066).
   */
  async sendMedia(
    to: string,
    text: string,
    mediaUrl: string,
    opts?: { thread?: string; groupchat?: boolean },
  ): Promise<string> {
    const url = /^https?:\/\//i.test(mediaUrl)
      ? mediaUrl
      : await this.uploadLocalFile(mediaUrl);

    const groupchat = opts?.groupchat ?? XmppClient.isMuc(to);
    const body = text && text.trim() ? text : url;

    await this.send(
      xml(
        "message",
        { type: groupchat ? "groupchat" : "chat", to },
        xml("body", {}, body),
        xml("x", { xmlns: OOB_NS }, xml("url", {}, url)),
        !groupchat && opts?.thread ? xml("thread", {}, opts.thread) : "",
        xml("active", { xmlns: CHATSTATES_NS }),
      ),
    );
    return url;
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
        xml(state, { xmlns: CHATSTATES_NS }),
      ),
    );
  }
}

/** Минимальные типы для @xmpp/client (пакет не поставляет .d.ts). */

declare module "@xmpp/client" {
  export interface XmppClientOptions {
    service?: string;
    domain?: string;
    username?: string;
    password?: string;
    resource?: string;
    [key: string]: unknown;
  }

  export interface EventEmitterLike {
    on(event: string, cb: (payload: any) => void): void;
    off(event: string, cb: (payload: any) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: any): Promise<void>;
  }

  export function client(options: XmppClientOptions): EventEmitterLike;

  export function xml(name: string, attrs?: Record<string, any>, ...children: any[]): any;
  export function xml(name: string, ...children: any[]): any;
}

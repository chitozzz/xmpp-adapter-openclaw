/**
 * index.ts — точка входа плагина XMPP для OpenClaw.
 *
 * Контракт: defineChannelPluginEntry (openclaw/plugin-sdk/channel-core)
 *   https://docs.openclaw.ai/plugins/sdk-channel-plugins
 *
 * Старт канала: gateway сам вызывает base.gateway.startAccount(ctx)
 * для включённых аккаунтов — см. channel.ts. Здесь только регистрации.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { xmppPlugin, stopXmppRuntime } from "./channel.js";

const entry = defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP/Jabber channel plugin for OpenClaw",
  plugin: xmppPlugin as any,
  registerCliMetadata(_api) {
    // CLI-команды не нужны; канал настраивается через openclaw.json
  },
  registerFull(api) {
    void api; // runtime hooks не нужны: канал стартует через startAccount
  },
});

export { stopXmppRuntime };
export default entry as any;

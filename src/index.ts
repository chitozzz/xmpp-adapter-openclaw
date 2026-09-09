/**
 * index.ts — точка входа плагина XMPP для OpenClaw.
 *
 * Контракт: defineChannelPluginEntry (openclaw/plugin-sdk/channel-core)
 *   https://docs.openclaw.ai/plugins/sdk-channel-plugins
 *
 * setRuntime вызывается шлюзом при активации канала: здесь стартуем
 * XMPP-клиент и привязываем ingress.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { xmppPlugin, startXmppRuntime, stopXmppRuntime } from "./channel.js";
import { wireIngress } from "./ingress.js";

let started = false;

const entry = defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP/Jabber channel plugin for OpenClaw",
  plugin: xmppPlugin,

  setRuntime(runtime) {
    // Отложенный старт: конфиг может дозагружаться, стартуем в registerFull.
    void runtime;
  },

  registerFull(api) {
    if (started) return;
    started = true;

    // Конфиг берём через runtime helpers api.runtime.config.current()
    void (async () => {
      try {
        const cfg = await (api as any).runtime?.config?.current?.();
        if (!cfg) {
          console.warn("[xmpp] config not available; channel not started");
          return;
        }
        const channels = (cfg.channels as Record<string, any>) ?? {};
        if (!channels.xmpp?.jid) {
          console.warn(
            "[xmpp] channels.xmpp.jid is not configured; channel not started",
          );
          return;
        }
        await startXmppRuntime(cfg);
        await wireIngress(
          (api as any).runtime?.pluginRuntime,
          cfg,
        );
        console.log("[xmpp] channel started");
      } catch (err) {
        console.error("[xmpp] failed to start channel:", err);
      }
    })();
  },
});

export { stopXmppRuntime };
export default entry as any;

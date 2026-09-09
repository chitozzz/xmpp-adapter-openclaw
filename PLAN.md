# План разработки xmpp-adapter-openclaw

Порт функционала [xmpp-adapter-Hermes](https://github.com/chitozzz/xmpp-adapter-Hermes)
(Python/slixmpp) на Node.js/TypeScript для OpenClaw.

Технический разбор — в [ANALYSIS.md](ANALYSIS.md).

## Этап 0 — Каркас (готово ✓ частично)

- [x] Репозиторий создан на GitHub
- [x] Скелет плагина сгенерирован `openclaw plugins dev` в
  `~/.openclaw/plugins/xmpp/` (структура dist + манифест)
- [x] Анализ IRC-плагина как референса
- [ ] Скопировать структуру проекта из скелета в этот репозиторий
- [ ] `package.json` (type: module, deps: @xmpp/client + @xmpp-plugins/*,
      devDeps: typescript, openclaw для типов)

## Этап 1 — Ядро XMPP-клиента (v0.1.0)

Цель: standalone-модуль, который коннектится к XMPP и умеет слать/принимать
сообщения, без OpenClaw.

- [ ] `src/xmpp-client.ts`: обёртка над `@xmpp/client`:
  - connect (jid, password, host?, port?, tls?)
  - события: `online`, `stanza`, `error`, `offline`
  - `sendChat(to, text)`, `sendGroupchat(to, text)`
  - `joinMUC(room, nick)`, `setPresence(status?)`
  - `setTyping(to, state)` (XEP-0085)
  - keepalive ping (XEP-0199)
- [ ] `src/markdown.ts`: `_strip_markdown`-аналог (markdown → plain text)
- [ ] Smoke-тест standalone: логин на тестовом XMPP-аккаунте,
  self-send, MUC join

**DoD**: `node test/smoke.js` коннектится, шлёт себе сообщение, заходит в
MUC, отключается без ошибок.

## Этап 2 — Интеграция с OpenClaw plugin API (v0.2.0)

- [ ] `index.js` — `defineBundledChannelEntry` (по образцу IRC)
- [ ] `src/channel.ts`:
  - `resolveXmppAccount(params)` — аккаунты из config
  - `listEnabledXmppAccounts(cfg)`
  - allowlist: `normalizeXmppAllowEntry`, `buildXmppAllowlistCandidates`
  - `xmppIngressIdentity` через `defineStableChannelIngressIdentity`
- [ ] `src/channel-plugin-api.ts`: `xmppPlugin` (capabilities: direct+group,
  messaging: targetPrefixes, normalizeTarget, inferTargetChatType,
  resolveOutboundSessionRoute)
- [ ] `openclaw.plugin.json`: полный манифест с JSON Schema конфига
  (jid, password, host, port, tls, allowFrom, mucNick, homeChannel)
- [ ] `src/secret-contract-api.ts`: `channelSecrets` для пароля

**DoD**: плагин ставится через `openclaw plugins install`,
`openclaw channels add xmpp` находит канал, конфиг валидируется.

## Этап 3 — Ingress (входящие) (v0.3.0)

- [ ] `src/inbound.ts`:
  - парсинг stanza → событие message/groupchat_message
  - фильтр собственных сообщений и старых (delay/carbons)
  - allowlist-гейт (bare JID)
  - MUC: игнор сообщений от себя; ответ только при упоминании ника
    (require-mention, как у IRC `resolveIrcGroupRequireMention`)
  - `createChannelIngressMonitor` + `resolveChannelInboundRouteEnvelope`
  - group policy / pairing через `createChannelPairingController`
- [ ] Typing-события → heartbeat

**DoD**: сообщение в ЛС → агент отвечает в XMPP. Лог gateway чистый.

## Этап 4 — Outbound (исходящие) (v0.4.0)

- [ ] `src/outbound.ts`:
  - `sendMessageXmpp(to, text, opts)` → MessageReceipt
  - `sendFormattedXmppText(ctx)` с чанкингом (4000 симв. по Hermes)
  - markdown-strip перед отправкой
  - reply-threading: XMPP threading (XEP-0201 thread id) или fallback
  - typing-индикатор во время «раздумья» агента (XEP-0085 composing)
- [ ] Cron/уведомления: home channel (MUC) — отправка standalone-sender'ом

**DoD**: длинные ответы агента приходят частями, форматирование чистое,
typing горит пока агент думает.

## Этап 5 — Стабилизация и релиз (v1.0.0)

- [ ] Reconnect-логика (exponential backoff, как slixmpp в Hermes)
- [ ] Unit-тесты (ingress-парсер, allowlist, чанкер)
- [ ] README: установка, конфигурация, troubleshooting
- [ ] `openclaw plugins doctor` проходит
- [ ] Тег v1.0.0 + GitHub Release с исходниками

**DoD**: агент стабильно сидит в XMPP неделями, reconnect после обрыва
линка, UAT на live-сервере.

## Контрольные точки

| Версия | Что проверяем |
|--------|---------------|
| v0.1.0 | standalone XMPP-клиент работает |
| v0.2.0 | плагин ставится и валиден для OpenClaw |
| v0.3.0 | входящие доходят до агента |
| v0.4.0 | агент отвечает, typing, чанкинг |
| v1.0.0 | стабильность, релиз |

## Ссылки

- Референс-плагин: `@openclaw/irc` (официальный)
- Прототип на Python: chitozzz/xmpp-adapter-Hermes
- XMPP-библиотека: https://github.com/xmppjs/xmpp.js
- Документация OpenClaw plugins: docs/plugins/sdk-channel-plugins.md

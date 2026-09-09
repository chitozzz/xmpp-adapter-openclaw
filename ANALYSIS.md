# Технический анализ: XMPP-адаптер для OpenClaw

Дата: 2026-09-09. Анализ проводился на живой установке OpenClaw 2026.9.2,
референс — официальный плагин @openclaw/irc.

## 1. Почему Node.js (а не Python)

**OpenClaw — это Node.js-платформа.** Плагины грузятся в процесс gateway
как ES-модули и обязаны использовать host API через `openclaw/plugin-sdk/*`.
Python-код подключить нельзя: нет механизма внедрения внешних процессов,
кроме standalone-мостов (что для Python-модуля с asyncio всё равно
требовало бы Node-обёртку).

**Вердикт: писать на Node.js (TypeScript).** Мой Hermes-адаптер
используется только как спецификация функционала — логику переносим, код
переписываем.

XMPP-библиотека для Node: **`@xmpp/client`** (xmpp.js) — актуальный
мейнтейнимый клиент, ES-модули, peer-зависимость `@xmpp-plugins/*`
(одноимённые плагины XEP).

## 2. Архитектура плагина (по образцу @openclaw/irc)

### 2.1 Файлы плагина

```
xmpp-adapter-openclaw/
├── openclaw.plugin.json     # манифест: id, channels, configSchema
├── package.json             # name, type: "module", openclaw.* секция
├── index.js                 # defineBundledChannelEntry({ id: "xmpp", ... })
├── dist/
│   ├── channel-plugin-api.js    # экспорт xmppPlugin (capabilities + messaging)
│   ├── runtime-api.js           # setXmppRuntime(runtime) — инжект gateway
│   ├── secret-contract-api.js   # channelSecrets (secret management)
│   └── ... (channel.js, inbound.ts, outbound.ts — собранный dist)
├── src/                     # TypeScript исходники
│   ├── channel.ts           # аккаунты, config, allowlist
│   ├── inbound.ts           # приём сообщений → ingress pipeline
│   ├── outbound.ts          # отправка (sendMessageXmpp)
│   ├── xmpp-client.ts       # обёртка над @xmpp/client
│   └── ...
├── tsconfig.json
└── README.md / PLAN.md / ANALYSIS.md
```

### 2.2 Структура манифеста (openclaw.plugin.json)

IRC-плагин использует:
- `id`, `name`, `description`
- `doctorContract: { configRepair: true }`
- `activation: { onStartup: true }` (у IRC false; XMPP боту нужен autostart)
- `channels: ["xmpp"]`
- `channelConfigs.xmpp.schema` — JSON Schema (draft-07) для конфига канала:
  `jid`, `password`, `host`, `port`, `tls`, `allowFrom`, `mucNick`,
  `homeChannel`, `enabled`
- `uiHints` для UI

Уже существующий скелет в `~/.openclaw/plugins/xmpp/` (сгенерирован
`openclaw plugins dev`) подтверждает эту форму.

### 2.3 Plugin API surface (то, что реализуем)

Три точки входа (как у IRC):
1. **`xmppPlugin`** (channel-plugin-api) — plugin manifest runtime-часть:
   - `capabilities: { chatTypes: ["direct", "group"], media: true/false }`
   - `messaging.targetPrefixes: ["xmpp"]`
   - `messaging.normalizeTarget` — `xmpp:foo@bar` → `foo@bar`
   - `messaging.inferTargetChatType` — `@conference.` → group
2. **`setXmppRuntime(runtime)`** — сюда gateway передаёт runtime-объект;
   здесь стартуем XMPP-клиент, подписываемся на события, шлём ingress.
3. **`channelSecrets`** — `collectRuntimeConfigAssignments(cfg)` для
   password (чтобы не пихать пароль в config в открытом виде).

### 2.4 Ключевые host API (из IRC-плагина)

**ВАЖНО (найдено при живой интеграции 2026-09-09):** канал стартует НЕ в
`registerFull`/`setRuntime`, а через **`base.gateway.startAccount(ctx)`** —
его вызывает сам gateway для каждого включённого аккаунта канала. IRC-плагин:

```js
gateway: { startAccount: async (ctx) => await startIrcGatewayAccount({...ctx}) }

async function startIrcGatewayAccount(ctx) {
  const statusSink = createAccountStatusSink({ accountId, setStatus: ctx.setStatus });
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: () => monitorIrcProvider({ accountId, config: ctx.cfg, runtime: ctx.runtime, abortSignal, statusSink }),
    stop: (monitor) => monitor.stop(),
  });
}
```

- `ctx`: `account`, `accountId`, `cfg`, `runtime`, `abortSignal`, `setStatus`,
  `log`
- `statusSink({ lastInboundAt/lastOutboundAt/lifecycle })` — heartbeat для
  health-monitor (без него канал получает `restarting (reason: stopped)`)
- `channelReadyPatch()` — статус «готов» после коннекта
- Прямой вызов `dispatchInboundDirectDmWithRuntime` из «сырого» обработчика
  сообщений работает, но правильнее положить ingress в account-runtime
  (monitor), как делает IRC (`createChannelIngressMonitor`)

- `openclaw/plugin-sdk/channel-entry-contract` — `defineBundledChannelEntry`
- `openclaw/plugin-sdk/channel-ingress-runtime` — `channelIngressRoutes`,
  `createChannelIngressResolver`
- `openclaw/plugin-sdk/channel-outbound` — `createChannelIngressMonitor`,
  `bindIngressLifecycleToReplyOptions`, `deliverFormattedTextWithAttachments`
- `openclaw/plugin-sdk/channel-inbound` — `logInboundDrop`,
  `resolveChannelInboundRouteEnvelope`
- `openclaw/plugin-sdk/channel-pairing` — `createChannelPairingController`
- `openclaw/plugin-sdk/reply-payload` — `deliverFormattedTextWithAttachments`
- `openclaw/plugin-sdk/reply-chunking` — `chunkTextWithMode` (сплит длинных
  сообщений)
- `openclaw/plugin-sdk/gateway-runtime` — `channelReadyPatch`
- `openclaw/plugin-sdk/extension-shared` — `resolveLoggerBackedRuntime`

### 2.5 Поток сообщений (ingress → agent)

1. `@xmpp/client` → `stanza` event → наш парсер (chat / groupchat)
2. `createIrcIngressSubject`-аналог → `xmppIngressIdentity`
  (defineStableChannelIngressIdentity)
3. allowlist-фильтр (JID bare == allowFrom)
4. Group policy: у IRC `routeDescriptorsForIrcGroup` — для XMPP то же с
   `xmpp:muc`
5. `createChannelIngressMonitor` → ingress resolver → agent turn
6. Ответ агента → `deliverFormattedTextWithAttachments` → наш
   `sendMessageXmpp` → stanza out

### 2.6 Поток исходящих (outbound)

- `sendFormattedXmppText(ctx)`: чанкинг (`resolveTextChunkLimit`,
  `chunkTextWithMode`), затем `sendMessageXmpp(to, text, opts)`
- Возврат `MessageReceipt` (kind: "conversation", id: target)
- В Hermes это делал `_split_message` (4000 символов) + `_strip_markdown`

## 3. Секреты

IRC решает через `resolvePassword(accountId, merged)` + env
(`IRC_HOST`, `IRC_NICK` в `configuredState.env.allOf`). Для XMPP:
`XMPP_JID` + `XMPP_PASSWORD` в env, пароль — через
`channelSecrets.collectRuntimeConfigAssignments`.

## 4. Существующие артефакты

- **Скелет плагина**: `~/.openclaw/plugins/xmpp/` — уже сгенерирован, но
  содержит только заглушки (runtime-api.js — console.log). Годится как
  каркас dist-структуры.
- **IRC-плагин** (@openclaw/irc 2026.9.2): полный референс —
  `~/.openclaw/npm/projects/openclaw-irc-ec4090c3a8/node_modules/@openclaw/irc/`
  (2.4k строк dist; исходники TS не поставляются, но читаются по регионы
  `//#region extensions/irc/src/...`).

## 5. Риски и открытые вопросы

- Точная сигнатура `runtime`-объекта в `setXmppRuntime` — изучить
  `runtime-xy-FcjJC.js` IRC-плагина (как он хранит runtime и что вызывает).
- Типизация plugin-sdk — генерится из хоста; для разработки можно
  подкладывать `.d.ts` из `openclaw` пакета.
- `media: true` в capabilities скелета — XMPP умеет OMEMO/HTTP-upload, но
  для v1 ограничимся текстом (media: false), чтобы не завышать контракт.
- Версия host: `minHostVersion: ">=2026.6.9"` (по IRC).

## 6. Пример окружения (обезличено)

- OpenClaw 2026.9.2, gateway на loopback с auth-токеном в конфиге
- Пакет установлен глобально в node_modules
- Плагины живут в `~/.openclaw/plugins/` (dev) и
  `~/.openclaw/npm/projects/` (npm-установленные)
- XMPP-сервер: любой standards-compliant (Prosody, ejabberd, Snikket и т.п.)

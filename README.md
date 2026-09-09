# xmpp-adapter-openclaw

XMPP/Jabber channel plugin для [OpenClaw](https://openclaw.ai) — даёт агенту
канал связи через XMPP: приватные чаты и групповые (MUC).

Порт функционала [xmpp-adapter-Hermes](https://github.com/chitozzz/xmpp-adapter-Hermes)
(Python/slixmpp) на Node.js под plugin SDK OpenClaw.

## Возможности (целевые)

- 1:1 чаты (приватные сообщения)
- MUC — групповые чаты (XEP-0045), ответ при упоминании ника
- Presence (статус «онлайн»)
- Индикатор печати (XEP-0085)
- XMPP Ping keepalive (XEP-0199)
- STARTTLS, автоопределение сервера из JID (SRV)
- Allowlist по JID
- Конвертация markdown → plain text
- Доставка cron/уведомлений в home channel

## Статус

🚧 План разработки — см. [PLAN.md](PLAN.md), технический разбор —
[ANALYSIS.md](ANALYSIS.md).

## Установка (после реализации)

```bash
openclaw plugins install <путь-к-репо>
# или
git clone https://github.com/chitozzz/xmpp-adapter-openclaw
openclaw plugins install ./xmpp-adapter-openclaw
openclaw channels add xmpp
```

## Лицензия

MIT

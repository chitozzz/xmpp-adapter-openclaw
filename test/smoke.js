/**
 * smoke.js — standalone smoke-тест XmppClient (Этап 1 DoD).
 *
 * Коннектится к XMPP, шлёт себе сообщение, ждёт 3с, отключается.
 * Параметры из env:
 *   XMPP_JID, XMPP_PASSWORD, XMPP_HOST (опц.), XMPP_PORT (опц.)
 *
 * Запуск: node test/smoke.js
 */

import { XmppClient } from "../src/xmpp-client.js";

const jid = process.env.XMPP_JID;
const password = process.env.XMPP_PASSWORD;
const host = process.env.XMPP_HOST;
const port = process.env.XMPP_PORT ? Number(process.env.XMPP_PORT) : undefined;

if (!jid || !password) {
  console.error("Set XMPP_JID and XMPP_PASSWORD env vars");
  process.exit(1);
}

const timeouts = [];
const fail = (msg) => {
  console.error("FAIL:", msg);
  timeouts.forEach(clearTimeout);
  process.exit(1);
};

const client = new XmppClient({ jid, password, host, port });

client.on("online", async () => {
  console.log("PASS: online");
  try {
    await client.sendChat(jid, "Smoke test from xmpp-adapter-openclaw 🎉");
    console.log("PASS: self-message sent");
  } catch (e) {
    fail("sendChat failed: " + e.message);
  }
  // ждём эхо от себя (не должно прийти — эхо-фильтр) или 3с тишины
  const t = setTimeout(async () => {
    console.log("PASS: no echo received (filter works)");
    try {
      await client.stop();
      console.log("PASS: clean disconnect");
      process.exit(0);
    } catch (e) {
      fail("stop failed: " + e.message);
    }
  }, 3000);
  timeouts.push(t);
});

client.on("message", (msg) => {
  // В смоук-тесте мы не должны получать собственное эхо.
  console.log("INFO: incoming message:", JSON.stringify(msg));
});

client.on("error", (err) => {
  fail("client error: " + err.message);
});

// Общий таймаут 30с
timeouts.push(setTimeout(() => fail("global timeout"), 30_000));

console.log("Connecting to", host ? `${host}:${port ?? 5222}` : "(SRV lookup)");
client.start().catch((e) => fail("start failed: " + e.message));

import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamApiError, XirsysClient } from "../src/sdk/index.js";

test("requests geo-routed Xirsys ICE credentials in the standard WebRTC array", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new XirsysClient({
    ident: "account",
    secret: "secret-value",
    channel: "voice/production",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        s: "ok",
        v: {
          iceServers: [{
            urls: ["stun:example.xirsys.com", "turn:example.xirsys.com:3478?transport=udp"],
            username: "temporary-user",
            credential: "temporary-password",
          }],
        },
      });
    },
  });

  const servers = await client.getIceServers({
    expiresInSeconds: 60,
    userIp: "8.8.8.8",
  });

  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.username, "temporary-user");
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/_turn/voice/production");
  assert.equal(url.searchParams.get("webrtc"), "1");
  assert.equal(url.searchParams.get("expire"), "60");
  assert.equal(url.searchParams.get("geo"), "1");
  assert.equal(requestedInit?.method, "PUT");
  assert.equal(
    requestedInit?.body,
    JSON.stringify({ user_ip: "8.8.8.8" }),
  );
  assert.match(String((requestedInit?.headers as Record<string, string>).Authorization), /^Basic /);
});

test("falls back to normal routing when the end-user address is not public", async () => {
  let requestedUrl = "";
  let requestedBody: BodyInit | null | undefined;
  const client = new XirsysClient({
    ident: "account",
    secret: "secret-value",
    channel: "voice",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = init?.body;
      return Response.json({
        s: "ok",
        v: { iceServers: [{ urls: "turn:example.xirsys.com" }] },
      });
    },
  });

  await client.getIceServers({ userIp: "::ffff:127.0.0.1" });

  assert.equal(new URL(requestedUrl).searchParams.has("geo"), false);
  assert.equal(requestedBody, undefined);
});

test("returns a credential-safe Xirsys error", async () => {
  const client = new XirsysClient({
    ident: "account",
    secret: "do-not-leak-this",
    channel: "voice",
    fetch: async () => Response.json({ s: "error", v: "unauthorized" }, { status: 401 }),
  });

  await assert.rejects(
    client.getIceServers(),
    (error: unknown) =>
      error instanceof UpstreamApiError &&
      error.status === 401 &&
      !error.message.includes("do-not-leak-this") &&
      !error.message.includes("unauthorized"),
  );
});

test("rejects invalid credential lifetimes before calling Xirsys", async () => {
  let called = false;
  const client = new XirsysClient({
    ident: "account",
    secret: "secret",
    channel: "voice",
    fetch: async () => {
      called = true;
      return Response.json({});
    },
  });

  await assert.rejects(client.getIceServers(0), RangeError);
  assert.equal(called, false);
});

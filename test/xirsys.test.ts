import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamApiError, XirsysClient } from "../src/sdk/index.js";

test("requests browser-ready Xirsys ICE credentials and normalizes object shape", async () => {
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
          iceServers: {
            urls: ["stun:example.xirsys.com", "turn:example.xirsys.com:3478?transport=udp"],
            username: "temporary-user",
            credential: "temporary-password",
          },
        },
      });
    },
  });

  const servers = await client.getIceServers(60);

  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.username, "temporary-user");
  assert.match(requestedUrl, /\/_turn\/voice\/production\?webrtc=1&expire=60/);
  assert.equal(requestedInit?.method, "PUT");
  assert.equal(requestedInit?.body, JSON.stringify({ format: "urls" }));
  assert.match(String((requestedInit?.headers as Record<string, string>).Authorization), /^Basic /);
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

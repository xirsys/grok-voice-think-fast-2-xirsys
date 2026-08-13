import assert from "node:assert/strict";
import test from "node:test";

import { parseWebRtcPortRange, server } from "../src/server.js";

test("validates the optional WebRTC UDP port range", () => {
  assert.deepEqual(parseWebRtcPortRange("50000", "50100"), [50000, 50100]);
  assert.equal(parseWebRtcPortRange(undefined, undefined), undefined);
  assert.throws(
    () => parseWebRtcPortRange("50000", undefined),
    /must be set together/,
  );
  assert.throws(
    () => parseWebRtcPortRange("50100", "50000"),
    /must be within 1024-65535 and ordered/,
  );
});

test("bootstrap mints short-lived credentials without returning either provider secret", async (context) => {
  process.env.XIRSYS_IDENT = "account";
  process.env.XIRSYS_SECRET = "xirsys-long-lived-secret";
  process.env.XIRSYS_CHANNEL = "voice";
  const originalFetch = globalThis.fetch;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    if (url.endsWith("/v1/realtime/client_secrets")) {
      return Response.json({
        value: "xai-realtime-client-secret-server-test",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    if (url.includes("/_turn/voice")) {
      return Response.json({
        s: "ok",
        v: {
          iceServers: {
            urls: "turn:example.xirsys.com",
            username: "temporary-turn-user",
            credential: "temporary-turn-password",
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await originalFetch(`http://127.0.0.1:${address.port}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      xaiApiKey: "xai-standard-key-never-returned",
      forceRelay: true,
      reasoningEffort: "high",
    }),
  });
  const bodyText = await response.text();
  const body = JSON.parse(bodyText);

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.forceRelay, true);
  assert.equal(body.model, "grok-voice-think-fast-2.0");
  assert.match(body.signalingUrl, /^\.\/api\/signaling\//);
  assert.ok(!bodyText.includes("xai-standard-key-never-returned"));
  assert.ok(!bodyText.includes("xai-realtime-client-secret-server-test"));
  assert.ok(!bodyText.includes("xirsys-long-lived-secret"));
});

test("bootstrap rejects malformed xAI keys before contacting a provider", async (context) => {
  const originalFetch = globalThis.fetch;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  globalThis.fetch = async () => {
    throw new Error("Provider fetch must not run");
  };

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await originalFetch(`http://127.0.0.1:${address.port}/api/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xaiApiKey: "wrong" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "A valid xAI API key is required" });
});

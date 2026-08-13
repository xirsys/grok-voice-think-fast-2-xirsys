import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamApiError, XaiClient } from "../src/sdk/index.js";

test("exchanges an xAI key for a short-lived Realtime client secret", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new XaiClient({
    apiKey: "xai-test-key-that-is-long-enough",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        value: "xai-realtime-client-secret-example",
        expires_at: 1_774_274_445,
      });
    },
  });

  const secret = await client.createClientSecret(300);

  assert.equal(secret.value, "xai-realtime-client-secret-example");
  assert.equal(secret.expiresAt, 1_774_274_445);
  assert.equal(requestedUrl, "https://api.x.ai/v1/realtime/client_secrets");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.body, JSON.stringify({ expires_after: { seconds: 300 } }));
});

test("normalizes xAI failures without disclosing response details", async () => {
  const client = new XaiClient({
    apiKey: "xai-test-key-that-is-long-enough",
    fetch: async () =>
      Response.json({ error: { message: "key xai-secret-should-not-appear" } }, { status: 401 }),
  });

  await assert.rejects(
    client.createClientSecret(),
    (error: unknown) =>
      error instanceof UpstreamApiError &&
      error.status === 401 &&
      !error.message.includes("xai-secret-should-not-appear"),
  );
});

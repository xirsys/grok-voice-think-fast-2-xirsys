import assert from "node:assert/strict";
import test from "node:test";

import {
  base64Pcm16ToFloat32,
  classifyCandidateType,
  float32ToBase64Pcm16,
  normalizeIceServers,
  routeLabel,
} from "../public/sdk/grok-voice.js";

test("labels direct, STUN, and TURN candidate paths precisely", () => {
  assert.equal(classifyCandidateType("host"), "direct");
  assert.equal(classifyCandidateType("srflx"), "stun");
  assert.equal(classifyCandidateType("prflx"), "peer-reflexive");
  assert.equal(classifyCandidateType("relay"), "turn");
  assert.equal(routeLabel("stun"), "Direct (STUN-discovered)");
  assert.equal(routeLabel("turn"), "TURN relay");
});

test("accepts Xirsys ICE object or array response shapes", () => {
  const server = { urls: "turn:example.xirsys.com", username: "u", credential: "p" };
  assert.deepEqual(normalizeIceServers(server), [server]);
  assert.deepEqual(normalizeIceServers([server]), [server]);
  assert.throws(() => normalizeIceServers({ username: "missing urls" }), TypeError);
});

test("round-trips PCM16 base64 audio", () => {
  const original = new Float32Array([-1, -0.5, 0, 0.5, 0.999]);
  const restored = base64Pcm16ToFloat32(float32ToBase64Pcm16(original));
  assert.equal(restored.length, original.length);
  for (let index = 0; index < original.length; index += 1) {
    assert.ok(Math.abs((restored[index] ?? 0) - (original[index] ?? 0)) < 0.001);
  }
});

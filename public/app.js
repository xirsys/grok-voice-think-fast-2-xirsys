import { GrokVoiceClient } from "./sdk/grok-voice.js";

const elements = {
  apiKey: document.querySelector("#xai-api-key"),
  keyField: document.querySelector("#api-key-field"),
  toggleKey: document.querySelector("#toggle-api-key"),
  forceRelay: document.querySelector("#force-relay"),
  highReasoning: document.querySelector("#high-reasoning"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  mute: document.querySelector("#mute"),
  status: document.querySelector("#status"),
  model: document.querySelector("#model"),
  iceRoute: document.querySelector("#ice-route"),
  bridgeState: document.querySelector("#bridge-state"),
  inputTranscript: document.querySelector("#input-transcript"),
  outputTranscript: document.querySelector("#output-transcript"),
  diagnosticRoute: document.querySelector("#diagnostic-route"),
  diagnosticPath: document.querySelector("#diagnostic-path"),
  diagnosticTurn: document.querySelector("#diagnostic-turn"),
  eventLog: document.querySelector("#event-log"),
  text: document.querySelector("#text-message"),
  send: document.querySelector("#send"),
};

const client = new GrokVoiceClient();
let bringYourOwnKey = true;
let muted = false;
let lastStatsFingerprint = "";

void loadConfiguration();

client.addEventListener("status", ({ detail }) => {
  setStatus(detail.status);
  const connected = detail.status === "connected";
  elements.connect.disabled = detail.status !== "idle";
  elements.disconnect.disabled = detail.status === "idle";
  elements.mute.disabled = !connected;
  elements.send.disabled = !connected;
  if (connected) window.setTimeout(showStats, 700);
});

client.addEventListener("ice-state", ({ detail }) => {
  elements.iceRoute.textContent = `ICE ${detail.state}`;
  log("ice", detail.state);
  if (["connected", "completed"].includes(detail.state)) void showStats();
});

client.addEventListener("ice-gathering-state", ({ detail }) => {
  log("ICE gathering", detail.state);
});

client.addEventListener("server-peer-state", ({ detail }) => {
  elements.bridgeState.textContent = `Relay peer ${detail.connectionState}`;
  log("relay peer", `${detail.connectionState} · ICE ${detail.iceConnectionState}`);
});

client.addEventListener("realtime", ({ detail }) => {
  if (detail.type === "bridge.ready") {
    elements.bridgeState.textContent = "Grok bridge ready";
    elements.model.textContent = `${detail.model} · ${detail.voice}`;
  }
  if (detail.type === "conversation.item.input_audio_transcription.updated") {
    elements.inputTranscript.textContent = detail.transcript || detail.text || "Listening…";
  }
  if (
    detail.type === "response.output_audio_transcript.delta" ||
    detail.type === "response.audio_transcript.delta"
  ) {
    elements.outputTranscript.textContent += detail.delta || "";
  }
  if (
    detail.type === "response.output_audio_transcript.done" ||
    detail.type === "response.audio_transcript.done"
  ) {
    elements.outputTranscript.textContent = detail.transcript || elements.outputTranscript.textContent;
  }
  if (detail.type === "response.created") elements.outputTranscript.textContent = "";
  if (detail.type === "error" || detail.type === "bridge.error") {
    log("error", detail.error?.message || "Realtime error");
  } else if (!detail.type?.includes("audio.delta")) {
    log("grok", detail.type || "event");
  }
});

client.addEventListener("error", ({ detail }) => log("error", detail.error.message));

elements.connect.addEventListener("click", async () => {
  let xaiApiKey = elements.apiKey.value.trim();
  if (bringYourOwnKey && !xaiApiKey) {
    elements.apiKey.focus();
    return;
  }
  resetSessionUi();
  const connection = client.connect({
    xaiApiKey,
    forceRelay: elements.forceRelay.checked,
    reasoningEffort: elements.highReasoning.checked ? "high" : "none",
  });
  elements.apiKey.value = "";
  xaiApiKey = "";
  try {
    await connection;
  } catch (error) {
    log("connect failed", error.message);
  }
});

elements.disconnect.addEventListener("click", () => client.disconnect());
elements.mute.addEventListener("click", () => {
  muted = !muted;
  client.setMuted(muted);
  elements.mute.textContent = muted ? "Unmute" : "Mute";
});
elements.toggleKey.addEventListener("click", () => {
  const reveal = elements.apiKey.type === "password";
  elements.apiKey.type = reveal ? "text" : "password";
  elements.toggleKey.textContent = reveal ? "Hide" : "Show";
});
elements.send.addEventListener("click", sendText);
elements.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendText();
});

async function loadConfiguration() {
  try {
    const response = await fetch("./api/health", { cache: "no-store" });
    const data = await response.json();
    bringYourOwnKey = data.bringYourOwnKey !== false;
    elements.model.textContent = `${data.model} · ${data.voice}`;
    if (!bringYourOwnKey) {
      elements.keyField.hidden = true;
      elements.connect.disabled = false;
    }
  } catch {
    log("setup", "Health check unavailable");
  }
}

function sendText() {
  const text = elements.text.value.trim();
  if (!text) return;
  client.sendText(text);
  elements.inputTranscript.textContent = text;
  elements.text.value = "";
}

async function showStats() {
  try {
    const stats = await client.getConnectionStats();
    if (!stats) return;
    const rtt = Number.isFinite(stats.currentRoundTripTime)
      ? `${Math.round(stats.currentRoundTripTime * 1000)} ms RTT`
      : "RTT pending";
    const protocol = stats.localProtocol?.toUpperCase() || "unknown protocol";
    elements.iceRoute.textContent = `${stats.routeLabel} · ${protocol} · ${rtt}`;
    elements.diagnosticRoute.textContent = stats.routeLabel;
    elements.diagnosticPath.textContent = [
      stats.relayEnforced ? "relay-only policy" : `${stats.localCandidateType || "unknown"} candidate`,
      protocol,
      rtt,
    ].join(" · ");
    elements.diagnosticTurn.textContent =
      stats.route === "turn"
        ? [stats.turnUrl || "Xirsys TURN", stats.relayProtocol?.toUpperCase()].filter(Boolean).join(" · ")
        : "STUN connectivity; media is not relayed";

    const fingerprint = JSON.stringify({
      route: stats.route,
      type: stats.localCandidateType,
      protocol: stats.localProtocol,
      turnUrl: stats.turnUrl,
    });
    if (fingerprint !== lastStatsFingerprint) {
      lastStatsFingerprint = fingerprint;
      log("selected path", `${stats.routeLabel} · ${protocol}`);
    }
  } catch (error) {
    log("stats", error.message);
  }
}

function resetSessionUi() {
  lastStatsFingerprint = "";
  elements.inputTranscript.textContent = "Listening for you…";
  elements.outputTranscript.textContent = "Grok will answer here.";
  elements.iceRoute.textContent = "Gathering ICE candidates";
  elements.bridgeState.textContent = "Opening xAI bridge";
  elements.diagnosticRoute.textContent = "Waiting for selected ICE pair";
  elements.diagnosticPath.textContent = "Gathering candidates";
  elements.diagnosticTurn.textContent = "Waiting for selected path";
}

function setStatus(status) {
  elements.status.textContent = status.replaceAll("-", " ");
  elements.status.dataset.state = status;
}

function log(label, value) {
  const entry = document.createElement("div");
  entry.textContent = `${new Date().toLocaleTimeString()}  ${label}  ${typeof value === "string" ? value : JSON.stringify(value)}`;
  elements.eventLog.prepend(entry);
  while (elements.eventLog.children.length > 30) elements.eventLog.lastElementChild.remove();
}

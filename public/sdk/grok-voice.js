const SAMPLE_RATE = 24_000;

/** Browser SDK for the WebRTC-to-Node-to-Grok voice tutorial. */
export class GrokVoiceClient extends EventTarget {
  #peer;
  #dataChannel;
  #signaling;
  #stream;
  #audioContext;
  #captureSource;
  #captureNode;
  #captureSink;
  #playbackSources = new Set();
  #nextPlaybackTime = 0;
  #muted = false;
  #state = "idle";
  #relayEnforced = false;
  #pendingRemoteCandidates = [];

  get state() {
    return this.#state;
  }

  async connect({ xaiApiKey = "", forceRelay = false, reasoningEffort = "high" } = {}) {
    if (this.#state !== "idle") throw new Error("A voice session is already active");
    this.#setState("requesting-microphone");
    this.#relayEnforced = forceRelay;

    try {
      this.#audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.#audioContext.resume();
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.#setState("requesting-session");
      const response = await fetch("./api/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ xaiApiKey, forceRelay, reasoningEffort }),
      });
      xaiApiKey = "";
      const bootstrap = await response.json();
      if (!response.ok) throw new Error(bootstrap.error || "Could not create a voice session");

      this.#peer = new RTCPeerConnection({
        iceServers: normalizeIceServers(bootstrap.iceServers),
        iceTransportPolicy: forceRelay ? "relay" : "all",
      });
      this.#wirePeer();
      this.#dataChannel = this.#peer.createDataChannel("xai-voice", { ordered: true });
      this.#wireDataChannel();

      const signalingUrl = new URL(bootstrap.signalingUrl, window.location.href);
      signalingUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.#signaling = new WebSocket(signalingUrl);
      this.#wireSignaling(bootstrap);
      this.#setState("connecting");
      return await this.#waitForConnection();
    } catch (error) {
      this.#emit("error", { error: normalizeError(error) });
      this.disconnect();
      throw error;
    }
  }

  sendText(text) {
    const clean = String(text).trim();
    if (!clean) return;
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: clean }],
      },
    });
    this.#send({ type: "response.create" });
  }

  setMuted(value) {
    this.#muted = Boolean(value);
    for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !this.#muted;
    this.#emit("mute", { muted: this.#muted });
  }

  async getConnectionStats() {
    if (!this.#peer) return undefined;
    const reports = await this.#peer.getStats();
    let pair;
    reports.forEach((report) => {
      if (
        report.type === "candidate-pair" &&
        (report.selected || report.nominated || (report.state === "succeeded" && report.bytesSent > 0))
      ) {
        pair = report;
      }
    });
    if (!pair) return undefined;
    const local = reports.get(pair.localCandidateId);
    const remote = reports.get(pair.remoteCandidateId);
    const route = classifyCandidateType(local?.candidateType);

    return {
      route,
      routeLabel: routeLabel(route),
      localCandidateType: local?.candidateType,
      localProtocol: local?.protocol,
      relayProtocol: local?.relayProtocol,
      currentRoundTripTime: pair.currentRoundTripTime,
      localAddress: local?.address || local?.ip,
      localPort: local?.port,
      remoteAddress: remote?.address || remote?.ip,
      remotePort: remote?.port,
      turnUrl: sanitizeTurnUrl(local?.url),
      relayEnforced: this.#relayEnforced,
    };
  }

  disconnect() {
    this.#stopPlayback();
    this.#captureNode?.disconnect();
    this.#captureSource?.disconnect();
    this.#captureSink?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#dataChannel?.close();
    this.#peer?.close();
    if (this.#signaling && this.#signaling.readyState < WebSocket.CLOSING) {
      this.#signaling.close(1000, "client disconnected");
    }
    void this.#audioContext?.close();
    this.#peer = undefined;
    this.#dataChannel = undefined;
    this.#signaling = undefined;
    this.#stream = undefined;
    this.#audioContext = undefined;
    this.#captureSource = undefined;
    this.#captureNode = undefined;
    this.#captureSink = undefined;
    this.#pendingRemoteCandidates = [];
    this.#setState("idle");
  }

  #wirePeer() {
    this.#peer.onicegatheringstatechange = () => {
      this.#emit("ice-gathering-state", { state: this.#peer.iceGatheringState });
    };
    this.#peer.onicecandidate = ({ candidate }) => {
      if (candidate && this.#signaling?.readyState === WebSocket.OPEN) {
        this.#signaling.send(JSON.stringify({ type: "ice-candidate", candidate }));
      }
    };
    this.#peer.oniceconnectionstatechange = () => {
      this.#emit("ice-state", { state: this.#peer.iceConnectionState });
      if (["failed", "closed"].includes(this.#peer.iceConnectionState)) {
        this.#emit("error", { error: new Error("The WebRTC path could not stay connected") });
      }
    };
    this.#peer.onconnectionstatechange = () => {
      this.#emit("peer-state", { state: this.#peer.connectionState });
    };
  }

  #wireDataChannel() {
    this.#dataChannel.onopen = () => {
      this.#startCapture();
      this.#setState("connected");
    };
    this.#dataChannel.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (
          (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") &&
          typeof event.delta === "string"
        ) {
          this.#enqueueAudio(event.delta);
        }
        if (event.type === "input_audio_buffer.speech_started") this.#stopPlayback();
        this.#emit("realtime", event);
      } catch (error) {
        this.#emit("error", { error: normalizeError(error) });
      }
    };
    this.#dataChannel.onerror = () => {
      this.#emit("error", { error: new Error("The WebRTC data channel failed") });
    };
    this.#dataChannel.onclose = () => {
      if (this.#state !== "idle") this.disconnect();
    };
  }

  #wireSignaling(bootstrap) {
    this.#signaling.onmessage = async ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.type === "ready") {
          const offer = await this.#peer.createOffer();
          await this.#peer.setLocalDescription(offer);
          this.#signaling.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
        } else if (message.type === "answer") {
          await this.#peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
          for (const candidate of this.#pendingRemoteCandidates) {
            await this.#peer.addIceCandidate(candidate);
          }
          this.#pendingRemoteCandidates = [];
        } else if (message.type === "ice-candidate") {
          if (this.#peer.remoteDescription) await this.#peer.addIceCandidate(message.candidate);
          else this.#pendingRemoteCandidates.push(message.candidate);
        } else if (message.type === "peer-state") {
          this.#emit("server-peer-state", message);
        } else if (message.type === "error") {
          throw new Error(message.message || "The voice bridge failed");
        }
        this.#emit("signal", { ...message, model: bootstrap.model, voice: bootstrap.voice });
      } catch (error) {
        this.#emit("error", { error: normalizeError(error) });
      }
    };
    this.#signaling.onerror = () => {
      this.#emit("error", { error: new Error("The signaling connection failed") });
    };
    this.#signaling.onclose = ({ code }) => {
      if (!["idle", "connected"].includes(this.#state)) {
        this.#emit("error", {
          error: new Error(`The signaling connection closed early (code ${code})`),
        });
      }
    };
  }

  async #waitForConnection() {
    if (this.#state === "connected") return;
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("The WebRTC connection timed out"));
      }, 25_000);
      const onStatus = ({ detail }) => {
        if (detail.status !== "connected") return;
        cleanup();
        resolve();
      };
      const onError = ({ detail }) => {
        cleanup();
        reject(detail.error);
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.removeEventListener("status", onStatus);
        this.removeEventListener("error", onError);
      };
      this.addEventListener("status", onStatus);
      this.addEventListener("error", onError);
    });
  }

  #startCapture() {
    if (!this.#audioContext) this.#audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.#captureSource = this.#audioContext.createMediaStreamSource(this.#stream);
    this.#captureNode = this.#audioContext.createScriptProcessor(2048, 1, 1);
    this.#captureSink = this.#audioContext.createGain();
    this.#captureSink.gain.value = 0;
    this.#captureNode.onaudioprocess = ({ inputBuffer }) => {
      if (this.#muted || this.#dataChannel?.readyState !== "open") return;
      this.#send({
        type: "input_audio_buffer.append",
        audio: float32ToBase64Pcm16(inputBuffer.getChannelData(0)),
      });
    };
    this.#captureSource.connect(this.#captureNode);
    this.#captureNode.connect(this.#captureSink);
    this.#captureSink.connect(this.#audioContext.destination);
  }

  #enqueueAudio(base64) {
    if (!this.#audioContext) return;
    const samples = base64Pcm16ToFloat32(base64);
    const buffer = this.#audioContext.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.#audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#audioContext.destination);
    const now = this.#audioContext.currentTime;
    const startsAt = Math.max(now + 0.015, this.#nextPlaybackTime);
    source.start(startsAt);
    this.#nextPlaybackTime = startsAt + buffer.duration;
    this.#playbackSources.add(source);
    source.onended = () => this.#playbackSources.delete(source);
  }

  #stopPlayback() {
    for (const source of this.#playbackSources) {
      try {
        source.stop();
      } catch {
        // It may already have ended.
      }
    }
    this.#playbackSources.clear();
    this.#nextPlaybackTime = this.#audioContext?.currentTime ?? 0;
  }

  #send(event) {
    if (this.#dataChannel?.readyState !== "open") throw new Error("Voice data channel is not open");
    this.#dataChannel.send(JSON.stringify(event));
  }

  #setState(status) {
    if (this.#state === status) return;
    this.#state = status;
    this.#emit("status", { status });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export function normalizeIceServers(value) {
  const servers = Array.isArray(value) ? value : [value];
  if (
    !servers.length ||
    !servers.every(
      (server) =>
        server &&
        (typeof server.urls === "string" ||
          (Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string"))),
    )
  ) {
    throw new TypeError("The server returned invalid ICE configuration");
  }
  return servers;
}

export function classifyCandidateType(candidateType) {
  if (candidateType === "relay") return "turn";
  if (candidateType === "srflx") return "stun";
  if (candidateType === "prflx") return "peer-reflexive";
  if (candidateType === "host") return "direct";
  return "unknown";
}

export function routeLabel(route) {
  return {
    turn: "TURN relay",
    stun: "Direct (STUN-discovered)",
    "peer-reflexive": "STUN (peer-reflexive)",
    direct: "Direct (host)",
    unknown: "Path unavailable",
  }[route];
}

export function float32ToBase64Pcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export function base64Pcm16ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const pcm = new Int16Array(bytes.buffer);
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
  return samples;
}

function sanitizeTurnUrl(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/([?&](?:username|credential|token)=)[^&]+/gi, "$1[redacted]");
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

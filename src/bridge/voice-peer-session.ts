import { RTCPeerConnection } from "werift";
import type { IceServer } from "../sdk/xirsys.js";
import { XaiRealtimeRelay } from "./xai-realtime-relay.js";

interface DataChannelLike {
  readyState: string;
  send: (value: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface VoicePeerSessionOptions {
  sessionId: string;
  clientSecret: string;
  iceServers: IceServer[];
  forceRelay: boolean;
  icePortRange?: [number, number];
  model: string;
  voice: string;
  instructions: string;
  reasoningEffort: "high" | "none";
  sendSignal: (message: Record<string, unknown>) => void;
  onMilestone?: (name: string, details?: Record<string, unknown>) => void;
}

export class VoicePeerSession {
  readonly #options: VoicePeerSessionOptions;
  readonly #peer: RTCPeerConnection;
  readonly #xai: XaiRealtimeRelay;
  #dataChannel?: DataChannelLike;
  #closed = false;

  constructor(options: VoicePeerSessionOptions) {
    this.#options = options;
    this.#peer = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.forceRelay ? "relay" : "all",
      ...(options.icePortRange ? { icePortRange: options.icePortRange } : {}),
    } as never);
    this.#xai = new XaiRealtimeRelay({
      clientSecret: options.clientSecret,
      model: options.model,
      voice: options.voice,
      instructions: options.instructions,
      reasoningEffort: options.reasoningEffort,
      onEvent: (event) => this.#sendData(event),
      onClose: (code) => {
        if (!this.#closed) this.#sendData({ type: "bridge.closed", code });
      },
    });
    this.#wirePeer();
  }

  async initialize(): Promise<void> {
    await this.#xai.connect();
  }

  async handleSignal(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new TypeError("Invalid signaling message");
    }

    if (message.type === "offer" && typeof message.sdp === "string") {
      await this.#peer.setRemoteDescription({ type: "offer", sdp: message.sdp } as never);
      const answer = await this.#peer.createAnswer();
      await this.#peer.setLocalDescription(answer);
      await this.#waitForIceGatheringComplete(10_000);
      this.#options.sendSignal({
        type: "answer",
        sdp: this.#peer.localDescription?.sdp ?? answer.sdp,
      });
      this.#options.onMilestone?.("signal.answer", {
        iceGatheringState: this.#peer.iceGatheringState,
      });
      return;
    }

    if (message.type === "ice-candidate" && isRecord(message.candidate)) {
      await this.#peer.addIceCandidate(message.candidate as never);
      return;
    }

    throw new TypeError("Unsupported signaling message");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#dataChannel?.close();
    this.#xai.close();
    this.#peer.close();
  }

  #wirePeer(): void {
    this.#peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate as unknown as Record<string, unknown> & {
        toJSON?: () => Record<string, unknown>;
      };
      const serialized = candidate.toJSON ? candidate.toJSON() : candidate;
      const summary = summarizeCandidate(serialized.candidate);
      this.#options.onMilestone?.("ice.local-candidate", {
        type: summary.type,
        protocol: summary.protocol,
      });
    };
    this.#peer.onconnectionstatechange = () => {
      this.#options.onMilestone?.("peer.state", {
        connectionState: this.#peer.connectionState,
        iceConnectionState: this.#peer.iceConnectionState,
      });
      this.#options.sendSignal({
        type: "peer-state",
        connectionState: this.#peer.connectionState,
        iceConnectionState: this.#peer.iceConnectionState,
      });
    };
    this.#peer.ondatachannel = (event) => {
      this.#attachDataChannel(event.channel as never);
    };
  }

  async #waitForIceGatheringComplete(timeoutMs: number): Promise<void> {
    if (this.#peer.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const previous = this.#peer.onicegatheringstatechange;
      const finish = () => {
        clearTimeout(timeout);
        this.#peer.onicegatheringstatechange = previous;
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.#peer.onicegatheringstatechange = (event) => {
        previous?.(event);
        if (this.#peer.iceGatheringState === "complete") finish();
      };
    });
  }

  #attachDataChannel(channel: DataChannelLike | undefined): void {
    if (!channel) return;
    this.#dataChannel = channel;
    channel.onopen = () => {
      this.#options.onMilestone?.("data-channel.open");
      this.#sendData({
        type: "bridge.ready",
        model: this.#options.model,
        voice: this.#options.voice,
      });
    };
    channel.onmessage = (event) => {
      try {
        const value = typeof event.data === "string" ? event.data : String(event.data);
        this.#xai.sendClientEvent(JSON.parse(value));
      } catch (error) {
        this.#sendData({
          type: "bridge.error",
          error: { message: error instanceof Error ? error.message : "Invalid client event" },
        });
      }
    };
    channel.onerror = () => {
      this.#options.onMilestone?.("data-channel.error");
      this.close();
    };
    channel.onclose = () => {
      this.#options.onMilestone?.("data-channel.close");
      this.close();
    };
  }

  #sendData(event: Record<string, unknown>): void {
    if (this.#dataChannel?.readyState === "open") {
      this.#dataChannel.send(JSON.stringify(event));
    }
  }
}

function summarizeCandidate(value: unknown): { type: string; protocol: string } {
  if (typeof value !== "string") return { type: "unknown", protocol: "unknown" };
  const fields = value.split(/\s+/);
  return {
    protocol: fields[2]?.toLowerCase() ?? "unknown",
    type: fields[7]?.toLowerCase() ?? "unknown",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  model: string;
  voice: string;
  instructions: string;
  reasoningEffort: "high" | "none";
  sendSignal: (message: Record<string, unknown>) => void;
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
      this.#options.sendSignal({
        type: "answer",
        sdp: this.#peer.localDescription?.sdp ?? answer.sdp,
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
      this.#options.sendSignal({
        type: "ice-candidate",
        candidate: candidate.toJSON ? candidate.toJSON() : candidate,
      });
    };
    this.#peer.onconnectionstatechange = () => {
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

  #attachDataChannel(channel: DataChannelLike | undefined): void {
    if (!channel) return;
    this.#dataChannel = channel;
    channel.onopen = () => {
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
    channel.onerror = () => this.close();
    channel.onclose = () => this.close();
  }

  #sendData(event: Record<string, unknown>): void {
    if (this.#dataChannel?.readyState === "open") {
      this.#dataChannel.send(JSON.stringify(event));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

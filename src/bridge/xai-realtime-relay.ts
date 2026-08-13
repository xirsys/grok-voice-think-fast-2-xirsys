import WebSocket, { type RawData } from "ws";

export interface XaiRealtimeRelayOptions {
  clientSecret: string;
  model: string;
  voice: string;
  instructions: string;
  reasoningEffort: "high" | "none";
  sampleRate?: number;
  onEvent: (event: Record<string, unknown>) => void;
  onClose?: (code: number, reason: string) => void;
}

const ALLOWED_CLIENT_EVENTS = new Set([
  "input_audio_buffer.append",
  "input_audio_buffer.commit",
  "input_audio_buffer.clear",
  "conversation.item.create",
  "response.create",
  "response.cancel",
]);

/** One short-lived, server-side bridge to the xAI Realtime WebSocket. */
export class XaiRealtimeRelay {
  readonly #options: XaiRealtimeRelayOptions;
  #socket: WebSocket | undefined;

  constructor(options: XaiRealtimeRelayOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.#options.model)}`;
    const protocol = `xai-client-secret.${this.#options.clientSecret}`;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, [protocol], {
        handshakeTimeout: 10_000,
        maxPayload: 2 * 1024 * 1024,
      });
      this.#socket = socket;
      let settled = false;

      socket.once("open", () => {
        settled = true;
        this.#configure();
        resolve();
      });
      socket.on("message", (data, isBinary) => this.#handleMessage(data, isBinary));
      socket.once("error", (error) => {
        if (!settled) reject(new Error(`xAI Realtime connection failed: ${error.message}`));
      });
      socket.on("close", (code, reason) => {
        this.#options.onClose?.(code, reason.toString());
      });
    });
  }

  sendClientEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string" || !ALLOWED_CLIENT_EVENTS.has(event.type)) {
      throw new TypeError("Unsupported Realtime client event");
    }
    const payload = JSON.stringify(event);
    if (payload.length > 512_000) throw new RangeError("Realtime event is too large");
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("xAI Realtime connection is not open");
    }
    this.#socket.send(payload);
  }

  close(): void {
    this.#socket?.close(1000, "browser session closed");
    this.#socket = undefined;
  }

  #configure(): void {
    const sampleRate = this.#options.sampleRate ?? 24_000;
    this.#socket?.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: this.#options.voice,
          instructions: this.#options.instructions,
          reasoning: { effort: this.#options.reasoningEffort },
          turn_detection: {
            type: "server_vad",
            threshold: 0.72,
            prefix_padding_ms: 333,
            silence_duration_ms: 650,
          },
          audio: {
            input: {
              format: { type: "audio/pcm", rate: sampleRate },
              transcription: { model: "grok-transcribe" },
            },
            output: {
              format: { type: "audio/pcm", rate: sampleRate },
            },
          },
        },
      }),
    );
  }

  #handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    try {
      const event = JSON.parse(data.toString()) as unknown;
      if (!isRecord(event) || typeof event.type !== "string") return;
      this.#options.onEvent(event);
    } catch {
      this.#options.onEvent({
        type: "bridge.error",
        error: { message: "xAI returned an unreadable event" },
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

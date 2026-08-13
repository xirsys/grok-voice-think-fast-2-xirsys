import { getRecord, readJson, UpstreamApiError } from "./errors.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface XirsysClientOptions {
  ident: string;
  secret: string;
  channel: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface XirsysEnvelope {
  s?: string;
  v?: unknown;
}

/** Server-only client for short-lived Xirsys ICE credentials. */
export class XirsysClient {
  readonly #channel: string;
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: XirsysClientOptions) {
    if (!options.ident) throw new TypeError("Xirsys ident is required");
    if (!options.secret) throw new TypeError("Xirsys secret is required");
    if (!options.channel) throw new TypeError("Xirsys channel is required");

    this.#channel = options.channel;
    this.#baseUrl = (options.baseUrl ?? "https://global.xirsys.net").replace(/\/$/, "");
    this.#authorization = `Basic ${Buffer.from(`${options.ident}:${options.secret}`).toString("base64")}`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getIceServers(expiresInSeconds = 60): Promise<IceServer[]> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 21_600) {
      throw new RangeError("ICE credential lifetime must be an integer from 1 to 21600 seconds");
    }

    const params = new URLSearchParams({
      webrtc: "1",
      expire: String(expiresInSeconds),
    });
    const response = await this.#fetch(
      `${this.#baseUrl}/_turn/${encodeChannelPath(this.#channel)}?${params}`,
      {
        method: "PUT",
        headers: {
          Authorization: this.#authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format: "urls" }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );

    const body = await readJson(response);
    const envelope = getRecord(body) as XirsysEnvelope | undefined;
    if (!response.ok || envelope?.s !== "ok") {
      throw new UpstreamApiError(
        "Xirsys",
        response.status,
        `Xirsys TURN credential request failed (${response.status})`,
      );
    }

    const rawIceServers = getRecord(envelope.v)?.iceServers;
    const candidates = Array.isArray(rawIceServers) ? rawIceServers : [rawIceServers];
    if (!candidates.length || !candidates.every(isIceServer)) {
      throw new UpstreamApiError(
        "Xirsys",
        response.status,
        "Xirsys returned an invalid ICE server response",
      );
    }

    return candidates;
  }
}

function encodeChannelPath(channel: string): string {
  return channel
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function isIceServer(value: unknown): value is IceServer {
  const record = getRecord(value);
  const urls = record?.urls;
  const validUrls =
    typeof urls === "string" ||
    (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string"));
  const validUsername = record?.username === undefined || typeof record.username === "string";
  const validCredential = record?.credential === undefined || typeof record.credential === "string";
  return validUrls && validUsername && validCredential;
}

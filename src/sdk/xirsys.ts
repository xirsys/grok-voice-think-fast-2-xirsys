import { BlockList, isIP } from "node:net";

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

export interface XirsysIceOptions {
  expiresInSeconds?: number;
  /** Trusted, proxy-derived public address of the end user requesting ICE credentials. */
  userIp?: string;
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

  async getIceServers(options?: number | XirsysIceOptions): Promise<IceServer[]> {
    const expiresInSeconds = typeof options === "number"
      ? options
      : options?.expiresInSeconds ?? 60;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 21_600) {
      throw new RangeError("ICE credential lifetime must be an integer from 1 to 21600 seconds");
    }

    const userIp = typeof options === "number" ? undefined : normalizePublicIp(options?.userIp);
    const params = new URLSearchParams({
      webrtc: "1",
      expire: String(expiresInSeconds),
    });
    if (userIp) params.set("geo", "1");
    const geoBody = userIp ? JSON.stringify({ user_ip: userIp }) : undefined;
    const response = await this.#fetch(
      `${this.#baseUrl}/_turn/${encodeChannelPath(this.#channel)}?${params}`,
      {
        method: "PUT",
        headers: {
          Authorization: this.#authorization,
          ...(geoBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(geoBody ? { body: geoBody } : {}),
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

const nonPublicIps = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIps.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicIps.addSubnet(address, prefix, "ipv6");
}

function normalizePublicIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim();
  const normalized = candidate.toLowerCase().startsWith("::ffff:")
    ? candidate.slice(7)
    : candidate;
  const version = isIP(normalized);
  if (version === 0) return undefined;
  const family = version === 4 ? "ipv4" : "ipv6";
  return nonPublicIps.check(normalized, family) ? undefined : normalized;
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

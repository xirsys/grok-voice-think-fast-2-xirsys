import { getRecord, readJson, UpstreamApiError } from "./errors.js";

export interface XaiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface XaiClientSecret {
  value: string;
  expiresAt?: number;
}

/** Exchanges a standard xAI key for a short-lived Realtime client secret. */
export class XaiClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: XaiClientOptions) {
    if (!isXaiApiKey(options.apiKey)) throw new TypeError("A valid xAI API key is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.x.ai").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async createClientSecret(expiresInSeconds = 300): Promise<XaiClientSecret> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 600) {
      throw new RangeError("xAI client secret lifetime must be an integer from 30 to 600 seconds");
    }

    const response = await this.#fetch(`${this.#baseUrl}/v1/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: expiresInSeconds } }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body = await readJson(response);
    const record = getRecord(body);
    if (!response.ok || typeof record?.value !== "string") {
      throw new UpstreamApiError(
        "xAI",
        response.status,
        `xAI client secret request failed (${response.status})`,
      );
    }

    return {
      value: record.value,
      ...(typeof record.expires_at === "number" ? { expiresAt: record.expires_at } : {}),
    };
  }
}

export function isXaiApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("xai-") &&
    value.length >= 20 &&
    value.length <= 512 &&
    !/\s/.test(value)
  );
}

export class UpstreamApiError extends Error {
  readonly service: string;
  readonly status: number;

  constructor(service: string, status: number, message: string) {
    super(message);
    this.name = "UpstreamApiError";
    this.service = service;
    this.status = status;
  }
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

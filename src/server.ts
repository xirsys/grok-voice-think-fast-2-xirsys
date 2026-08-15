import "dotenv/config";

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Request } from "express";
import WebSocket, { WebSocketServer } from "ws";

import { VoicePeerSession } from "./bridge/voice-peer-session.js";
import {
  isXaiApiKey,
  UpstreamApiError,
  XaiClient,
  XirsysClient,
  type IceServer,
} from "./sdk/index.js";

interface PendingSession {
  traceId: string;
  clientSecret: string;
  iceServers: IceServer[];
  forceRelay: boolean;
  reasoningEffort: "high" | "none";
  expiresAt: number;
}

const app = express();
const server = http.createServer(app);
const signalingServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const pendingSessions = new Map<string, PendingSession>();
const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const host = process.env.HOST ?? "0.0.0.0";
const port = parsePositiveInteger(process.env.PORT, 3002);
const publicOrigin = normalizeOrigin(process.env.PUBLIC_ORIGIN);
const model = process.env.XAI_MODEL ?? "grok-voice-think-fast-2.0";
const voice = process.env.XAI_VOICE ?? "eve";
const icePortRange = parseWebRtcPortRange(
  process.env.WEBRTC_UDP_PORT_MIN,
  process.env.WEBRTC_UDP_PORT_MAX,
);
const instructions =
  process.env.XAI_INSTRUCTIONS ??
  "You are a concise, curious voice assistant. Speak naturally and keep answers brief.";

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(publicDirectory));

if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

const bootstrapRateLimit = createRateLimiter({
  maxRequests: parsePositiveInteger(process.env.BOOTSTRAP_RATE_LIMIT_MAX, 10),
  windowMs: parsePositiveInteger(process.env.BOOTSTRAP_RATE_LIMIT_WINDOW_MS, 60_000),
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    model,
    voice,
    bringYourOwnKey: !process.env.XAI_API_KEY,
  });
});

app.post(
  "/api/bootstrap",
  disableCredentialCaching,
  enforcePublicOrigin,
  bootstrapRateLimit,
  async (request, response, next) => {
    try {
      const apiKey = readXaiApiKey(request);
      const forceRelay = request.body?.forceRelay === true;
      const reasoningEffort = request.body?.reasoningEffort === "none" ? "none" : "high";
      const xai = new XaiClient({
        apiKey,
        baseUrl: process.env.XAI_API_BASE ?? "https://api.x.ai",
      });
      const xirsys = new XirsysClient({
        ident: requireEnvironment("XIRSYS_IDENT"),
        secret: requireEnvironment("XIRSYS_SECRET"),
        channel: requireEnvironment("XIRSYS_CHANNEL"),
        baseUrl: process.env.XIRSYS_API_BASE ?? "https://global.xirsys.net",
      });
      const userIp = request.ip;

      const [clientSecret, iceServers] = await Promise.all([
        xai.createClientSecret(
          parsePositiveInteger(process.env.XAI_CLIENT_SECRET_TTL_SECONDS, 300),
        ),
        xirsys.getIceServers({
          expiresInSeconds: parsePositiveInteger(process.env.XIRSYS_ICE_TTL_SECONDS, 60),
          ...(userIp ? { userIp } : {}),
        }),
      ]);
      const sessionId = crypto.randomBytes(24).toString("base64url");
      const traceId = crypto.randomBytes(6).toString("hex");
      pendingSessions.set(sessionId, {
        traceId,
        clientSecret: clientSecret.value,
        iceServers,
        forceRelay,
        reasoningEffort,
        expiresAt: Date.now() + 120_000,
      });
      logSession(traceId, "bootstrap.ready", {
        forceRelay,
        iceUrls: countIceUrls(iceServers),
      });

      response.status(201).json({
        sessionId,
        signalingUrl: `./api/signaling/${sessionId}`,
        iceServers,
        forceRelay,
        model,
        voice,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("*splat", (_request, response) => {
  response.sendFile(path.join(publicDirectory, "index.html"));
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof UpstreamApiError) {
    console.error(`${error.service} request failed`, {
      status: error.status,
      message: error.message,
    });
    response.status(502).json({ error: error.message, service: error.service });
    return;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error("Unexpected server error", error instanceof Error ? error.message : error);
  response.status(500).json({ error: "Unexpected server error" });
};
app.use(errorHandler);

server.on("upgrade", (request, socket, head) => {
  const sessionId = getSignalingSessionId(request.url);
  const session = sessionId ? pendingSessions.get(sessionId) : undefined;
  if (
    !sessionId ||
    !session ||
    session.expiresAt <= Date.now() ||
    (publicOrigin && request.headers.origin !== publicOrigin)
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  pendingSessions.delete(sessionId);
  signalingServer.handleUpgrade(request, socket, head, (webSocket) => {
    logSession(session.traceId, "signaling.accepted");
    void runSignalingSession(webSocket, sessionId, session);
  });
});

async function runSignalingSession(
  webSocket: WebSocket,
  sessionId: string,
  session: PendingSession,
): Promise<void> {
  const sendSignal = (message: Record<string, unknown>) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
  };
  const peer = new VoicePeerSession({
    sessionId,
    clientSecret: session.clientSecret,
    iceServers: session.iceServers,
    forceRelay: session.forceRelay,
    ...(icePortRange ? { icePortRange } : {}),
    model,
    voice,
    instructions,
    reasoningEffort: session.reasoningEffort,
    sendSignal,
    onMilestone: (name, details) => logSession(session.traceId, name, details),
  });

  let signalQueue = Promise.resolve();

  webSocket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendSignal({ type: "error", message: "Invalid signaling message" });
      return;
    }

    signalQueue = signalQueue
      .then(async () => {
        if (isSignalType(message, "offer")) logSession(session.traceId, "signal.offer");
        await peer.handleSignal(message);
      })
      .catch((error: unknown) => {
        logSession(session.traceId, "signal.error", {
          message: error instanceof Error ? error.message : "Signaling failed",
        });
        sendSignal({
          type: "error",
          message: error instanceof Error ? error.message : "Signaling failed",
        });
      });
  });
  webSocket.once("close", (code) => {
    logSession(session.traceId, "signaling.closed", { code });
    peer.close();
  });
  webSocket.once("error", () => {
    logSession(session.traceId, "signaling.error");
    peer.close();
  });

  try {
    await peer.initialize();
    logSession(session.traceId, "xai.connected");
    sendSignal({ type: "ready", model, voice });
  } catch (error) {
    console.error("Voice bridge setup failed", error instanceof Error ? error.message : error);
    sendSignal({ type: "error", message: "Could not connect the voice bridge" });
    webSocket.close(1011, "voice bridge unavailable");
    peer.close();
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingSessions) {
    if (session.expiresAt <= now) pendingSessions.delete(id);
  }
}, 30_000);
cleanupTimer.unref();

if (process.env.NODE_ENV !== "test") {
  server.listen(port, host, () => {
    console.log(`Grok Voice Think Fast 2.0 + Xirsys tutorial: http://${host}:${port}`);
    if (icePortRange) {
      console.log(`WebRTC UDP port range: ${icePortRange[0]}-${icePortRange[1]}`);
    }
  });
}

export { app, server };

export function readXaiApiKey(request: Request): string {
  const value = request.body?.xaiApiKey || process.env.XAI_API_KEY;
  if (!isXaiApiKey(value)) throw new TypeError("A valid xAI API key is required");
  return value;
}

export function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("PUBLIC_ORIGIN must contain only a scheme and host");
  }
  return url.origin;
}

export function parseWebRtcPortRange(
  minimum: string | undefined,
  maximum: string | undefined,
): [number, number] | undefined {
  if (minimum === undefined && maximum === undefined) return undefined;
  if (minimum === undefined || maximum === undefined) {
    throw new TypeError("WEBRTC_UDP_PORT_MIN and WEBRTC_UDP_PORT_MAX must be set together");
  }
  const min = parsePositiveInteger(minimum, 0);
  const max = parsePositiveInteger(maximum, 0);
  if (min < 1024 || max > 65_535 || min > max) {
    throw new RangeError("WebRTC UDP port range must be within 1024-65535 and ordered");
  }
  return [min, max];
}

function getSignalingSessionId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = new URL(value, "http://localhost").pathname.match(/^\/api\/signaling\/([A-Za-z0-9_-]{32})$/);
  return match?.[1];
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new TypeError(`Missing required environment variable: ${name}`);
  return value;
}

function countIceUrls(iceServers: IceServer[]): number {
  return iceServers.reduce(
    (total, server) => total + (Array.isArray(server.urls) ? server.urls.length : 1),
    0,
  );
}

function isSignalType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}

function logSession(
  traceId: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  console.log("voice-session", {
    traceId,
    event,
    ...(details ?? {}),
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function disableCredentialCaching(
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
  next();
}

function enforcePublicOrigin(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!publicOrigin || request.get("Origin") === publicOrigin) {
    next();
    return;
  }
  response.status(403).json({ error: "Request origin is not allowed" });
}

function securityHeaders(
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  response.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

function createRateLimiter({
  maxRequests,
  windowMs,
}: {
  maxRequests: number;
  windowMs: number;
}): express.RequestHandler {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || "unknown";
    let bucket = attempts.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      attempts.set(key, bucket);
    }
    if (bucket.count >= maxRequests) {
      response.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      response.status(429).json({ error: "Too many bootstrap requests; try again shortly" });
      return;
    }
    bucket.count += 1;
    next();
  };
}

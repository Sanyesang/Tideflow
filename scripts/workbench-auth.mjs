import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "tideflow_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const BODY_LIMIT_BYTES = 2_048;
const RATE_WINDOW_MS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 8;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function parseCookieHeader(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) return { ok: false, status: 413 };
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, status: 400 };
  }
}

function originMatchesHost(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

export function parseInviteCodes(value) {
  const codes = [...new Set(String(value ?? "").split(",").map((code) => code.trim()).filter(Boolean))];
  if (!codes.length) {
    throw new Error("Invite-only workbench requires TIDEFLOW_INVITE_CODES; no code is stored in the project.");
  }
  if (codes.some((code) => code.length < 32 || !/^[A-Za-z0-9_-]+$/.test(code))) {
    throw new Error("Every Tideflow invite code must be at least 32 base64url characters. Generate one with node:crypto randomBytes(24).toString('base64url').");
  }
  return codes;
}

export function createWorkbenchAuth({
  inviteCodes,
  now = Date.now,
  sessionTtlMs = SESSION_TTL_MS,
  rateWindowMs = RATE_WINDOW_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const codes = parseInviteCodes(inviteCodes);
  const inviteDigests = codes.map(digest);
  const sessions = new Map();
  const attempts = new Map();

  function isAuthenticated(request) {
    const token = parseCookieHeader(request.headers.cookie).get(COOKIE_NAME);
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function attemptIsLimited(address) {
    const current = now();
    let state = attempts.get(address);
    if (!state || current - state.startedAt >= rateWindowMs) {
      state = { startedAt: current, count: 0 };
      attempts.set(address, state);
    }
    if (state.count >= maxAttempts) return true;
    state.count += 1;
    return false;
  }

  async function handle(request, response) {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (!pathname.startsWith("/api/auth/")) return false;

    if (pathname === "/api/auth/session") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
        return true;
      }
      sendJson(response, 200, { authenticated: isAuthenticated(request) });
      return true;
    }

    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "POST" });
        return true;
      }
      if (!originMatchesHost(request)) {
        sendJson(response, 403, { error: "Origin not allowed" });
        return true;
      }
      const token = parseCookieHeader(request.headers.cookie).get(COOKIE_NAME);
      if (token) sessions.delete(token);
      sendJson(response, 200, { authenticated: false }, {
        "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return true;
    }

    if (pathname === "/api/auth/login") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" }, { Allow: "POST" });
        return true;
      }
      if (!originMatchesHost(request)) {
        sendJson(response, 403, { error: "Origin not allowed" });
        return true;
      }

      const address = request.socket.remoteAddress || "unknown";
      if (attemptIsLimited(address)) {
        sendJson(response, 429, { error: "Too many attempts" }, { "Retry-After": String(Math.ceil(rateWindowMs / 1_000)) });
        return true;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.status === 413 ? "Request too large" : "Invalid request" });
        return true;
      }

      const candidate = typeof body.value?.inviteCode === "string" && body.value.inviteCode.length <= 256
        ? body.value.inviteCode
        : "";
      const candidateDigest = digest(candidate);
      let valid = false;
      for (const expected of inviteDigests) {
        valid = timingSafeEqual(candidateDigest, expected) || valid;
      }
      if (!valid) {
        sendJson(response, 401, { error: "Invite code is invalid" });
        return true;
      }

      attempts.delete(address);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, now() + sessionTtlMs);
      sendJson(response, 200, { authenticated: true }, {
        "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1_000)}`,
      });
      return true;
    }

    sendJson(response, 404, { error: "Not found" });
    return true;
  }

  return { handle, isAuthenticated };
}

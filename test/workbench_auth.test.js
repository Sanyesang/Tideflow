import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createWorkbenchAuth, parseInviteCodes } from "../scripts/workbench-auth.mjs";
import { createWorkbenchServer } from "../scripts/serve-workbench.mjs";

const INVITE_CODE = "0123456789abcdefghijklmnopqrstuv";
let server;
let origin;

async function start(serverInstance) {
  await new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
  const address = serverInstance.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(serverInstance) {
  if (!serverInstance?.listening) return;
  await new Promise((resolve, reject) => {
    serverInstance.close((error) => error ? reject(error) : resolve());
  });
}

function createAuthTestServer(options) {
  const auth = createWorkbenchAuth(options);
  return createServer((request, response) => {
    void auth.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(auth.isAuthenticated(request) ? 200 : 303, auth.isAuthenticated(request) ? {} : { Location: "/" });
        response.end(auth.isAuthenticated(request) ? "protected" : "redirect");
      }
    });
  });
}

describe("Tideflow invite-only workbench access", () => {
  beforeEach(async () => {
    server = createWorkbenchServer({ inviteCodes: [INVITE_CODE] });
    origin = await start(server);
  });

  afterEach(async () => {
    await close(server);
  });

  it("requires a strong configured invite and rejects missing or weak configuration", () => {
    expect(() => parseInviteCodes("")).toThrow(/TIDEFLOW_INVITE_CODES/);
    expect(() => parseInviteCodes("short-code" )).toThrow(/at least 32/);
    expect(parseInviteCodes(`${INVITE_CODE},${INVITE_CODE}`)).toEqual([INVITE_CODE]);
  });

  it("serves only the access screen before authentication and blocks app assets", async () => {
    const page = await fetch(origin);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("PRIVATE ACCESS / INVITE ONLY");
    expect(html).not.toContain('id="app-shell"');

    const protectedAsset = await fetch(`${origin}/app.js`, { redirect: "manual" });
    expect(protectedAsset.status).toBe(303);
    expect(protectedAsset.headers.get("location")).toBe("/");
  });

  it("accepts a valid invite, establishes an HttpOnly session, and logs out", async () => {
    const rejected = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ inviteCode: "invalid" }),
    });
    expect(rejected.status).toBe(401);

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ inviteCode: INVITE_CODE }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0];

    const session = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
    expect(await session.json()).toEqual({ authenticated: true });

    const dashboard = await fetch(origin, { headers: { Cookie: cookie } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('id="app-shell"');
    const appScript = await fetch(`${origin}/app.js`, { headers: { Cookie: cookie } });
    expect(appScript.status).toBe(200);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const afterLogout = await fetch(origin, { headers: { Cookie: cookie } });
    expect(await afterLogout.text()).toContain("PRIVATE ACCESS / INVITE ONLY");
  });

  it("rejects a foreign Origin and caps invite attempts", async () => {
    const crossOrigin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ inviteCode: INVITE_CODE }),
    });
    expect(crossOrigin.status).toBe(403);

    await close(server);
    const authServer = createAuthTestServer({ inviteCodes: [INVITE_CODE], maxAttempts: 2, rateWindowMs: 60_000 });
    origin = await start(authServer);
    server = authServer;
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode: "wrong" }),
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode: INVITE_CODE }),
    });
    expect(limited.status).toBe(429);
  });

  it("expires the server-side session at the configured TTL", async () => {
    await close(server);
    let currentTime = 1_000;
    server = createAuthTestServer({
      inviteCodes: [INVITE_CODE],
      sessionTtlMs: 60_000,
      now: () => currentTime,
    });
    origin = await start(server);
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ inviteCode: INVITE_CODE }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    expect(await (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })).json())
      .toEqual({ authenticated: true });

    currentTime += 60_001;
    expect(await (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })).json())
      .toEqual({ authenticated: false });
  });
});

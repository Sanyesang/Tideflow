import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkbenchAuth } from "./workbench-auth.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(projectRoot, "workbench");
const moduleRoot = resolve(projectRoot, "dist");
const browserModules = new Map([
  ["/modules/csv_candles.js", resolve(moduleRoot, "backtest/csv_candles.js")],
  ["/modules/momentum_backtest.js", resolve(moduleRoot, "backtest/momentum_backtest.js")],
]);
const staticAssets = new Map([
  ["/assets/sample-ohlcv.csv", resolve(projectRoot, "examples/synthetic-ohlcv.csv")],
]);
const publicLoginAssets = new Map([
  ["/styles.css", resolve(root, "styles.css")],
  ["/auth.css", resolve(root, "auth.css")],
  ["/login.js", resolve(root, "login.js")],
  ["/assets/tideflow-mark.svg", resolve(root, "assets/tideflow-mark.svg")],
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".csv": "text/csv; charset=utf-8",
};

function sendText(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendFile(request, response, target) {
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendText(response, 404, "Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(target)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(target).pipe(response);
}

export function createWorkbenchServer({ inviteCodes = process.env.TIDEFLOW_INVITE_CODES } = {}) {
  const auth = createWorkbenchAuth({ inviteCodes });

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        sendText(response, 400, "Bad request");
        return;
      }

      if (await auth.handle(request, response)) return;

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
        return;
      }

      const authenticated = auth.isAuthenticated(request);
      if (!authenticated) {
        if (pathname === "/" || pathname === "/index.html" || pathname === "/login.html") {
          sendFile(request, response, join(root, "login.html"));
          return;
        }
        const publicAsset = publicLoginAssets.get(pathname);
        if (publicAsset) {
          sendFile(request, response, publicAsset);
          return;
        }
        response.writeHead(303, { Location: "/", "Cache-Control": "no-store" }).end();
        return;
      }

      if (pathname === "/login.html") {
        response.writeHead(303, { Location: "/", "Cache-Control": "no-store" }).end();
        return;
      }

      const moduleTarget = browserModules.get(url.pathname);
      const assetTarget = staticAssets.get(url.pathname);
      const mappedTarget = moduleTarget || assetTarget;
      const targetRoot = moduleTarget ? moduleRoot : assetTarget ? projectRoot : root;
      const relative = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
      const target = mappedTarget || resolve(root, relative);
      if (!mappedTarget && target !== root && !target.startsWith(`${targetRoot}${sep}`)) {
        sendText(response, 403, "Forbidden");
        return;
      }
      sendFile(request, response, target);
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendText(response, 500, "Workbench request failed");
      process.stderr.write(`Tideflow workbench request failed: ${error.message}\n`);
    });
  });
}

function isDirectlyExecuted() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectlyExecuted()) {
  const rawPort = process.env.TIDEFLOW_PORT || "4179";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("TIDEFLOW_PORT must be an integer between 0 and 65535.");
  }
  const server = createWorkbenchServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`Tideflow invite-only local workbench: http://127.0.0.1:${address.port}\n`);
    process.stdout.write("Local-only session; invite codes are read from TIDEFLOW_INVITE_CODES and never logged.\n");
  });
}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const pages = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/privacy-policy", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }],
  ["/privacy-policy/", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }],
  ["/privacy-policy.html", { file: "privacy-policy.html", type: "text/html; charset=utf-8" }],
  ["/guide", { file: "guide.html", type: "text/html; charset=utf-8" }],
  ["/guide/", { file: "guide.html", type: "text/html; charset=utf-8" }],
  ["/guide.html", { file: "guide.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/site.js", { file: "site.js", type: "text/javascript; charset=utf-8" }],
]);

const assetCache = new Map([...new Set([...pages.values()].map((page) => page.file))].map((file) => {
  const body = fs.readFileSync(path.join(publicDirectory, file));
  return [file, {
    body,
    gzip: gzipSync(body, { level: 6 }),
    etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 24)}"`,
  }];
}));

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(res, status, contentType, body, method = "GET", extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    ...securityHeaders(contentType),
    "Cache-Control": contentType.startsWith("text/css") ? "public, max-age=3600" : "no-cache",
    "Content-Length": payload.length,
    ...extraHeaders,
  });
  res.end(method === "HEAD" ? undefined : payload);
}

function sendAsset(req, res, page, method) {
  const asset = assetCache.get(page.file);
  if (!asset) {
    send(res, 500, "text/plain; charset=utf-8", "Duck could not load this page.", method);
    return;
  }
  const cacheControl = page.type.startsWith("text/css")
    ? "public, max-age=86400, stale-while-revalidate=604800"
    : "public, max-age=300, stale-while-revalidate=86400";
  const commonHeaders = {
    ...securityHeaders(page.type),
    "Cache-Control": cacheControl,
    ETag: asset.etag,
    Vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, commonHeaders);
    res.end();
    return;
  }
  const useGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers["accept-encoding"] || "");
  const body = useGzip ? asset.gzip : asset.body;
  res.writeHead(200, {
    ...commonHeaders,
    "Content-Encoding": useGzip ? "gzip" : undefined,
    "Content-Length": body.length,
  });
  res.end(method === "HEAD" ? undefined : body);
}

function createDuckWebsiteServer() {
  return http.createServer((req, res) => {
    const method = req.method || "GET";
    if (!['GET', 'HEAD'].includes(method)) {
      send(res, 405, "text/plain; charset=utf-8", "Method not allowed.", method, { Allow: "GET, HEAD" });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url || "/", "http://duck.local").pathname;
    } catch {
      send(res, 400, "text/plain; charset=utf-8", "Bad request.", method);
      return;
    }

    if (pathname === "/health") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, service: "duck" }), method);
      return;
    }

    const page = pages.get(pathname);
    if (!page) {
      send(res, 404, "text/plain; charset=utf-8", "Duck wandered off. Page not found.", method);
      return;
    }

    sendAsset(req, res, page, method);
  });
}

export { assetCache, createDuckWebsiteServer, securityHeaders };

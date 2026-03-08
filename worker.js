/**
 * Grok2API Cloudflare Worker — Reverse Proxy for grok.com
 *
 * Deploy:
 *   1. npx wrangler deploy worker.js --name grok-proxy
 *   2. Set config base_proxy_url = "" and modify upstream or
 *      replace grok.com references with your worker domain.
 *
 * Environment variables (optional, set via wrangler secret):
 *   AUTH_TOKEN  — if set, requests must carry "Authorization: Bearer <AUTH_TOKEN>"
 *
 * Route mapping (via X-Target-Host header or path prefix):
 *   /                       → https://grok.com/
 *   /assets/*               → https://assets.grok.com/*
 *   /accounts/*             → https://accounts.x.ai/*
 *   /livekit/*              → https://livekit.grok.com/*
 *   (default)               → https://grok.com/*
 */

const TARGET_MAP = {
  "grok.com":          "https://grok.com",
  "assets.grok.com":   "https://assets.grok.com",
  "accounts.x.ai":     "https://accounts.x.ai",
  "livekit.grok.com":  "https://livekit.grok.com",
};

// Path-prefix → target host (order matters: longest prefix first)
const PREFIX_ROUTES = [
  { prefix: "/assets/",    target: "https://assets.grok.com",  strip: "/assets" },
  { prefix: "/accounts/",  target: "https://accounts.x.ai",    strip: "/accounts" },
  { prefix: "/livekit/",   target: "https://livekit.grok.com",  strip: "/livekit" },
];

// Headers that must NOT be forwarded to upstream
const HOP_BY_HOP = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "cdn-loop",
  "true-client-ip",
]);

// Headers that must NOT be returned to the client
const RESP_DROP = new Set([
  "content-encoding",      // Workers decompress; let CF re-encode
  "content-length",        // may change after decompression
  "transfer-encoding",
  "connection",
  "keep-alive",
  "alt-svc",
]);

export default {
  async fetch(request, env, ctx) {
    // ---- Auth gate ----
    if (env.AUTH_TOKEN) {
      const auth = request.headers.get("x-proxy-token") || "";
      if (auth !== env.AUTH_TOKEN) {
        const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (bearer !== env.AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // ---- Resolve upstream URL ----
    const url = new URL(request.url);
    let targetOrigin = "https://grok.com";
    let targetPath = url.pathname;

    // 1) Check X-Target-Host header
    const explicitHost = request.headers.get("x-target-host");
    if (explicitHost && TARGET_MAP[explicitHost]) {
      targetOrigin = TARGET_MAP[explicitHost];
    } else {
      // 2) Check path prefix
      for (const route of PREFIX_ROUTES) {
        if (url.pathname.startsWith(route.prefix)) {
          targetOrigin = route.target;
          targetPath = url.pathname.slice(route.strip.length);
          break;
        }
      }
    }

    const upstream = targetOrigin + targetPath + url.search;

    // ---- WebSocket upgrade ----
    if (request.headers.get("upgrade") === "websocket") {
      return handleWebSocket(request, upstream);
    }

    // ---- Build upstream headers ----
    const upstreamHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === "x-target-host") continue;
      if (key.toLowerCase() === "x-proxy-token") continue;
      upstreamHeaders.set(key, value);
    }

    // Override Host / Origin / Referer to match upstream
    const targetHost = new URL(targetOrigin).host;
    upstreamHeaders.set("Host", targetHost);

    if (upstreamHeaders.has("origin")) {
      upstreamHeaders.set("Origin", targetOrigin);
    }
    if (upstreamHeaders.has("referer")) {
      const ref = upstreamHeaders.get("referer");
      upstreamHeaders.set("Referer", ref.replace(url.origin, targetOrigin));
    }

    // ---- Fetch upstream ----
    const upstreamReq = new Request(upstream, {
      method:  request.method,
      headers: upstreamHeaders,
      body:    request.body,
      redirect: "manual",
    });

    let response;
    try {
      response = await fetch(upstreamReq);
    } catch (err) {
      return new Response(JSON.stringify({ error: "upstream_error", message: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---- Build response ----
    const respHeaders = new Headers();
    for (const [key, value] of response.headers.entries()) {
      if (RESP_DROP.has(key.toLowerCase())) continue;
      respHeaders.set(key, value);
    }

    // CORS — allow any origin so the API is callable from browsers
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "*");
    respHeaders.set("Access-Control-Max-Age", "86400");

    // Preflight shortcut
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: respHeaders });
    }

    // Handle redirects — rewrite Location to keep traffic through the Worker
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location) {
        try {
          const locUrl = new URL(location, upstream);
          // If redirect target is one of our known hosts, rewrite it
          for (const [host, origin] of Object.entries(TARGET_MAP)) {
            if (locUrl.origin === origin) {
              locUrl.hostname = new URL(request.url).hostname;
              locUrl.port = new URL(request.url).port;
              locUrl.protocol = new URL(request.url).protocol;
              respHeaders.set("Location", locUrl.toString());
              break;
            }
          }
        } catch (_) {
          // keep original Location
        }
      }
    }

    // Stream the body through (works for SSE / chunked / binary)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  },
};

// ---- WebSocket handler ----
async function handleWebSocket(request, upstream) {
  // CF Workers WebSocket proxy
  const wsUrl = upstream.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "x-target-host") continue;
    if (key.toLowerCase() === "x-proxy-token") continue;
    upstreamHeaders.set(key, value);
  }
  const targetHost = new URL(wsUrl).host;
  upstreamHeaders.set("Host", targetHost);
  if (upstreamHeaders.has("origin")) {
    upstreamHeaders.set("Origin", "https://" + targetHost);
  }

  // Use CF fetch with WebSocket upgrade
  const upstreamRes = await fetch(wsUrl, {
    headers: upstreamHeaders,
  });

  if (upstreamRes.webSocket) {
    const [client, server] = Object.values(new WebSocketPair());

    upstreamRes.webSocket.accept();
    server.accept();

    // Upstream → Client
    upstreamRes.webSocket.addEventListener("message", (event) => {
      try { server.send(event.data); } catch (_) {}
    });
    upstreamRes.webSocket.addEventListener("close", (event) => {
      try { server.close(event.code, event.reason); } catch (_) {}
    });

    // Client → Upstream
    server.addEventListener("message", (event) => {
      try { upstreamRes.webSocket.send(event.data); } catch (_) {}
    });
    server.addEventListener("close", (event) => {
      try { upstreamRes.webSocket.close(event.code, event.reason); } catch (_) {}
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Fallback: not a WebSocket response
  return new Response("WebSocket upgrade failed", { status: 502 });
}

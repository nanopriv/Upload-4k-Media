// ============================================================
// ULTRA RELAY PRO - GAMING EDITION (ZERO-SPIKE ARCHITECTURE)
// Optimized for: Low Jitter, Anti-Fragmentation, & Instant Failover
// ============================================================

const TARGET = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

// Headers that cause lag or fingerprinting in restricted networks
const STRIP_HEADERS = new Set([
  "cf-ray", "cf-visitor", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"
]);

class GamingRacer {
  constructor() {
    this.outbounds = new Map(); 
    this.stats = new Map(); // id -> { latency, jitter, failCount }
    this.init();
  }

  init() {
    this.startAdaptiveHealthChecks();
  }

  addOutbound(url) {
    if (!url) return;
    const cleanUrl = url.replace(/\/$/, "");
    this.outbounds.set(cleanUrl, cleanUrl);
    this.stats.set(cleanUrl, { latency: 200, jitter: 0, failCount: 0 });
  }

  // Rapid-Fire health checks (Every 1 second)
  startAdaptiveHealthChecks() {
    setInterval(async () => {
      const checks = Array.from(this.outbounds.keys()).map(url => this.ping(url));
      await Promise.allSettled(checks);
    }, 1000);
  }

  async ping(url) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200); 
      
      await fetch(`${url}/health`, { method: "HEAD", signal: controller.signal, cache: "no-store" });
      clearTimeout(timeout);

      const lat = Date.now() - start;
      const s = this.stats.get(url);
      
      // Smart Latency: EMA + Jitter Penalty
      s.jitter = Math.abs(lat - s.latency) * 0.5;
      s.latency = (s.latency * 0.6) + (lat * 0.4) + (s.jitter * 0.2);
      s.failCount = 0;
    } catch (e) {
      const s = this.stats.get(url);
      s.failCount++;
      s.latency = 9999; // Move to bottom of list
    }
  }

  getBestOutbounds(count = 2) {
    return Array.from(this.stats.entries())
      .filter(([_, s]) => s.failCount < 2)
      .sort((a, b) => a[1].latency - b[1].latency)
      .slice(0, count)
      .map(entry => entry[0]);
  }

  // THE MAGIC: Hedged Request Strategy
  async smartRace(path, options) {
    const best = this.getBestOutbounds(2);
    if (best.length === 0) throw new Error("No healthy outbounds");

    const controller = new AbortController();
    const { signal } = controller;

    // Function to perform a single fetch
    const attempt = async (baseUrl) => {
      const res = await fetch(baseUrl + path, { ...options, signal });
      if (!res.ok && res.status >= 500) throw new Error("Server Error");
      return res;
    };

    // Primary Request
    const p1 = attempt(best[0]);

    // If P1 is slow (over 150ms), fire P2 immediately!
    const hedgeTimeout = new Promise((resolve) => setTimeout(() => resolve("HEDGE"), 150));

    const firstResult = await Promise.race([p1, hedgeTimeout]);

    if (firstResult === "HEDGE" && best.length > 1) {
      // P1 is lagging, fire P2 and return whoever finishes first
      const p2 = attempt(best[1]);
      const finalWinner = await Promise.any([p1, p2]);
      controller.abort(); // Kill the loser
      return finalWinner;
    }

    return firstResult;
  }
}

const racer = new GamingRacer();
racer.addOutbound(TARGET);
(Netlify.env.get("FALLBACK_DOMAINS") || "").split(",").forEach(d => racer.addOutbound(d.trim()));

export default async function handler(event) {
  if (event.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const url = new URL(event.url);
    const path = url.pathname + url.search;

    // Optimized headers for gaming packets
    const forwardHeaders = new Headers();
    event.headers.forEach((v, k) => {
      if (!STRIP_HEADERS.has(k.toLowerCase())) forwardHeaders.set(k, v);
    });
    forwardHeaders.set("Connection", "keep-alive");

    const response = await racer.smartRace(path, {
      method: event.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(event.method) ? undefined : event.body,
      // Critical for V2Ray/Gaming:
      redirect: "manual",
      keepalive: true 
    });

    const responseHeaders = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    
    // Force No-Cache for gaming data to prevent "stuck" states
    responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response("Gateway Timeout", { status: 504 });
  }
}

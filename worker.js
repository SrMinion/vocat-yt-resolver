// src/index.ts
var json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...init.headers || {} } });
var body = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};
var resolverBase = (env) => (env.YTDLP_URL || "").replace(/\/$/, "");
async function resolverFetch(env, path, init = {}) {
  if (!env.YTDLP_URL || !env.YTDLP_TOKEN) return new Response(JSON.stringify({ ok: false, error: "resolver_not_configured" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.YTDLP_TOKEN}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55e3);
  try {
    return await fetch(`${resolverBase(env)}${path}`, { ...init, headers, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "resolver_timeout" : "resolver_unreachable";
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 504, headers: { "content-type": "application/json; charset=utf-8" } });
  } finally {
    clearTimeout(timer);
  }
}
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" } });
    if (url.pathname === "/") return json({ ok: true, service: "ESP-VoCat Music API", autonomous: true, xiaozhi: true, endpoints: ["/health", "/api/v1/catalog", "/api/v1/search?q=rock", "/api/v1/stations", "/api/youtube/debug?id=VIDEO", "/api/youtube/tool?q=termo", "/api/youtube/stream?id=VIDEO"] });
    if (url.pathname === "/health") return json({ ok: true, app: env.APP_NAME, autonomous: true, resolver_configured: Boolean(env.YTDLP_URL && env.YTDLP_TOKEN) });
    if (url.pathname === "/api/youtube/debug") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json({ ok: false, error: "bad_id" }, { status: 400 });
      const health = await fetch(`${resolverBase(env)}/health`).then(async (response) => ({ ok: response.ok, status: response.status, body: await response.text() })).catch(() => ({ ok: false, status: 0, body: "unreachable" }));
      const resolved = await resolverFetch(env, `/resolve?id=${encodeURIComponent(id)}`);
      const resolvedBody = await resolved.text();
      return json({ ok: resolved.ok, trace: { resolver_health: health, resolver_resolve: { status: resolved.status, body: resolvedBody.slice(0, 500) } } }, { status: resolved.ok ? 200 : 502 });
    }
    if (url.pathname === "/api/youtube/tool") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2 || q.length > 160) return json({ items: [], error: "bad_query" }, { status: 400 });
      const response = await resolverFetch(env, `/search?q=${encodeURIComponent(q)}`);
      const data = await response.json().catch(() => ({ ok: false, error: "invalid_resolver_response" }));
      const items = (data.items || []).map((item) => ({ ...item, source: "youtube", stream_url: `${url.origin}/api/youtube/stream?id=${encodeURIComponent(String(item.id || ""))}`, mime_type: "audio/aac" }));
      return json({ ok: response.ok, query: q, items, ...response.ok ? {} : { error: data.error || "resolver_error" } }, { status: response.ok ? 200 : 502 });
    }
    if (url.pathname === "/api/youtube/stream") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json({ ok: false, error: "bad_id" }, { status: 400 });
      const response = await resolverFetch(env, `/yt/${encodeURIComponent(id)}.aac`);
      if (!response.ok) return new Response(await response.text(), { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
      const headers = new Headers({ "content-type": response.headers.get("content-type") || "audio/aac", "cache-control": "no-store", "access-control-allow-origin": "*" });
      return new Response(response.body, { status: 200, headers });
    }
    if (url.pathname === "/api/v1/device/register" && request.method === "POST") {
      const input = await body(request);
      if (!input.device_id || !input.mac) return json({ error: "device_id_and_mac_required" }, { status: 400 });
      await env.DB.prepare(`INSERT INTO devices (device_id, mac, board, firmware, xiaozhi_transport, last_seen)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(device_id) DO UPDATE SET mac=excluded.mac, board=excluded.board, firmware=excluded.firmware, xiaozhi_transport=excluded.xiaozhi_transport, last_seen=CURRENT_TIMESTAMP`).bind(input.device_id, input.mac, input.board || "esp-vocat", input.firmware || null, input.xiaozhi_transport || null).run();
      return json({ ok: true, device_id: input.device_id, music_api: "/api/v1/catalog", xiaozhi: true });
    }
    if (url.pathname === "/api/v1/device/heartbeat" && request.method === "POST") {
      const input = await body(request);
      if (!input.device_id) return json({ error: "device_id_required" }, { status: 400 });
      const result = await env.DB.prepare("UPDATE devices SET last_seen=CURRENT_TIMESTAMP WHERE device_id=? AND enabled=1").bind(input.device_id).run();
      return json({ ok: Boolean(result.meta.changes), device_id: input.device_id });
    }
    if (url.pathname === "/api/v1/catalog") {
      const limit = Math.min(Number(url.searchParams.get("limit") || "25"), 50);
      const rows = await env.DB.prepare("SELECT * FROM tracks WHERE searchable=1 ORDER BY artist, title LIMIT ?").bind(limit).all();
      return json({ items: rows.results || [] });
    }
    if (url.pathname === "/api/v1/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ items: [] });
      const like = `%${q}%`;
      const rows = await env.DB.prepare("SELECT * FROM tracks WHERE searchable=1 AND (title LIKE ? OR artist LIKE ? OR album LIKE ?) ORDER BY artist, title LIMIT 30").bind(like, like, like).all();
      return json({ query: q, items: rows.results || [] });
    }
    if (url.pathname === "/api/v1/stations") {
      const tag = (url.searchParams.get("tag") || "").trim();
      const rows = tag ? await env.DB.prepare("SELECT * FROM stations WHERE tags LIKE ? ORDER BY name LIMIT 50").bind(`%${tag}%`).all() : await env.DB.prepare("SELECT * FROM stations ORDER BY name LIMIT 50").all();
      return json({ items: rows.results || [] });
    }
    return json({ error: "not_found" }, { status: 404 });
  }
};
export {
  index_default as default
};

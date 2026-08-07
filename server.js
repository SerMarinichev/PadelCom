// PadelCom server — plain Node.js, no external dependencies.
// Data is proxied to an external persistent store (jsonblob.com) because Render's
// free-tier filesystem is wiped on every redeploy/restart/spin-down — a local
// data.json file would lose everything each time.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const BLOB_URL = process.env.BLOB_URL || "https://jsonblob.com/api/jsonBlob/019fcc36-1926-7e53-8cbd-206f16f5e16d";

// ---- admin auth config ----
// Set these on Render (Settings -> Environment), never commit real values to GitHub.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || "padelcom-dev-secret";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = "padelcom_admin";

function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}
function makeSessionToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${body}.${sign(body)}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  const expected = sign(body);
  const a = Buffer.from(sig || "", "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function isAdminRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}
async function loadBlob() {
  const r = await fetch(BLOB_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}
async function saveBlob(data) {
  const r = await fetch(BLOB_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return data;
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
// Generic handler for "one admin entity by id" routes (PUT to edit, DELETE to remove).
// Returns true if it handled the request (matched prefix + method), false otherwise.
async function handleAdminEntityRoute(req, res, url, prefix, arrayKey, extraOnDelete) {
  if (!url.startsWith(prefix) || (req.method !== "PUT" && req.method !== "DELETE")) return false;
  if (!isAdminRequest(req)) {
    send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" });
    return true;
  }
  const id = url.slice(prefix.length);
  try {
    const data = await loadBlob();
    const arr = data[arrayKey] || [];
    if (req.method === "DELETE") {
      data[arrayKey] = arr.filter((x) => x.id !== id);
      if (extraOnDelete) extraOnDelete(data, id);
    } else {
      const patch = await readJsonBody(req);
      data[arrayKey] = arr.map((x) => (x.id === id ? { ...x, ...patch, id } : x));
    }
    await saveBlob(data);
    send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
  } catch (e) {
    send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
  }
  return true;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // ---- YouTube oEmbed proxy (official public endpoint, no API key needed) ----
  if (req.url.split("?")[0] === "/api/oembed" && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const target = parsed.searchParams.get("url") || "";
    try {
      if (!/youtube\.com|youtu\.be/i.test(target)) throw new Error("unsupported platform");
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`);
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const json = await r.json();
      send(res, 200, JSON.stringify({ title: json.title, thumbnail: json.thumbnail_url }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 404, JSON.stringify({ error: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  // ---- admin auth ----
  if (url === "/api/admin/login" && req.method === "POST") {
    try {
      const { password } = await readJsonBody(req);
      if (!ADMIN_PASSWORD) {
        send(res, 500, JSON.stringify({ error: "ADMIN_PASSWORD is not configured on the server" }), { "Content-Type": "application/json" });
        return;
      }
      if (password !== ADMIN_PASSWORD) {
        send(res, 401, JSON.stringify({ error: "wrong password" }), { "Content-Type": "application/json" });
        return;
      }
      const token = makeSessionToken();
      send(res, 200, JSON.stringify({ ok: true }), {
        "Content-Type": "application/json",
        "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`,
      });
    } catch {
      send(res, 400, JSON.stringify({ error: "bad request" }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url === "/api/admin/logout" && req.method === "POST") {
    send(res, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    });
    return;
  }

  if (url === "/api/admin/session" && req.method === "GET") {
    send(res, 200, JSON.stringify({ authenticated: isAdminRequest(req) }), { "Content-Type": "application/json" });
    return;
  }

  // ---- protected admin mutations: server verifies the session itself, the
  // client cannot bypass this by editing the page or crafting its own request ----
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/players/", "players", (data, id) => {
    data.pairs = (data.pairs || []).filter((pr) => pr.primaryId !== id && pr.secondaryId !== id);
    (data.sessions || []).forEach((s) => {
      s.expenses = (s.expenses || []).map((e) => ({ ...e, splitAmong: (e.splitAmong || []).filter((x) => x !== id && x !== `pair:${id}`) }));
    });
  })) return;

  if (url === "/api/admin/venues" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const venue = { id: crypto.randomUUID(), name: body.name || "", type: body.type || "" };
      data.places = [...(data.places || []), venue];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, venue }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (await handleAdminEntityRoute(req, res, url, "/api/admin/venues/", "places")) return;
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/sessions/", "sessions")) return;
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/tournaments/", "tournaments")) return;
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/polls/", "polls")) return;
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/closed-transfers/", "closedTransfers")) return;

  if (url === "/api/admin/match-records" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const record = {
        id: crypto.randomUUID(), date: body.date || "", matchType: body.matchType || "double",
        sessionId: body.sessionId || null, participant1: body.participant1 || [], participant2: body.participant2 || [],
        score1: Number(body.score1) || 0, score2: Number(body.score2) || 0,
      };
      data.matchRecords = [record, ...(data.matchRecords || [])];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, record }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/match-records/", "matchRecords")) return;

  // ---- protected admin mutations: articles (WikiPadel) ----
  if (url === "/api/admin/articles" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const article = { id: crypto.randomUUID(), title: body.title || "", body: body.body || "", cover: body.cover || "", createdAt: new Date().toISOString().slice(0, 10) };
      data.articles = [article, ...(data.articles || [])];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, article }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url.startsWith("/api/admin/articles/") && req.method === "PUT") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    const id = url.split("/").pop();
    try {
      const patch = await readJsonBody(req);
      const data = await loadBlob();
      data.articles = (data.articles || []).map((a) => (a.id === id ? { ...a, ...patch, id } : a));
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url.startsWith("/api/admin/articles/") && req.method === "DELETE") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    const id = url.split("/").pop();
    try {
      const data = await loadBlob();
      data.articles = (data.articles || []).filter((a) => a.id !== id);
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  // ---- protected admin mutations: videos (WikiPadel) ----
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/videos/", "videos")) return;

  // ---- protected admin mutations: simple reference lists (типы объектов/событий и т.п.) ----
  // Whitelisted keys only — this endpoint replaces the whole list at once, which keeps it
  // simple and lets new list-type reference data reuse it later without new server code.
  const LIST_KEYS = ["placeTypes", "eventTypes"];
  if (url.startsWith("/api/admin/lists/") && req.method === "PUT") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    const key = url.slice("/api/admin/lists/".length);
    if (!LIST_KEYS.includes(key)) { send(res, 404, JSON.stringify({ error: "unknown list" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.items)) throw new Error("items must be an array");
      const data = await loadBlob();
      data[key] = body.items;
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  // ---- protected admin mutations: settings (currency etc.) ----
  if (url === "/api/admin/settings" && req.method === "PUT") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const patch = await readJsonBody(req);
      const data = await loadBlob();
      if (patch.currency) data.currency = patch.currency;
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  // ---- storage API (proxied to the external persistent store) ----
  if (url === "/api/data" && req.method === "GET") {
    try {
      const r = await fetch(BLOB_URL, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const text = await r.text();
      send(res, 200, text, { "Content-Type": "application/json" });
    } catch (e) {
      // Do NOT fail soft with "{}" here — that would look like "no data yet" to the
      // client and get saved back, permanently wiping real data on a transient outage.
      send(res, 502, JSON.stringify({ error: "storage load failed", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url === "/api/data" && (req.method === "PUT" || req.method === "POST")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        JSON.parse(body); // validate
        const r = await fetch(BLOB_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body,
        });
        if (!r.ok) throw new Error(`upstream ${r.status}`);
        send(res, 200, body, { "Content-Type": "application/json" });
      } catch (e) {
        send(res, 502, JSON.stringify({ error: "storage save failed", detail: String(e) }), { "Content-Type": "application/json" });
      }
    });
    return;
  }

  // ---- static files ----
  let filePath = path.join(PUBLIC_DIR, url === "/" ? "index.html" : (url === "/admin" ? "admin.html" : url));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, "Forbidden");
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, indexContent) => {
        if (err2) return send(res, 404, "Not found");
        send(res, 200, indexContent, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache, no-store, must-revalidate" });
      });
      return;
    }
    const ext = path.extname(filePath);
    const isManifest = url === "/manifest.json";
    const contentType = isManifest ? "application/manifest+json; charset=utf-8" : (MIME[ext] || "application/octet-stream");
    // no-cache on html/js so a new deploy is always picked up immediately, never stuck on an old cached bundle.
    // Icons rarely change, so they can cache longer.
    const cacheControl = ext === ".html" || ext === ".js" ? "no-cache, no-store, must-revalidate" : "public, max-age=86400";
    send(res, 200, content, { "Content-Type": contentType, "Cache-Control": cacheControl });
  });
});

server.listen(PORT, () => console.log(`PadelCom running on port ${PORT}`));

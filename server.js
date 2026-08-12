// PadelCom server — plain Node.js, no external dependencies.
// Data is persisted to a private GitHub repository (via the Contents API) because
// Render's free-tier filesystem is wiped on every redeploy/restart/spin-down — a
// local data.json file would lose everything each time. GitHub was chosen after
// jsonblob.com (the original store) started silently blocking/losing data —
// GitHub gives us a generous, well-documented API and a free version history
// of every save as a bonus (each save is a commit).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- admin auth config ----
// Set these on Render (Settings -> Environment), never commit real values to GitHub.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || "padelcom-dev-secret";

// ---- Telegram bot (optional: only active if TELEGRAM_BOT_TOKEN is set) ----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;
// Verifies incoming webhook calls really come from Telegram (via the secret_token header
// Telegram echoes back on every request once configured via setWebhook).
const TELEGRAM_WEBHOOK_SECRET = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN || "none").digest("hex").slice(0, 32);
async function telegramCall(method, body) {
  if (!TELEGRAM_API) throw new Error("TELEGRAM_BOT_TOKEN не настроен на сервере");
  const r = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}
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
// ---- GitHub-backed storage ----
// GITHUB_REPO must be "owner/repo" (a private repo dedicated to data, separate
// from the app's own code repo). GITHUB_TOKEN is a fine-grained PAT scoped to
// that repo only, with Contents: Read & write.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || "data.json";
const GITHUB_API = process.env.GITHUB_API_BASE || "https://api.github.com";

function githubConfigured() {
  return !!(GITHUB_TOKEN && GITHUB_REPO);
}

async function githubRequest(method, apiPath, body) {
  const r = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "PadelCom-App",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function loadBlob() {
  if (!githubConfigured()) throw new Error("GITHUB_TOKEN / GITHUB_REPO не настроены");
  const r = await githubRequest("GET", `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`);
  if (r.status === 404) return {}; // no data file yet — first run
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`github ${r.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const json = await r.json();
  const content = Buffer.from(json.content, "base64").toString("utf8");
  return content ? JSON.parse(content) : {};
}

async function saveBlob(data) {
  if (!githubConfigured()) throw new Error("GITHUB_TOKEN / GITHUB_REPO не настроены");
  // GitHub requires the current file's sha to update it (prevents silently clobbering
  // a concurrent write) — fetch it fresh every time rather than caching in memory.
  let sha;
  const getR = await githubRequest("GET", `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`);
  if (getR.ok) {
    sha = (await getR.json()).sha;
  } else if (getR.status !== 404) {
    const body = await getR.text().catch(() => "");
    throw new Error(`github ${getR.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const payload = JSON.stringify(data, null, 2);
  const content = Buffer.from(payload, "utf8").toString("base64");
  const putR = await githubRequest("PUT", `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`, {
    message: `data update — ${new Date().toISOString()}`,
    content,
    ...(sha ? { sha } : {}),
  });
  if (!putR.ok) {
    const body = await putR.text().catch(() => "");
    throw new Error(`github ${putR.status} (payload ${(payload.length / 1024).toFixed(0)}KB)${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
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

  if (url === "/api/admin/pairs" && req.method === "PUT") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.pairs)) throw new Error("pairs must be an array");
      const data = await loadBlob();
      data.pairs = body.pairs;
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (await handleAdminEntityRoute(req, res, url, "/api/admin/venues/", "places")) return;
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/sessions/", "sessions")) return;
  if (url === "/api/admin/tournaments" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const tournament = {
        id: crypto.randomUUID(), name: body.name || "", date: body.date || "",
        matchType: body.matchType || "single", gender: body.gender || "male",
        format: body.format || "round_robin", ageCategory: body.ageCategory || "",
        levelMin: body.levelMin || "", levelMax: body.levelMax || "",
        maxParticipants: body.maxParticipants || null,
        participants: body.participants || [], matches: [],
        stages: body.format === "mixed"
          ? [
              { id: "qualifying", name: "Отборочный этап", participantIds: [...(body.participants || [])], matches: [] },
              { id: "main", name: "Основной турнир", participantIds: [], matches: [] },
              { id: "consolation", name: "Турнир для выбывших", participantIds: [], matches: [] },
            ]
          : null,
      };
      data.tournaments = [tournament, ...(data.tournaments || [])];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, tournament }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/tournaments/", "tournaments")) return;
  if (url === "/api/admin/polls" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const poll = {
        id: crypto.randomUUID(), question: body.question || "",
        options: (body.options || []).map((text) => ({ id: crypto.randomUUID(), text })),
        votes: {}, closed: false,
      };
      data.polls = [poll, ...(data.polls || [])];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, poll }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }
  if (await handleAdminEntityRoute(req, res, url, "/api/admin/polls/", "polls")) return;
  if (url === "/api/admin/closed-transfers" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const body = await readJsonBody(req);
      const data = await loadBlob();
      const record = { id: crypto.randomUUID(), from: body.from, to: body.to, amount: Number(body.amount) || 0, date: new Date().toISOString().slice(0, 10) };
      data.closedTransfers = [...(data.closedTransfers || []), record];
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true, record }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: "storage error", detail: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }
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

  // ---- Telegram bot integration ----
  if (url === "/api/admin/telegram/status" && req.method === "GET") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const data = await loadBlob();
      const info = TELEGRAM_API ? await telegramCall("getWebhookInfo").catch(() => null) : null;
      send(res, 200, JSON.stringify({
        configured: !!TELEGRAM_API,
        webhookUrl: info ? info.url : "",
        chats: data.telegramChats || [],
        selectedChatId: data.telegramChatId || "",
      }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url === "/api/admin/telegram/setup-webhook" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const { baseUrl } = await readJsonBody(req);
      if (!baseUrl) throw new Error("baseUrl обязателен");
      await telegramCall("setWebhook", {
        url: `${baseUrl.replace(/\/$/, "")}/api/telegram/webhook`,
        secret_token: TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "poll_answer"],
      });
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: String(e.message || e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url === "/api/admin/telegram/select-chat" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const { chatId } = await readJsonBody(req);
      const data = await loadBlob();
      data.telegramChatId = chatId;
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: String(e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  if (url === "/api/admin/telegram/send-poll" && req.method === "POST") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const { pollId } = await readJsonBody(req);
      const data = await loadBlob();
      if (!data.telegramChatId) throw new Error("Сначала выберите чат для публикации");
      const poll = (data.polls || []).find((p) => p.id === pollId);
      if (!poll) throw new Error("Голосование не найдено");
      const result = await telegramCall("sendPoll", {
        chat_id: data.telegramChatId,
        question: poll.question,
        options: poll.options.map((o) => o.text),
        is_anonymous: false,
      });
      poll.telegram = { chatId: data.telegramChatId, messageId: result.message_id, pollId: result.poll.id };
      await saveBlob(data);
      send(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json" });
    } catch (e) {
      send(res, 502, JSON.stringify({ error: String(e.message || e) }), { "Content-Type": "application/json" });
    }
    return;
  }

  // Public endpoint — Telegram calls this. Protected by the secret_token header instead
  // of our usual session auth, since Telegram itself (not a logged-in admin) is the caller.
  if (url === "/api/telegram/webhook" && req.method === "POST") {
    if (req.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET) {
      send(res, 401, "not telegram", { "Content-Type": "text/plain" });
      return;
    }
    try {
      const update = await readJsonBody(req);
      const data = await loadBlob();
      let changed = false;

      // Remember any chat the bot has seen a message in, so the admin can pick it from
      // a list instead of hunting down a numeric chat id by hand.
      if (update.message && update.message.chat) {
        const chat = update.message.chat;
        data.telegramChats = data.telegramChats || [];
        const existing = data.telegramChats.find((c) => String(c.id) === String(chat.id));
        const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id);
        if (existing) existing.title = title;
        else data.telegramChats.push({ id: chat.id, title });
        changed = true;
      }

      // A poll answer: match it back to a PadelCom poll + player by Telegram @username.
      if (update.poll_answer) {
        const pa = update.poll_answer;
        const poll = (data.polls || []).find((p) => p.telegram && p.telegram.pollId === pa.poll_id);
        const username = pa.user && pa.user.username;
        if (poll && username) {
          const player = (data.players || []).find((pl) => pl.telegram && pl.telegram.replace(/^@/, "").toLowerCase() === username.toLowerCase());
          if (player) {
            poll.votes = poll.votes || {};
            if (pa.option_ids && pa.option_ids.length > 0) {
              const opt = poll.options[pa.option_ids[0]];
              if (opt) poll.votes[player.id] = opt.id;
            } else {
              delete poll.votes[player.id];
            }
            changed = true;
          }
        }
      }

      if (changed) await saveBlob(data);
      send(res, 200, "OK", { "Content-Type": "text/plain" });
    } catch (e) {
      send(res, 200, "OK", { "Content-Type": "text/plain" }); // always 200 so Telegram doesn't retry-storm
    }
    return;
  }

  // ---- storage API (proxied to the external persistent store) ----
  if (url === "/api/data" && req.method === "GET") {
    try {
      const data = await loadBlob();
      send(res, 200, JSON.stringify(data), { "Content-Type": "application/json" });
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
        const data = JSON.parse(body); // validate
        await saveBlob(data);
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

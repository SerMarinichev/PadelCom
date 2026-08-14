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
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}` : null;
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

// ---- /match conversational flow (Telegram bot) ----
// Mirrors the exact same participant-narrowing logic already used in the app's
// match form: only players who are actually part of TODAY's event are offered,
// and each pick removes that player from the remaining button choices.
function resolveParticipantsServer(splitAmong, pairs) {
  const set = new Set();
  (splitAmong || []).forEach((token) => {
    if (typeof token === "string" && token.startsWith("pair:")) {
      const primaryId = token.slice(5);
      const pr = (pairs || []).find((x) => x.primaryId === primaryId);
      if (pr) { set.add(pr.primaryId); set.add(pr.secondaryId); } else set.add(primaryId);
    } else {
      set.add(token);
    }
  });
  return [...set];
}
function sessionParticipantIdsServer(s, pairs) {
  const set = new Set();
  (s.expenses || []).forEach((e) => resolveParticipantsServer(e.splitAmong, pairs).forEach((id) => set.add(id)));
  return [...set];
}
function playerName(p) { return [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Без имени"; }
function todayISOServer() { return new Date().toISOString().slice(0, 10); }

const MATCH_FLOW_STEPS = ["type", "p1a", "p1b", "p2a", "p2b", "score"];
function flowKey(chatId, userId) { return `${chatId}:${userId}`; }

async function startMatchFlow(data, chatId, userId) {
  const today = todayISOServer();
  const sessions = (data.sessions || []).filter((s) => s.date === today);
  console.log(`[startMatchFlow] today=${today} sessionsFound=${sessions.length} totalSessionsInData=${(data.sessions || []).length}`);
  if (sessions.length === 0) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "На сегодня не нашёл событие в PadelCom — сначала создайте его в приложении." });
    return `no session for ${today} (${(data.sessions || []).length} total sessions in data)`;
  }
  // If more than one event today, just use the first — keeps the flow simple;
  // rare edge case for a padel group with more than one session per day.
  const session = sessions[0];
  const participantIds = sessionParticipantIdsServer(session, data.pairs || []);
  if (participantIds.length < 2) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `В событии «${session.type || "Падел"}» пока отмечено меньше 2 участников — добавьте их в приложении, затем повторите /матч.` });
    return `session found but only ${participantIds.length} participants`;
  }
  const flow = { step: "type", sessionId: session.id, matchType: null, p1: [], p2: [], participantIds };
  data.telegramFlows = data.telegramFlows || {};
  data.telegramFlows[flowKey(chatId, userId)] = flow;
  const msg = await telegramCall("sendMessage", {
    chat_id: chatId, text: "Записываю матч 🏓\nОдиночный или парный?",
    reply_markup: { inline_keyboard: [[{ text: "Одиночный", callback_data: "mf:type:single" }, { text: "Парный", callback_data: "mf:type:double" }]] },
  });
  flow.messageId = msg.message_id;
  return `ok — sent buttons message_id=${msg.message_id}`;
}

function playerButtons(data, ids, prefix) {
  const players = ids.map((id) => (data.players || []).find((p) => p.id === id)).filter(Boolean);
  const rows = [];
  for (let i = 0; i < players.length; i += 2) {
    rows.push(players.slice(i, i + 2).map((p) => ({ text: playerName(p), callback_data: `mf:${prefix}:${p.id}` })));
  }
  return rows;
}

async function advanceMatchFlow(data, chatId, userId, action) {
  const key = flowKey(chatId, userId);
  const flow = (data.telegramFlows || {})[key];
  if (!flow) return;
  const remaining = () => flow.participantIds.filter((id) => !flow.p1.includes(id) && !flow.p2.includes(id));
  const editText = async (text, keyboard) => {
    await telegramCall("editMessageText", { chat_id: chatId, message_id: flow.messageId, text, reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined }).catch(() => {});
  };

  if (action.startsWith("type:")) {
    flow.matchType = action.slice(5);
    flow.step = "p1a";
    await editText(`Участник 1${flow.matchType === "double" ? " — игрок 1" : ""}:`, playerButtons(data, remaining(), "p1a"));
    return;
  }
  if (action.startsWith("p1a:")) {
    flow.p1 = [action.slice(4)];
    if (flow.matchType === "double") {
      flow.step = "p1b";
      await editText("Участник 1 — игрок 2:", playerButtons(data, remaining(), "p1b"));
    } else {
      flow.step = "p2a";
      await editText("Участник 2:", playerButtons(data, remaining(), "p2a"));
    }
    return;
  }
  if (action.startsWith("p1b:")) {
    flow.p1.push(action.slice(4));
    flow.step = "p2a";
    await editText("Участник 2 — игрок 1:", playerButtons(data, remaining(), "p2a"));
    return;
  }
  if (action.startsWith("p2a:")) {
    flow.p2 = [action.slice(4)];
    if (flow.matchType === "double") {
      flow.step = "p2b";
      await editText("Участник 2 — игрок 2:", playerButtons(data, remaining(), "p2b"));
    } else {
      flow.step = "score";
      await editText(`${flow.p1.map((id) => playerName((data.players || []).find((p) => p.id === id) || {})).join(" / ")} vs ${flow.p2.map((id) => playerName((data.players || []).find((p) => p.id === id) || {})).join(" / ")}\n\nПришлите счёт в формате 6:3`);
    }
    return;
  }
  if (action.startsWith("p2b:")) {
    flow.p2.push(action.slice(4));
    flow.step = "score";
    const nm = (id) => playerName((data.players || []).find((p) => p.id === id) || {});
    await editText(`${flow.p1.map(nm).join(" / ")} vs ${flow.p2.map(nm).join(" / ")}\n\nПришлите счёт в формате 6:3`);
    return;
  }
}

async function finishMatchFlow(data, chatId, userId, text) {
  const key = flowKey(chatId, userId);
  const flow = (data.telegramFlows || {})[key];
  if (!flow || flow.step !== "score") return false;
  const m = text.trim().match(/^(\d+)\s*[:\-–]\s*(\d+)$/);
  if (!m) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "Не понял счёт — пришлите в формате 6:3" }).catch(() => {});
    return true;
  }
  const nameOf = (id) => playerName((data.players || []).find((p) => p.id === id) || {});
  data.matchRecords = data.matchRecords || [];
  data.matchRecords.push({
    id: crypto.randomUUID().slice(0, 8), date: todayISOServer(), matchType: flow.matchType, sessionId: flow.sessionId,
    participant1: flow.p1, participant2: flow.p2, score1: parseInt(m[1], 10), score2: parseInt(m[2], 10),
  });
  delete data.telegramFlows[key];
  await telegramCall("sendMessage", { chat_id: chatId, text: `Записал ✓\n${flow.p1.map(nameOf).join(" / ")} ${m[1]} : ${m[2]} ${flow.p2.map(nameOf).join(" / ")}` }).catch(() => {});
  return true;
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
  if (url === "/api/admin/storage/status" && req.method === "GET") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    const result = { configured: githubConfigured(), repo: GITHUB_REPO, path: GITHUB_DATA_PATH, connected: false, fileExists: false, error: "" };
    if (githubConfigured()) {
      try {
        const r = await githubRequest("GET", `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`);
        if (r.ok) { result.connected = true; result.fileExists = true; }
        else if (r.status === 404) { result.connected = true; result.fileExists = false; }
        else { const body = await r.text().catch(() => ""); result.error = `${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`; }
      } catch (e) {
        result.error = String(e);
      }
    }
    send(res, 200, JSON.stringify(result), { "Content-Type": "application/json" });
    return;
  }

  if (url === "/api/admin/telegram/status" && req.method === "GET") {
    if (!isAdminRequest(req)) { send(res, 401, JSON.stringify({ error: "not authenticated" }), { "Content-Type": "application/json" }); return; }
    try {
      const data = await loadBlob();
      let info = null;
      let apiError = "";
      if (TELEGRAM_API) {
        try { info = await telegramCall("getWebhookInfo"); }
        catch (e) { apiError = String(e.message || e); }
      }
      send(res, 200, JSON.stringify({
        configured: !!TELEGRAM_API,
        tokenPreview: TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.slice(0, 6)}… (${TELEGRAM_BOT_TOKEN.length} символов)` : "не задан",
        apiError,
        webhookUrl: info ? info.url : "",
        pendingUpdates: info ? info.pending_update_count : null,
        lastDeliveryError: info ? info.last_error_message : "",
        lastDeliveryErrorAt: info && info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : "",
        lastEvent: data.telegramLastEvent || null,
        matchDebug: data.telegramMatchDebug || null,
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
        allowed_updates: ["message", "poll_answer", "callback_query"],
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
    console.log(`[telegram webhook] incoming request at ${new Date().toISOString()}`);
    if (req.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET) {
      console.log(`[telegram webhook] REJECTED — secret token mismatch (got: ${JSON.stringify(req.headers["x-telegram-bot-api-secret-token"])})`);
      send(res, 401, "not telegram", { "Content-Type": "text/plain" });
      return;
    }
    try {
      const update = await readJsonBody(req);
      console.log(`[telegram webhook] accepted — update type: ${Object.keys(update).find((k) => k !== "update_id")}`);
      const data = await loadBlob();
      let changed = false;

      // Diagnostic breadcrumb: record that *something* reached us, regardless of type,
      // so the admin panel can show "last event received at ..." — this is the fastest
      // way to tell a Telegram-side problem (privacy mode, webhook not registered) apart
      // from a server-side one (chat/poll matching, storage save failing). Kept here
      // (not just in Render's own logs) because that log viewer has repeatedly proven
      // awkward to read live — the admin panel is a more reliable channel for this.
      data.telegramLastEvent = { type: Object.keys(update).find((k) => k !== "update_id") || "unknown", at: new Date().toISOString() };
      changed = true;

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

      // /матч (or /match) command: starts the step-by-step "add a match" bot flow.
      if (update.message && typeof update.message.text === "string") {
        const text = update.message.text.trim();
        const chatId = update.message.chat.id;
        const userId = update.message.from.id;
        const isMatchCmd = /^\/(матч|match)(@\w+)?/i.test(text);
        data.telegramMatchDebug = { text, isMatchCmd, at: new Date().toISOString(), result: "" };
        console.log(`[telegram webhook] message text=${JSON.stringify(text)} isMatchCommand=${isMatchCmd} hasActiveFlow=${!!(data.telegramFlows || {})[flowKey(chatId, userId)]}`);
        if (isMatchCmd) {
          try {
            data.telegramMatchDebug.result = await startMatchFlow(data, chatId, userId);
          } catch (flowErr) {
            data.telegramMatchDebug.result = `error: ${String(flowErr.message || flowErr)}`;
          }
          changed = true;
        } else if ((data.telegramFlows || {})[flowKey(chatId, userId)]) {
          const handled = await finishMatchFlow(data, chatId, userId, text);
          if (handled) changed = true;
        }
      }

      // Inline keyboard button taps for the /матч flow.
      if (update.callback_query && typeof update.callback_query.data === "string" && update.callback_query.data.startsWith("mf:")) {
        const cq = update.callback_query;
        const chatId = cq.message.chat.id;
        const userId = cq.from.id;
        await telegramCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
        await advanceMatchFlow(data, chatId, userId, cq.data.slice(3));
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
      console.error("telegram webhook error:", e);
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
        const incoming = JSON.parse(body); // validate
        // Telegram-related fields are written exclusively by the webhook, out-of-band
        // from any client. A browser tab's in-memory copy can be stale by the time it
        // saves, and because every save overwrites the whole blob, a stale save would
        // silently erase chats/events the webhook discovered in the meantime. Always
        // keep the server's current values here regardless of what the client sent —
        // no client (app or admin restore-from-backup) legitimately needs to change them.
        try {
          const current = await loadBlob();
          incoming.telegramChats = current.telegramChats || [];
          incoming.telegramChatId = current.telegramChatId || incoming.telegramChatId || "";
          incoming.telegramLastEvent = current.telegramLastEvent || null;
          // Same staleness risk applies to votes a Telegram poll_answer added in the
          // background: merge any vote the current server copy has that the incoming
          // (possibly stale) copy is missing, per poll, rather than dropping it.
          const currentPolls = current.polls || [];
          incoming.polls = (incoming.polls || []).map((p) => {
            const curPoll = currentPolls.find((cp) => cp.id === p.id);
            if (curPoll && curPoll.votes) {
              return { ...p, votes: { ...curPoll.votes, ...(p.votes || {}) } };
            }
            return p;
          });
        } catch { /* if the current copy can't be read, fall through and save as-is */ }
        await saveBlob(incoming);
        send(res, 200, JSON.stringify(incoming), { "Content-Type": "application/json" });
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

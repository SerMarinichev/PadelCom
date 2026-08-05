// PadelCom server — plain Node.js, no external dependencies.
// Data is proxied to an external persistent store (jsonblob.com) because Render's
// free-tier filesystem is wiped on every redeploy/restart/spin-down — a local
// data.json file would lose everything each time.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const BLOB_URL = process.env.BLOB_URL || "https://jsonblob.com/api/jsonBlob/019fcc36-1926-7e53-8cbd-206f16f5e16d";

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
  let filePath = path.join(PUBLIC_DIR, url === "/" ? "index.html" : url);
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

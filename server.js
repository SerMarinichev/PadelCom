// PadelCom server — plain Node.js, no external dependencies (nothing to npm install).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data.json");

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "{}");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // ---- storage API ----
  if (url === "/api/data" && req.method === "GET") {
    fs.readFile(DATA_FILE, "utf8", (err, content) => {
      if (err) return send(res, 500, JSON.stringify({ error: "read failed" }), { "Content-Type": "application/json" });
      send(res, 200, content, { "Content-Type": "application/json" });
    });
    return;
  }

  if (url === "/api/data" && (req.method === "PUT" || req.method === "POST")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        JSON.parse(body); // validate
        fs.writeFile(DATA_FILE, body, (err) => {
          if (err) return send(res, 500, JSON.stringify({ error: "write failed" }), { "Content-Type": "application/json" });
          send(res, 200, body, { "Content-Type": "application/json" });
        });
      } catch {
        send(res, 400, JSON.stringify({ error: "invalid json" }), { "Content-Type": "application/json" });
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
      // SPA fallback -> index.html
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, indexContent) => {
        if (err2) return send(res, 404, "Not found");
        send(res, 200, indexContent, { "Content-Type": MIME[".html"] });
      });
      return;
    }
    const ext = path.extname(filePath);
    send(res, 200, content, { "Content-Type": MIME[ext] || "application/octet-stream" });
  });
});

server.listen(PORT, () => console.log(`PadelCom running on port ${PORT}`));

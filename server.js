/**
 * Swing AI Survey — production server
 *
 * Serves:
 *   /           — public survey (share this link)
 *   /admin      — response dashboard
 *   POST /api/responses      — survey submissions (on Submit button)
 *   GET  /api/responses      — list all submissions
 *
 * Env:
 *   PORT — default 3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const RESPONSES_FILE = path.join(ROOT, "data", "responses.jsonl");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function ensureDataDir() {
  const dir = path.dirname(RESPONSES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readAllResponses() {
  if (!fs.existsSync(RESPONSES_FILE)) return [];
  return fs
    .readFileSync(RESPONSES_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function resolveStaticPath(urlPath) {
  const clean = urlPath.split("?")[0];

  if (clean === "/" || clean === "") {
    return path.join(ROOT, "index.html");
  }

  if (clean === "/admin" || clean === "/admin/") {
    return path.join(ROOT, "admin", "index.html");
  }

  if (clean.startsWith("/admin/")) {
    return path.join(ROOT, "admin", clean.slice("/admin/".length));
  }

  return path.join(ROOT, clean.replace(/^\//, ""));
}

function serveStatic(req, res, filePath) {
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const total = stat.size;
    const range = req.headers.range;

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : total - 1;

        if (start >= total || end >= total) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": contentType,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, urlPath) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && urlPath === "/api/responses") {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.participant?.name || !Array.isArray(body.swings)) {
        jsonResponse(res, 400, { error: "Incomplete survey response" });
        return;
      }

      const entry = {
        id: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        ...body,
        submittedAt: body.submittedAt || new Date().toISOString(),
      };

      ensureDataDir();
      fs.appendFileSync(RESPONSES_FILE, JSON.stringify(entry) + "\n");
      jsonResponse(res, 200, { ok: true, id: entry.id });
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON" });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/responses") {
    jsonResponse(res, 200, readAllResponses());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath.startsWith("/api/")) {
    await handleApi(req, res, urlPath);
    return;
  }

  serveStatic(req, res, resolveStaticPath(urlPath));
});

ensureDataDir();
server.listen(PORT, () => {
  console.log(`Survey (public):  http://localhost:${PORT}`);
  console.log(`Admin dashboard:    http://localhost:${PORT}/admin`);
});

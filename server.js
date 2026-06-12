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
 *   SUPABASE_URL — Supabase project URL (production persistence)
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (server-side only, never expose to clients)
 *
 * When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set, responses are stored in
 * Supabase. Otherwise responses fall back to data/responses.jsonl (local dev).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const surveySession = require("./lib/surveySession");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const RESPONSES_FILE = path.join(ROOT, "data", "responses.jsonl");
const PARTIALS_DIR = path.join(ROOT, "data", "partials");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = "survey_responses";
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const supabase = useSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

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

function readAllPartialsLocal() {
  if (!fs.existsSync(PARTIALS_DIR)) return [];
  return fs
    .readdirSync(PARTIALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PARTIALS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((partial) => normalizeResponseEntry(partial, { inProgress: true }));
}

function normalizeResponseEntry(raw, extra = {}) {
  const sessionId = raw.sessionId || raw.id || null;
  const submittedAt = raw.submittedAt || null;
  return {
    id: sessionId || raw.id || crypto.randomUUID(),
    receivedAt: raw.receivedAt || raw.savedAt || raw.startedAt || new Date().toISOString(),
    savedAt: raw.savedAt || null,
    ...raw,
    sessionId,
    submittedAt,
    inProgress: extra.inProgress ?? !submittedAt,
  };
}

function mergeResponses(completed, partials) {
  const byKey = new Map();
  for (const entry of partials) {
    const key = entry.sessionId || entry.id;
    if (key) byKey.set(key, entry);
  }
  for (const entry of completed) {
    const key = entry.sessionId || entry.id;
    if (key) {
      byKey.set(key, { ...entry, inProgress: false });
    } else {
      byKey.set(entry.id, { ...entry, inProgress: false });
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      new Date(b.submittedAt || b.savedAt || b.receivedAt) -
      new Date(a.submittedAt || a.savedAt || a.receivedAt)
  );
}

function readAllResponsesLocal() {
  const completed = [];
  if (fs.existsSync(RESPONSES_FILE)) {
    for (const line of fs.readFileSync(RESPONSES_FILE, "utf8").split("\n")) {
      if (!line) continue;
      try {
        completed.push(normalizeResponseEntry(JSON.parse(line), { inProgress: false }));
      } catch {
        // skip bad lines
      }
    }
  }
  return mergeResponses(completed.reverse(), readAllPartialsLocal());
}

async function readAllResponses() {
  if (!useSupabase) return readAllResponsesLocal();

  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select("id, received_at, submitted_at, payload")
    .order("received_at", { ascending: false });

  if (error) {
    console.error("Supabase read failed:", error.message, error.details || "", error.hint || "");
    throw error;
  }
  return (data || []).map((row) =>
    normalizeResponseEntry(
      {
        ...row.payload,
        id: row.id,
        receivedAt: row.received_at,
        submittedAt: row.submitted_at || row.payload?.submittedAt || null,
      },
      { inProgress: !row.submitted_at && !row.payload?.submittedAt }
    )
  );
}

async function upsertResponse(entry) {
  const normalized = normalizeResponseEntry(entry);

  if (normalized.inProgress && normalized.sessionId) {
    fs.mkdirSync(PARTIALS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PARTIALS_DIR, `${normalized.sessionId}.json`),
      JSON.stringify(normalized, null, 2)
    );
  }

  if (!useSupabase) {
    if (normalized.inProgress) return;
    ensureDataDir();
    fs.appendFileSync(RESPONSES_FILE, JSON.stringify(normalized) + "\n");
    if (normalized.sessionId) {
      const partialPath = path.join(PARTIALS_DIR, `${normalized.sessionId}.json`);
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    }
    return;
  }

  const { error } = await supabase.from(SUPABASE_TABLE).upsert({
    id: normalized.id,
    received_at: normalized.receivedAt,
    submitted_at: normalized.submittedAt,
    payload: normalized,
  });

  if (error) {
    console.error("Supabase upsert failed:", error.message, error.details || "", error.hint || "");
    throw error;
  }

  if (!normalized.inProgress && normalized.sessionId) {
    const partialPath = path.join(PARTIALS_DIR, `${normalized.sessionId}.json`);
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
  }
}

async function saveResponse(entry) {
  await upsertResponse({ ...entry, submittedAt: entry.submittedAt || new Date().toISOString() });
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
    const isSurveyMedia =
      filePath.includes(`${path.sep}data${path.sep}media${path.sep}`) ||
      filePath.includes(`${path.sep}data${path.sep}survey_pool${path.sep}`);
    const cacheHeader = isSurveyMedia
      ? { "Cache-Control": "public, max-age=31536000, immutable" }
      : {};
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
          ...cacheHeader,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      ...cacheHeader,
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

  if (req.method === "POST" && urlPath === "/api/progress") {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.sessionId || !Array.isArray(body.swings)) {
        jsonResponse(res, 400, { error: "sessionId and swings required" });
        return;
      }
      const entry = normalizeResponseEntry(
        {
          ...body,
          id: body.sessionId,
          savedAt: new Date().toISOString(),
          submittedAt: null,
        },
        { inProgress: true }
      );
      await upsertResponse(entry);
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      console.error("POST /api/progress failed:", err);
      jsonResponse(res, 500, { error: "Failed to save progress" });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/progress") {
    try {
      const query = new URL(req.url, "http://localhost").searchParams;
      const sessionId = query.get("sessionId") || "";
      if (!sessionId) {
        jsonResponse(res, 400, { error: "sessionId required" });
        return;
      }
      const p = path.join(PARTIALS_DIR, `${sessionId}.json`);
      if (fs.existsSync(p)) {
        jsonResponse(res, 200, JSON.parse(fs.readFileSync(p, "utf8")));
        return;
      }
      if (useSupabase) {
        const { data, error } = await supabase
          .from(SUPABASE_TABLE)
          .select("payload, submitted_at")
          .eq("id", sessionId)
          .maybeSingle();
        if (error) throw error;
        if (data?.payload && !data.submitted_at && !data.payload.submittedAt) {
          jsonResponse(res, 200, data.payload);
          return;
        }
      }
      jsonResponse(res, 404, { error: "No saved progress" });
    } catch (err) {
      console.error("GET /api/progress failed:", err);
      jsonResponse(res, 500, { error: "Failed to load progress" });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/responses") {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.participant?.name || !Array.isArray(body.swings)) {
        jsonResponse(res, 400, { error: "Incomplete survey response" });
        return;
      }

      const entry = normalizeResponseEntry({
        id: body.sessionId || crypto.randomUUID(),
        receivedAt: body.startedAt || new Date().toISOString(),
        ...body,
        submittedAt: body.submittedAt || new Date().toISOString(),
      });

      await saveResponse(entry);
      jsonResponse(res, 200, { ok: true, id: entry.id });
    } catch (err) {
      if (err instanceof SyntaxError || err.message === "Invalid JSON") {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      console.error("POST /api/responses failed:", err);
      jsonResponse(res, 500, { error: "Failed to save response" });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/responses") {
    try {
      const responses = await readAllResponses();
      jsonResponse(res, 200, responses);
    } catch (err) {
      console.error("GET /api/responses failed:", err);
      jsonResponse(res, 500, { error: "Failed to load responses" });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/session") {
    try {
      const query = new URL(req.url, "http://localhost").searchParams;
      const deviceId = query.get("deviceId") || "";
      const sessionId = query.get("sessionId") || "";
      const session = surveySession.getOrCreateSession(deviceId, sessionId);
      jsonResponse(res, 200, surveySession.publicSession(session));
    } catch (err) {
      console.error("GET /api/session failed:", err);
      jsonResponse(res, 500, { error: err.message || "Failed to create survey session" });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function serveMedia(req, res, urlPath) {
  const rest = urlPath.replace(/^\/api\/media\//, "");
  const slash = rest.indexOf("/");
  if (slash === -1) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const mediaSource = rest.slice(0, slash);
  const mediaId = decodeURIComponent(rest.slice(slash + 1));
  const filePath = surveySession.resolveMediaPath(mediaSource, mediaId);
  if (!filePath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  serveStatic(req, res, filePath);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath.startsWith("/api/media/")) {
    serveMedia(req, res, urlPath);
    return;
  }

  if (urlPath.startsWith("/api/")) {
    await handleApi(req, res, urlPath);
    return;
  }

  serveStatic(req, res, resolveStaticPath(urlPath));
});

if (!useSupabase) ensureDataDir();
server.listen(PORT, () => {
  console.log(`Survey (public):  http://localhost:${PORT}`);
  console.log(`Admin dashboard:    http://localhost:${PORT}/admin`);
  if (useSupabase) {
    console.log("Response storage:   Supabase (table: survey_responses)");
  } else {
    console.warn(
      "Response storage:   local file only — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Render for production"
    );
  }
});

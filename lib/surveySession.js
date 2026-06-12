const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const CATALOG_PATH = process.env.SURVEY_CATALOG_PATH || path.join(ROOT, "data", "survey_catalog.json");
const USAGE_PATH = path.join(ROOT, "data", "clip_usage.json");
const SESSIONS_DIR = path.join(ROOT, "data", "sessions");

const DEFAULT_GOLFDB_ROOT = path.join(process.env.HOME || "", "golfdb-master");
const GOLFDB_ROOT = process.env.GOLFDB_REPO_ROOT || DEFAULT_GOLFDB_ROOT;

const ALLOWED_ROOTS = [
  ROOT,
  GOLFDB_ROOT,
  path.join(GOLFDB_ROOT, "golfdb_full_quality"),
  path.join(GOLFDB_ROOT, "swingai"),
  process.env.GOLFDB_DATA_ROOT,
].filter(Boolean);

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(`Survey catalog missing at ${CATALOG_PATH}. Run: npm run build-catalog`);
  }
  catalogCache = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  return catalogCache;
}

function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveUsage(usage) {
  fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
  fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
}

function clipKey(clip) {
  return `${clip.source}:${clip.id}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortByUsage(pool, usage, deviceId) {
  const deviceKey = deviceId ? `device:${deviceId}` : null;
  return [...pool].sort((a, b) => {
    const ka = clipKey(a);
    const kb = clipKey(b);
    const scoreA = (usage[ka] || 0) + (deviceKey && usage[`${deviceKey}:${ka}`] ? 1000 : 0);
    const scoreB = (usage[kb] || 0) + (deviceKey && usage[`${deviceKey}:${kb}`] ? 1000 : 0);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return Math.random() - 0.5;
  });
}

function pickFromPool(pool, count, usage, deviceId, usedKeys, extraFilter) {
  const ranked = sortByUsage(pool, usage, deviceId);
  const picked = [];

  for (const candidate of ranked) {
    if (picked.length >= count) break;
    const key = clipKey(candidate);
    if (usedKeys.has(key)) continue;
    if (extraFilter && !extraFilter(candidate, picked)) continue;
    picked.push(candidate);
    usedKeys.add(key);
  }

  if (picked.length < count) {
    const remaining = shuffle(pool.filter((c) => !usedKeys.has(clipKey(c))));
    for (const candidate of remaining) {
      if (picked.length >= count) break;
      if (extraFilter && !extraFilter(candidate, picked)) continue;
      picked.push(candidate);
      usedKeys.add(clipKey(candidate));
    }
  }

  return picked;
}

function pickGolfdbPair(pool, usage, deviceId, usedKeys, minGap) {
  const ranked = sortByUsage(pool, usage, deviceId);
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i];
    const keyA = clipKey(a);
    if (usedKeys.has(keyA)) continue;
    for (let j = i + 1; j < ranked.length; j++) {
      const b = ranked[j];
      const keyB = clipKey(b);
      if (usedKeys.has(keyB)) continue;
      if (Math.abs(a.numericId - b.numericId) < minGap) continue;
      usedKeys.add(keyA);
      usedKeys.add(keyB);
      return [a, b];
    }
  }

  const fallback = pickFromPool(pool, 2, usage, deviceId, usedKeys, (c, picked) => {
    if (picked.length === 0) return true;
    return Math.abs(c.numericId - picked[0].numericId) >= minGap;
  });
  return fallback;
}

function recordUsage(clips, deviceId) {
  const usage = loadUsage();
  for (const clip of clips) {
    const key = clipKey(clip);
    usage[key] = (usage[key] || 0) + 1;
    if (deviceId) {
      const dk = `device:${deviceId}:${key}`;
      usage[dk] = (usage[dk] || 0) + 1;
    }
  }
  saveUsage(usage);
}

function saveSession(session) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${session.sessionId}.json`), JSON.stringify(session, null, 2));
}

function loadSession(sessionId) {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function createSession(deviceId) {
  const catalog = loadCatalog();
  const picks = catalog.picksPerSession || { reddit: 2, og: 3, golfdb: 1 };
  const usage = loadUsage();
  const usedKeys = new Set();

  const reddit = pickFromPool(catalog.pools.reddit || [], picks.reddit || 0, usage, deviceId, usedKeys);
  const og = pickFromPool(catalog.pools.og || [], picks.og || 0, usage, deviceId, usedKeys);
  const golfdb = pickFromPool(catalog.pools.golfdb || [], picks.golfdb || 0, usage, deviceId, usedKeys);

  const all = [...reddit, ...og, ...golfdb];
  const expected =
    (picks.reddit || 0) + (picks.og || 0) + (picks.golfdb || 0) || catalog.swingCount || 6;
  if (all.length < expected) {
    throw new Error(
      `Not enough survey clips (need ${expected}, got ${all.length}). Re-run npm run build-catalog.`
    );
  }

  const swings = shuffle(all).map((clip, index) => ({
    index,
    clipId: clipKey(clip),
    source: clip.source,
    id: clip.id,
    player: clip.player,
    videoUrl: `/api/media/${clip.source}/${encodeURIComponent(clip.id)}`,
    faults: clip.faults,
  }));

  const session = {
    sessionId: crypto.randomUUID(),
    deviceId: deviceId || null,
    createdAt: new Date().toISOString(),
    swings,
  };

  recordUsage([...reddit, ...og, ...golfdb], deviceId);
  saveSession(session);
  return session;
}

function getOrCreateSession(deviceId, sessionId) {
  if (sessionId) {
    const existing = loadSession(sessionId);
    if (existing) return existing;
  }
  return createSession(deviceId);
}

function resolveVideoRef(videoRef) {
  if (!videoRef) return null;
  if (videoRef.startsWith("$SURVER" + path.sep) || videoRef.startsWith("$SURVER/")) {
    return path.join(ROOT, videoRef.replace(/^\$SURVER[/\\]/, ""));
  }
  if (path.isAbsolute(videoRef)) return videoRef;
  return path.join(GOLFDB_ROOT, videoRef);
}

function resolveMediaPath(source, id) {
  const catalog = loadCatalog();
  const pool = catalog.pools[source];
  if (!pool) return null;
  const clip = pool.find((c) => String(c.id) === String(decodeURIComponent(id)));
  if (!clip) return null;

  const ref = clip.videoRef || clip.videoPath;
  const resolved = path.resolve(resolveVideoRef(ref));
  const allowed = ALLOWED_ROOTS.some((root) => resolved.startsWith(path.resolve(root) + path.sep));
  if (!allowed) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function publicSession(session) {
  const catalog = loadCatalog();
  return {
    sessionId: session.sessionId,
    catalogVersion: catalog.catalogVersion || null,
    swingCount: session.swings.length,
    swings: session.swings.map(({ videoPath, ...rest }) => rest),
  };
}

module.exports = {
  loadCatalog,
  createSession,
  getOrCreateSession,
  resolveMediaPath,
  publicSession,
};

#!/usr/bin/env node
/**
 * Build survey_catalog.json from BC Ghost outputs + OG survey videos.
 *
 * Env (optional):
 *   GOLFDB_REPO_ROOT — default ~/golfdb-master relative paths
 *   FAULT_TAXONOMY_PATH — fault descriptions lookup
 *   SURVEY_CATALOG_OUT — output path (default data/survey_catalog.json)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REPO_ROOT = process.env.GOLFDB_REPO_ROOT || path.join(process.env.HOME || "", "golfdb-master");
const BC_GHOST = path.join(REPO_ROOT, "golfdb_full_quality", "bc_ghost_faults");
const REDDIT_JSONL = path.join(BC_GHOST, "reddit_faults.jsonl");
const GOLFDB_JSONL = path.join(BC_GHOST, "faults.jsonl");
const OG_JSONL = path.join(ROOT, "data", "og_faults.jsonl");
const OG_VIDEOS_DIR = path.join(ROOT, "assets", "videos");
const TAXONOMY_PATH =
  process.env.FAULT_TAXONOMY_PATH ||
  path.join(REPO_ROOT, "experimental_vqvae_pipeline", "trained_stuff", "fault_taxonomy.json");
const OUT_PATH = process.env.SURVEY_CATALOG_OUT || path.join(ROOT, "data", "survey_catalog.json");
const MIN_FAULTS = 3;

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadTaxonomy() {
  if (!fs.existsSync(TAXONOMY_PATH)) {
    console.warn("Taxonomy not found:", TAXONOMY_PATH);
    return new Map();
  }
  const data = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf8"));
  const map = new Map();
  for (const f of data.faults || []) {
    map.set(f.fault_id, f);
    map.set(normalizeTitle(f.title), f);
  }
  return map;
}

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function faultFromTop(top, taxonomy) {
  const faultId = top.fault_id;
  const tax = (faultId && taxonomy.get(faultId)) || taxonomy.get(normalizeTitle(top.title));
  return {
    fault_id: faultId || tax?.fault_id || null,
    name: top.title || tax?.title || "Fault",
    description: tax?.description || `Detected during the ${top.phase || "swing"} phase.`,
    phase: top.phase || tax?.phase || null,
  };
}

function toVideoRef(absPath) {
  const resolved = path.resolve(absPath);
  const repoResolved = path.resolve(REPO_ROOT);
  if (resolved.startsWith(repoResolved + path.sep)) {
    return path.relative(repoResolved, resolved);
  }
  const surverResolved = path.resolve(ROOT);
  if (resolved.startsWith(surverResolved + path.sep)) {
    return path.join("$SURVER", path.relative(surverResolved, resolved));
  }
  return resolved;
}

function rowToClip(row, source, taxonomy) {
  const topFaults = row.top_faults || [];
  if (topFaults.length < MIN_FAULTS) return null;

  const videoPath = row.video;
  if (!videoPath || !fs.existsSync(videoPath)) return null;

  const id = source === "golfdb" ? String(row.id) : String(row.key || row.id);
  const faults = topFaults.slice(0, 3).map((t) => faultFromTop(t, taxonomy));

  return {
    id,
    source,
    videoRef: toVideoRef(videoPath),
    numericId: source === "golfdb" ? Number(row.id) : null,
    player: row.player || null,
    faults,
  };
}

function loadOgFromBcGhost(taxonomy) {
  const rows = readJsonl(OG_JSONL);
  const clips = [];
  for (const row of rows) {
    if (row.status !== "ok") continue;
    const clip = rowToClip({ ...row, key: row.key || row.id }, "og", taxonomy);
    if (clip) clips.push(clip);
  }
  return clips;
}

/** Fallback: original survey swings + faults.js titles matched to taxonomy. */
function loadOgFromStatic(taxonomy) {
  const faultsJs = fs.readFileSync(path.join(ROOT, "faults.js"), "utf8");
  const match = faultsJs.match(/const APP_FAULTS = (\[[\s\S]*?\]);/);
  if (!match) return [];

  // eslint-disable-next-line no-eval
  const appFaults = eval(match[1]);
  const clips = [];

  for (let i = 0; i < appFaults.length; i++) {
    const swingNum = i + 1;
    const mp4 = path.join(OG_VIDEOS_DIR, `swing-${swingNum}.mp4`);
    const mov = path.join(OG_VIDEOS_DIR, `swing-${swingNum}.mov`);
    const videoPath = fs.existsSync(mp4) ? mp4 : fs.existsSync(mov) ? mov : null;
    if (!videoPath) continue;

    const faults = appFaults[i].map((f) => {
      const tax = taxonomy.get(normalizeTitle(f.name));
      return {
        fault_id: tax?.fault_id || null,
        name: f.name,
        description: f.description || tax?.description || f.name,
        phase: tax?.phase || null,
      };
    });

    if (faults.length < MIN_FAULTS) continue;

    clips.push({
      id: `swing-${swingNum}`,
      source: "og",
      videoRef: toVideoRef(videoPath),
      numericId: null,
      player: null,
      faults: faults.slice(0, 3),
    });
  }
  return clips;
}

function loadPool(jsonlPath, source, taxonomy) {
  const clips = [];
  for (const row of readJsonl(jsonlPath)) {
    if (row.status !== "ok") continue;
    const clip = rowToClip(row, source, taxonomy);
    if (clip) clips.push(clip);
  }
  return clips;
}

function main() {
  const taxonomy = loadTaxonomy();

  let og = loadOgFromBcGhost(taxonomy);
  if (og.length < 4) {
    console.warn(`OG BC Ghost pool=${og.length}; using faults.js fallback for OG clips.`);
    og = loadOgFromStatic(taxonomy);
  }

  const reddit = loadPool(REDDIT_JSONL, "reddit", taxonomy);
  const golfdb = loadPool(GOLFDB_JSONL, "golfdb", taxonomy);

  const catalog = {
    builtAt: new Date().toISOString(),
    minFaults: MIN_FAULTS,
    picksPerSession: { reddit: 4, og: 4, golfdb: 2 },
    swingCount: 10,
    golfdbMinIdGap: 8,
    pools: { reddit, og, golfdb },
    counts: {
      reddit: reddit.length,
      og: og.length,
      golfdb: golfdb.length,
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2));

  console.log("Survey catalog written:", OUT_PATH);
  console.log("Counts:", catalog.counts);
  if (reddit.length < 4 || og.length < 4 || golfdb.length < 2) {
    console.warn("WARNING: some pools are smaller than required picks per session.");
    process.exitCode = 1;
  }
}

main();

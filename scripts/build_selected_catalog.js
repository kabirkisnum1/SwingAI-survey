#!/usr/bin/env node
/**
 * Build survey_catalog.json from VL-curated selected clips (excludes rejected #24).
 * Renumbers accepted clips 1..N, copies videos to data/survey_pool/, wipes old pool media refs.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SELECTED_MANIFEST = path.join(ROOT, "data", "reddit_selected", "manifest.json");
const VL_MANIFEST = path.join(ROOT, "data", "reddit_selected_vl", "manifest_curated.json");
const VL_ACCEPTED = path.join(ROOT, "data", "reddit_selected_vl", "accepted");
const OLD_CATALOG = path.join(ROOT, "data", "survey_catalog.json");
const OUT_CATALOG = path.join(ROOT, "data", "survey_catalog.json");
const POOL_ROOT = path.join(ROOT, "data", "survey_pool");
const CATALOG_VERSION = "selected-pool-v1";

function safeFileName(id) {
  return String(id).replace(/[^\w.\-]+/g, "_").slice(0, 180);
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function faultLookup(oldCatalog) {
  const map = new Map();
  for (const source of Object.keys(oldCatalog.pools || {})) {
    for (const clip of oldCatalog.pools[source] || []) {
      map.set(`${source}:${clip.id}`, clip.faults || []);
    }
  }
  return map;
}

function main() {
  const selected = loadJson(SELECTED_MANIFEST, { clips: [] }).clips;
  const vlClips = loadJson(VL_MANIFEST, { clips: [] }).clips;
  const oldCatalog = loadJson(OLD_CATALOG, { pools: {} });
  const faultsByKey = faultLookup(oldCatalog);

  const acceptedNums = new Set(
    vlClips.filter((c) => c.acceptedVideo).map((c) => c.number)
  );

  const kept = selected
    .filter((c) => acceptedNums.has(c.number))
    .sort((a, b) => a.number - b.number);

  if (!kept.length) {
    console.error("No accepted clips found");
    process.exit(1);
  }

  const pools = { reddit: [], og: [], golfdb: [] };
  const renumberedManifest = [];

  for (let i = 0; i < kept.length; i++) {
    const entry = kept[i];
    const poolNum = i + 1;
    const srcVl = path.join(VL_ACCEPTED, `${entry.number}.mp4`);
    if (!fs.existsSync(srcVl)) {
      console.error("Missing VL file:", srcVl);
      process.exit(1);
    }

    const source = entry.source;
    const id = entry.id;
    const destDir = path.join(POOL_ROOT, source);
    const destName = `${safeFileName(id)}.mp4`;
    const dest = path.join(destDir, destName);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcVl, dest);

    const faults =
      faultsByKey.get(`${source}:${id}`) ||
      (entry.faults || []).map((name) => ({ fault_id: null, name, description: name, phase: null }));

    const clip = {
      poolNumber: poolNum,
      id,
      source,
      videoRef: `$SURVER/data/survey_pool/${source}/${destName}`,
      numericId: source === "golfdb" ? Number(id) : null,
      player: source === "golfdb" ? "pro" : null,
      faults,
    };

    pools[source].push(clip);
    renumberedManifest.push({
      poolNumber: poolNum,
      previousNumber: entry.number,
      id,
      source,
      videoRef: clip.videoRef,
      faults: faults.map((f) => f.name),
    });
  }

  const catalog = {
    builtAt: new Date().toISOString(),
    catalogVersion: CATALOG_VERSION,
    minFaults: 3,
    picksPerSession: { reddit: 2, og: 3, golfdb: 1 },
    swingCount: 6,
    golfdbMinIdGap: 8,
    mediaRoot: "data/survey_pool",
    pools,
    counts: {
      reddit: pools.reddit.length,
      og: pools.og.length,
      golfdb: pools.golfdb.length,
      total: kept.length,
    },
  };

  fs.writeFileSync(OUT_CATALOG, JSON.stringify(catalog, null, 2) + "\n");
  fs.writeFileSync(
    path.join(POOL_ROOT, "manifest.json"),
    JSON.stringify({ catalogVersion: CATALOG_VERSION, clips: renumberedManifest }, null, 2) + "\n"
  );

  // Renumber selected + vl accepted folders (1..N, skip gap at old 24)
  renumberFolder(path.join(ROOT, "data", "reddit_selected"), kept);
  renumberFolder(VL_ACCEPTED, kept, true);

  console.log("Survey catalog written:", OUT_CATALOG);
  console.log("Counts:", catalog.counts);
  console.log("Excluded rejected clip(s):", selected.filter((c) => !acceptedNums.has(c.number)).map((c) => c.number));
}

function renumberFolder(dir, kept, vlOnly = false) {
  const tmpDir = path.join(dir, "__renumber_tmp");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const entry of kept) {
    const src = path.join(dir, `${entry.number}.mp4`);
    if (!fs.existsSync(src)) continue;
    const poolNum = kept.indexOf(entry) + 1;
    fs.copyFileSync(src, path.join(tmpDir, `${poolNum}.mp4`));
  }

  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".mp4")) fs.unlinkSync(path.join(dir, f));
  }
  for (const f of fs.readdirSync(tmpDir)) {
    fs.renameSync(path.join(tmpDir, f), path.join(dir, f));
  }
  fs.rmdirSync(tmpDir);

  if (!vlOnly) {
    const manifest = {
      catalogVersion: CATALOG_VERSION,
      clips: kept.map((entry, i) => ({
        poolNumber: i + 1,
        previousNumber: entry.number,
        id: entry.id,
        source: entry.source,
        faults: entry.faults || [],
      })),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
}

main();

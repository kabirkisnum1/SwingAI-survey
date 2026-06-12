#!/usr/bin/env node
/**
 * Re-encode bundled survey clips for web delivery (~1 GB total vs ~12 GB HQ).
 * Required to fit GitHub LFS free quota (10 GiB). Safe for coach rating on phone/desktop.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MEDIA_ROOT = path.join(ROOT, "data", "media");
const CATALOG_PATH = path.join(ROOT, "data", "survey_catalog.json");
const CONCURRENCY = Number(process.env.COMPRESS_WORKERS || 4);
const MAX_WIDTH = Number(process.env.COMPRESS_MAX_WIDTH || 720);
const CRF = Number(process.env.COMPRESS_CRF || 28);
const SKIP_BELOW_BYTES = Number(process.env.COMPRESS_SKIP_BELOW || 2_500_000);

function listMp4Files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMp4Files(full));
    else if (entry.name.endsWith(".mp4")) out.push(full);
  }
  return out;
}

function compressFile(file) {
  const stat = fs.statSync(file);
  if (stat.size < SKIP_BELOW_BYTES) return { file, status: "skip-small" };

  const tmp = `${file}.compressing.mp4`;
  const args = [
    "-y",
    "-i",
    file,
    "-vf",
    `scale='min(${MAX_WIDTH},iw)':-2`,
    "-c:v",
    "libx264",
    "-crf",
    String(CRF),
    "-preset",
    "fast",
    "-an",
    "-movflags",
    "+faststart",
    tmp,
  ];

  const result = spawnSync("ffmpeg", args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    return { file, status: "error", error: result.stderr?.slice(-400) || "ffmpeg failed" };
  }

  const before = stat.size;
  const after = fs.statSync(tmp).size;
  fs.renameSync(tmp, file);
  return { file, status: "compressed", before, after };
}

async function runPool(files, worker) {
  let index = 0;
  const results = [];

  async function next() {
    while (index < files.length) {
      const i = index++;
      results[i] = await worker(files[i]);
      if ((i + 1) % 50 === 0 || i + 1 === files.length) {
        process.stdout.write(`\rCompressed ${i + 1}/${files.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, next));
  process.stdout.write("\n");
  return results;
}

async function main() {
  if (!fs.existsSync(MEDIA_ROOT)) {
    console.error("Missing data/media. Run: npm run bundle-media");
    process.exit(1);
  }

  const files = listMp4Files(MEDIA_ROOT);
  if (!files.length) {
    console.error("No .mp4 files under data/media");
    process.exit(1);
  }

  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "pipe" });
  if (ffmpeg.status !== 0) {
    console.error("ffmpeg not found. Install ffmpeg to compress survey media.");
    process.exit(1);
  }

  console.log(`Compressing ${files.length} clips (${CONCURRENCY} workers, max ${MAX_WIDTH}px, crf ${CRF})`);
  const results = await runPool(files, (file) => Promise.resolve(compressFile(file)));

  let compressed = 0;
  let skipped = 0;
  let errors = 0;
  let saved = 0;

  for (const r of results) {
    if (r.status === "compressed") {
      compressed++;
      saved += r.before - r.after;
    } else if (r.status === "skip-small") skipped++;
    else {
      errors++;
      console.error("\nERROR:", r.file, r.error);
    }
  }

  if (fs.existsSync(CATALOG_PATH)) {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    catalog.mediaCompressed = true;
    catalog.mediaCompressedAt = new Date().toISOString();
    catalog.mediaCompress = { maxWidth: MAX_WIDTH, crf: CRF };
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  }

  const total = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`Done. compressed=${compressed} skipped=${skipped} errors=${errors}`);
  console.log(`Saved ${(saved / 1e9).toFixed(2)} GB → bundle now ${(total / 1e9).toFixed(2)} GB`);
  if (errors) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

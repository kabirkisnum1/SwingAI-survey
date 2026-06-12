#!/usr/bin/env node
/**
 * Copy all catalog videos into data/media/{source}/{id}.mp4
 * and rewrite survey_catalog.json to use local $SURVER paths.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CATALOG_PATH = path.join(ROOT, "data", "survey_catalog.json");
const MEDIA_ROOT = path.join(ROOT, "data", "media");
const GOLFDB_ROOT = process.env.GOLFDB_REPO_ROOT || path.join(process.env.HOME || "", "golfdb-master");

function resolveSource(ref) {
  if (!ref) return null;
  if (ref.startsWith("$SURVER/") || ref.startsWith("$SURVER\\")) {
    return path.join(ROOT, ref.replace(/^\$SURVER[/\\]/, ""));
  }
  if (path.isAbsolute(ref)) return ref;
  return path.join(GOLFDB_ROOT, ref);
}

function safeFileName(id) {
  return String(id).replace(/[^\w.\-]+/g, "_").slice(0, 180);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const a = fs.statSync(src);
    const b = fs.statSync(dest);
    if (a.size === b.size) return "skip";
  }
  fs.copyFileSync(src, dest);
  return "copy";
}

function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error("Missing catalog. Run: npm run build-catalog");
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  let copied = 0;
  let skipped = 0;
  let missing = 0;

  for (const source of Object.keys(catalog.pools)) {
    for (const clip of catalog.pools[source]) {
      const ref = clip.videoRef || clip.videoPath;
      const src = resolveSource(ref);
      const dest = path.join(MEDIA_ROOT, source, `${safeFileName(clip.id)}.mp4`);

      if (!src || !fs.existsSync(src)) {
        console.warn("MISSING:", source, clip.id, ref);
        missing++;
        continue;
      }

      const result = copyFile(src, dest);
      if (result === "copy") copied++;
      else skipped++;

      clip.videoRef = `$SURVER/data/media/${source}/${safeFileName(clip.id)}.mp4`;
      delete clip.videoPath;
    }
  }

  catalog.bundledAt = new Date().toISOString();
  catalog.mediaRoot = "data/media";
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

  console.log(`Bundled media → ${MEDIA_ROOT}`);
  console.log(`Copied: ${copied}, skipped: ${skipped}, missing: ${missing}`);
  if (missing > 0) process.exitCode = 1;
}

main();

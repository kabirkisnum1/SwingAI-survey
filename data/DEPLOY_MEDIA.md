# Survey media bundle

Videos are copied to `data/media/` by `npm run bundle-media` (~12 GB for full catalog).

This folder is **gitignored** (too large for GitHub). For Render:

1. Run locally: `npm run prepare-survey`
2. Upload `data/media/` to your host (Render persistent disk, rsync, etc.)
3. Deploy the app — `data/survey_catalog.json` in git points at `$SURVER/data/media/...`

Faults are stored in `survey_catalog.json` (no separate files needed).

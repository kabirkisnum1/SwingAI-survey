# Survey media bundle

Videos live in `data/media/` (~12 GB HQ after `bundle-media`, ~1 GB after `compress-media`).

## GitHub (recommended)

Media is tracked with **Git LFS** (see `.gitattributes`). After bundling:

```bash
npm run prepare-survey-github   # build catalog, copy clips, compress for web
git lfs install
git add .gitattributes data/media/
git commit -m "Add survey media via Git LFS"
git push origin main
```

GitHub Free includes **10 GiB** LFS storage. Compressed web clips fit inside that quota. Render auto-deploy will `git lfs pull` on build if LFS is enabled on the host.

On a fresh clone:

```bash
git lfs install
git lfs pull
```

## Manual upload (optional)

If you skip LFS, upload `data/media/` to Render persistent disk or rsync. `data/survey_catalog.json` points at `$SURVER/data/media/...`.

Faults are stored in `survey_catalog.json` (no separate files needed).

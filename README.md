# PossAbilities Stores

Stock control, issue log and supplier contacts for the PossAbilities store.
Static front end (`public/index.html`) + one Netlify Function (`netlify/functions/api.mjs`) + Netlify Blobs for storage.

## Deploy (GitHub Desktop → Netlify)

1. In GitHub Desktop: File → Add local repository → choose this folder → create the repository → Publish (keep it private).
2. In Netlify: Add new site → Import an existing project → GitHub → pick the repo.
   Build settings are read from `netlify.toml`, so leave them as they are and deploy.
3. Site configuration → Environment variables → add:
   - `STORES_USERNAME` – the shared username
   - `STORES_PASSWORD` – the shared password
   - `STORES_SECRET` – a long random string (40+ characters) used to sign logins
4. Deploys → Trigger deploy → Deploy site (so the function picks up the variables).

Note: drag-and-drop deploys don't include the function, so use the GitHub route.

## Everyday notes

- Everyone logs in with the same username and password. A login lasts 30 days on that device.
- To lock everyone out (e.g. a staff member leaves), change `STORES_PASSWORD` in Netlify and redeploy. All devices are logged out.
- Changes show on every open device within about 4 seconds.
- Downloads are CSV files and open in Excel. The Stock download follows the current filter, so choose "Running low" first for a reorder list.
- All data lives in the Netlify Blobs store `possabilities-stores` (key `db`; photos under `photo/`).

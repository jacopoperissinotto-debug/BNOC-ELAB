# BNOC · Big Name On Campus

A free-to-play forecasting app for the King's E-Lab pilot. People make yes/no calls about real life in their community, say how sure they are, and earn points for being right. There's no money anywhere: nothing to buy, stake or cash out.

- **Design reference:** `bnoc-demo/index.html` (the original prototype, never modified)
- **Front end:** plain HTML/CSS/JS built with Vite (`index.html`, `src/`)
- **Back end:** one Netlify Function (`netlify/functions/api.mjs`) storing data in Netlify Blobs, Netlify's built-in storage. No other services or accounts needed.
- **Shared rules:** `shared/rules.js` (confidence scoring, @cam.ac.uk check, banned topics), used by both the app and the back end
- **Hosting:** Netlify, deploying automatically from GitHub

> A fuller Supabase version (magic-link login, database rules, private groups) was started and is parked on the `supabase-version` git branch.

## How the pilot works

| Who | What they do |
|---|---|
| Everyone | Open bnoc.netlify.app (or scan the QR), type first name and @cam.ac.uk email, make calls, comment |
| Admin | Opens **bnoc.netlify.app/#/admin**, types the admin key, posts calls (two answers each: Yes/No or custom labels) with a closing time, closes and settles them, removes comments or people |

Scoring (worked out by the back end, never the browser):

| Confidence | Right | Wrong |
|---|---|---|
| Hunch (60%) | +10 | 0 |
| Fairly sure (75%) | +20 | −5 |
| Certain (90%) | +30 | −15 |

Every call has exactly two answers: Yes / No by default, or two labels the admin chooses (e.g. "Team A" / "Team B"). Members can comment on any call; comments show first names, are checked for banned topics, and can be deleted by their author or an admin.

Rules the back end enforces: answers are locked once made; no answers after a call closes; a call can only be settled after it closes; only the admin key can post, close, settle or remove calls; suggestions about banned topics (relationships, health, appearance, grades) are refused.

**Pilot shortcut:** there is no email verification. Typing the same email again logs you back into the same account. Fine for a small pilot, not for a public launch.

## Deploy (Netlify + GitHub)

The GitHub repo (jacopoperissinotto-debug/BNOC-ELAB) is **public**: Netlify's free plan only builds private repos for one Git contributor. There are no secrets in the code; `ADMIN_KEY` lives only in Netlify.

1. Push this repository to GitHub.
2. In Netlify: **Project configuration → Build & deploy → Continuous deployment → Link repository**, choose the repo, branch `main`. Build settings come from `netlify.toml`.
3. In Netlify: **Environment variables → Add a variable**: key `ADMIN_KEY`, value a long passphrase only admins know. Redeploy after adding it.
4. Every push to `main` now deploys automatically.

## Make someone an admin

Admins don't have special accounts: anyone who knows `ADMIN_KEY` can open `/#/admin`. To add an admin, share the passphrase with them privately. To remove admins, change `ADMIN_KEY` in Netlify and redeploy.

## Run it on your computer

1. Install Node.js (LTS) from https://nodejs.org
2. Copy `.env.example` to `.env` and set `ADMIN_KEY`
3. In this folder:
   ```bash
   npm install
   npx netlify-cli dev
   ```
4. Open http://localhost:8888 (the app) and http://localhost:8888/#/admin (admin). Local data is kept separately from the live site.

## Privacy

The in-app privacy notice (Me → Privacy notice) explains what's collected. **Delete my account** (Me tab) removes the person's name, email, login sessions, calls, suggestions and comments straight away.

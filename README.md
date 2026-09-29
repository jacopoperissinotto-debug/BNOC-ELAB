# BNOC · Big Name On Campus

A free-to-play social forecasting app for the King's E-Lab pilot. People make yes/no calls about real life in their community, earn points for being right, and get a bonus for showing up to events. There's no money anywhere.

- **Design reference:** `bnoc-demo/index.html` (the original prototype, never modified)
- **Front end:** plain HTML/CSS/JS, built with Vite, talking to Supabase with `supabase-js`
- **Back end:** Supabase (login + Postgres). Every table has Row Level Security; scoring happens in the database
- **Hosting:** Netlify, deploying automatically from GitHub

## Run it on your computer

1. Install Node.js (LTS) from https://nodejs.org
2. In this folder, copy `.env.example` to `.env` and fill in your Supabase project URL and **public** (anon / publishable) key
3. Install and start:
   ```bash
   npm install
   npm run dev
   ```
4. Open http://localhost:5173

## Database

All database setup lives in `supabase/migrations/` as SQL files, applied in order. Login email templates are in `supabase/templates/`.

_More detail (applying migrations, deploying, making someone an admin) is added as each phase is built._

## Security notes

- Only the public anon/publishable key is used in the front end. **Never** put the secret / service_role key in this project.
- `.env` is ignored by git.
- Only `@cam.ac.uk` emails can create accounts. The app checks it for a friendly message, and a database trigger enforces it.

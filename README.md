# Sequel

**What should you watch or read next?**

Sequel recommends **movies**, **TV shows**, and **books** from titles you’ve already logged and rated.

## Features

| Area | What it does |
|------|----------------|
| **Home** | New movies, TV shows, and books with cover art |
| **Library** | Log finished / in-progress / dropped / want-to titles |
| **Ratings** | 1–5 stars + optional note |
| **For you** | Suggestions from genres & vibes you rate highly |
| **Browse** | Search a built-in catalog; add custom titles |

Cover art loads from free public sources (iTunes / Open Library) and is cached in your browser.

## Accounts

| Mode | What it does |
|------|----------------|
| **Create account / Log in** | Cloud account (Supabase Storage). Library syncs across phones. |
| **Continue as guest** | Local-only on this browser — no cross-device sync. |

Each account has its own library. Guests and cloud users never share ratings.

## IMDb search (movies & TV)

Search uses the built-in catalog **plus** [OMDb](http://www.omdbapi.com/) (IMDb data).

1. Get a free key: https://www.omdbapi.com/apikey.aspx  
2. Set env var **`OMDB_API_KEY`** on Vercel (Project → Settings → Environment Variables).  
3. Redeploy.

Books stay on the local catalog / custom add / Open Library covers (IMDb doesn’t list books the same way).

Local static server can’t run `/api/omdb` unless you use `vercel dev` or set:

```js
// in browser console for local testing against a deployed API:
window.SEQUEL_API_BASE = "https://your-sequel.vercel.app"
```

## Run locally

```bash
cd ~/workspace/sequel
python3 -m http.server 8090
```

Open **http://127.0.0.1:8090/**

## Deploy (like Hermes / Sillage)

```bash
# push to GitHub, then import on Vercel
# Build: npm run build
# Output: public
# Env:
#   OMDB_API_KEY=...
#   SUPABASE_URL=...
#   SUPABASE_SERVICE_ROLE_KEY=...
# Optional: SEQUEL_SESSION_SECRET=...
```

On Supabase: enable Storage. The API creates a private bucket named **`sequel`** when possible (or create it manually).

Without Supabase env vars, **Create account** falls back to a **local-only** account (works offline; not shared across phones).

## How recommendations work

1. You rate titles (especially **4–5★**).
2. Sequel learns which **genres** and **vibes** you like (and avoids ones you rate low or drop).
3. **For you** ranks catalog titles you haven’t logged yet.

## Stack

Static HTML / CSS / JS · localStorage · Vercel-ready

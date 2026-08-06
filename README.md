# Sequel

**What should you watch or read next?**

Sequel recommends **movies**, **TV shows**, and **books** from titles you’ve already logged and rated.

## Features

| Area | What it does |
|------|----------------|
| **Library** | Log finished / in-progress / dropped / want-to titles |
| **Ratings** | 1–5 stars + optional note |
| **For you** | Suggestions from genres & vibes you rate highly |
| **Browse** | Search a built-in catalog; add custom titles |

Data stays in **your browser** (`localStorage`) for now — private and fast.

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
```

## How recommendations work

1. You rate titles (especially **4–5★**).
2. Sequel learns which **genres** and **vibes** you like (and avoids ones you rate low or drop).
3. **For you** ranks catalog titles you haven’t logged yet.

## Stack

Static HTML / CSS / JS · localStorage · Vercel-ready

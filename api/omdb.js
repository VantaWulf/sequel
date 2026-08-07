/**
 * OMDb proxy (IMDb data via omdbapi.com).
 *
 * GET /api/omdb?mode=search&q=shawshank&type=movie|tv|all
 * GET /api/omdb?mode=title&id=tt0111161
 *
 * Requires OMDB_API_KEY on the server (free key: https://www.omdbapi.com/apikey.aspx)
 */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  cors(res);
  res.end(JSON.stringify(body));
}

function loadKey() {
  return (process.env.OMDB_API_KEY || process.env.OMDB_KEY || "").trim();
}

function mapType(omdbType) {
  const t = String(omdbType || "").toLowerCase();
  if (t === "series" || t === "tv") return "tv";
  if (t === "movie") return "movie";
  return "movie";
}

function genresFrom(str) {
  return String(str || "")
    .split(",")
    .map((g) => g.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean)
    .slice(0, 8);
}

function mapSearchHit(r) {
  return {
    id: `imdb:${r.imdbID}`,
    imdbID: r.imdbID,
    type: mapType(r.Type),
    title: r.Title,
    year: parseInt(String(r.Year || "").slice(0, 4), 10) || null,
    poster: r.Poster && r.Poster !== "N/A" ? r.Poster : "",
    source: "imdb",
  };
}

function mapTitle(d) {
  const type = mapType(d.Type);
  const genres = genresFrom(d.Genre);
  const plot = d.Plot && d.Plot !== "N/A" ? d.Plot : "";
  const why = plot ? plot.split(/[.!?]/)[0].slice(0, 120) : "From IMDb";
  return {
    id: `imdb:${d.imdbID}`,
    imdbID: d.imdbID,
    type,
    title: d.Title,
    year: parseInt(String(d.Year || "").slice(0, 4), 10) || null,
    author: type === "book" ? "" : d.Director && d.Director !== "N/A" ? d.Director : "",
    genres,
    vibe: [],
    why,
    description:
      plot ||
      `${d.Title} (${d.Year}) — ${d.Genre || type}. ${d.Actors && d.Actors !== "N/A" ? "Starring " + d.Actors + "." : ""}`.trim(),
    poster: d.Poster && d.Poster !== "N/A" ? d.Poster : "",
    runtime: d.Runtime && d.Runtime !== "N/A" ? d.Runtime : "",
    rated: d.Rated && d.Rated !== "N/A" ? d.Rated : "",
    imdbRating: d.imdbRating && d.imdbRating !== "N/A" ? d.imdbRating : "",
    source: "imdb",
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    cors(res);
    res.end();
    return;
  }
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  const key = loadKey();
  if (!key) {
    return json(res, 503, {
      error: "OMDB_API_KEY not configured",
      hint: "Get a free key at https://www.omdbapi.com/apikey.aspx and set OMDB_API_KEY on Vercel (or .env for local).",
      results: [],
    });
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const mode = (url.searchParams.get("mode") || "search").toLowerCase();

    if (mode === "title" || mode === "i") {
      const id = (url.searchParams.get("id") || url.searchParams.get("i") || "").trim();
      if (!/^tt\d+$/i.test(id) && !id.startsWith("imdb:")) {
        return json(res, 400, { error: "Expected IMDb id like tt0111161" });
      }
      const imdbID = id.replace(/^imdb:/i, "");
      const api = `https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&i=${encodeURIComponent(
        imdbID
      )}&plot=full`;
      const r = await fetch(api);
      const data = await r.json();
      if (data.Response === "False") {
        return json(res, 404, { error: data.Error || "Not found" });
      }
      return json(res, 200, { ok: true, item: mapTitle(data) });
    }

    // search
    const q = (url.searchParams.get("q") || url.searchParams.get("s") || "").trim();
    if (q.length < 2) return json(res, 400, { error: "Query too short", results: [] });

    const typeParam = (url.searchParams.get("type") || "all").toLowerCase();
    // OMDb: movie | series | episode
    let omdbType = "";
    if (typeParam === "movie") omdbType = "movie";
    else if (typeParam === "tv" || typeParam === "series") omdbType = "series";
    // books not supported by OMDb

    if (typeParam === "book") {
      return json(res, 200, {
        ok: true,
        results: [],
        note: "IMDb/OMDb has movies & TV only. Use local catalog or custom add for books.",
      });
    }

    const api = new URL("https://www.omdbapi.com/");
    api.searchParams.set("apikey", key);
    api.searchParams.set("s", q);
    if (omdbType) api.searchParams.set("type", omdbType);

    const r = await fetch(api.toString());
    const data = await r.json();
    if (data.Response === "False") {
      return json(res, 200, { ok: true, results: [], error: data.Error || "No results" });
    }
    const results = (data.Search || [])
      .filter((x) => x.Type === "movie" || x.Type === "series")
      .map(mapSearchHit)
      .slice(0, 20);

    return json(res, 200, {
      ok: true,
      results,
      total: data.totalResults || String(results.length),
      source: "imdb",
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e), results: [] });
  }
};

/**
 * Sequel — recommend movies, TV, and books from what you rated.
 * Per-user library (localStorage) + optional cloud sync via Supabase.
 * Catalog in data.js; custom titles supported.
 */

const STORAGE_KEY_PREFIX = "sequel.library.v1.";
const LEGACY_STORAGE_KEY = "sequel.library.v1";
const AUTH_KEY = "sequel.auth.v1";
const SESSION_KEY = "sequel.session.v1";
const CLOUD_TOKEN_KEY = "sequel.cloud.token.v1";
const CLOUD_USER_KEY = "sequel.cloud.user.v1";
const POSTER_CACHE_KEY = "sequel.posters.v5";
const REMOTE_CACHE_KEY = "sequel.remote.v1";
const POSTER_FAIL_KEY = "sequel.posters.fail.v1";
/** Production API host when opened from a non-Vercel static host. */
const DEFAULT_SEQUEL_API_BASE = "https://sequel-vantawulfs-projects.vercel.app";

const state = {
  panel: "home",
  recType: "all",
  libType: "all",
  browseType: "all",
  rateDraft: {
    id: null,
    status: "done",
    rating: 0,
  },
  customType: "movie",
  posterCache: {},
  posterFail: {},
  remoteById: {},
  imdbBusy: false,
  imdbStatus: "",
  authMode: "signup", // signup | login
  currentUserId: null,
  cloudSyncTimer: null,
  /** Onboarding draft while editing preferences */
  onboardDraft: {
    birthYear: null,
    maxRating: "PG-13",
    streaming: [],
  },
};

/** US movie-style ladder used for filtering. */
const CONTENT_RATING_LEVEL = {
  G: 0,
  PG: 1,
  "PG-13": 2,
  R: 3,
  "NC-17": 4,
  any: 99,
};

const STREAMING_LABELS = {
  netflix: "Netflix",
  disney: "Disney+",
  hulu: "Hulu",
  max: "Max",
  prime: "Prime Video",
  apple: "Apple TV+",
  peacock: "Peacock",
  paramount: "Paramount+",
  crunchyroll: "Crunchyroll",
  youtube: "YouTube",
  none: "None / other",
};

/** Soft genre/vibe boosts by streaming service (catalog has no platform list). */
const STREAMING_TASTE = {
  netflix: { genres: ["crime", "thriller", "drama", "scifi", "dark-comedy"], vibe: ["dark", "tense"] },
  disney: { genres: ["animation", "family", "superhero", "adventure", "fantasy"], vibe: ["fun", "spectacular"] },
  hulu: { genres: ["comedy", "drama", "horror", "teen"], vibe: ["quirky", "sharp"] },
  max: { genres: ["drama", "fantasy", "crime", "comedy", "epic"], vibe: ["prestige", "epic", "sharp"] },
  prime: { genres: ["action", "scifi", "drama", "comedy"], vibe: ["blockbuster", "fun"] },
  apple: { genres: ["drama", "scifi", "thriller", "comedy"], vibe: ["prestige", "cerebral"] },
  peacock: { genres: ["comedy", "sports", "drama"], vibe: ["fun"] },
  paramount: { genres: ["scifi", "action", "adventure", "crime"], vibe: ["epic", "fun"] },
  crunchyroll: { genres: ["animation", "fantasy", "action", "scifi"], vibe: ["stylish", "fun"] },
  youtube: { genres: ["comedy", "documentary"], vibe: ["fun"] },
  none: { genres: [], vibe: [] },
};

function meId() {
  return state.currentUserId || readSession() || "";
}

function userStorageKey(userId = meId()) {
  return STORAGE_KEY_PREFIX + (userId || "guest-local");
}

/* ---------- utils ---------- */

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function typeLabel(t) {
  if (t === "movie") return "Movie";
  if (t === "tv") return "TV";
  if (t === "book") return "Book";
  return "Title";
}

function typeShort(t) {
  if (t === "movie") return "Film";
  if (t === "tv") return "TV";
  if (t === "book") return "Book";
  return "•";
}

function starsText(n) {
  const r = Math.round(Number(n) || 0);
  if (!r) return "—";
  return "★".repeat(r) + "☆".repeat(Math.max(0, 5 - r));
}

/* ---------- catalog ---------- */

function catalog() {
  return window.SEQUEL_CATALOG || [];
}

function catalogById(id) {
  return catalog().find((x) => x.id === id) || null;
}

function loadRemoteCache() {
  try {
    state.remoteById = JSON.parse(localStorage.getItem(REMOTE_CACHE_KEY) || "{}") || {};
  } catch {
    state.remoteById = {};
  }
}

function saveRemoteCache() {
  try {
    localStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(state.remoteById));
  } catch {
    /* ignore */
  }
}

function cacheRemoteItem(item) {
  if (!item?.id) return;
  state.remoteById[item.id] = item;
  if (item.poster) {
    state.posterCache[item.id] = item.poster;
    savePosterCache();
  }
  saveRemoteCache();
}

function resolveItem(id) {
  const fromCat = catalogById(id);
  if (fromCat) return fromCat;
  if (state.remoteById[id]) return state.remoteById[id];
  // custom / saved library entries
  const lib = load().items.find((x) => x.id === id);
  if (!lib) return null;
  return {
    id: lib.id,
    imdbID: lib.imdbID || "",
    type: lib.type,
    title: lib.title,
    year: lib.year || null,
    author: lib.author || "",
    genres: lib.genres || [],
    vibe: lib.vibe || [],
    why: lib.why || "Custom title",
    description: lib.description || "",
    poster: lib.poster || "",
    posterQuery: lib.title,
    custom: !!lib.custom,
    source: lib.source || (lib.custom ? "custom" : "local"),
  };
}

function apiBase() {
  if (typeof window !== "undefined" && window.SEQUEL_API_BASE) {
    return String(window.SEQUEL_API_BASE).replace(/\/$/, "");
  }
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (host === "127.0.0.1" || host === "localhost") return "";
  if (host.endsWith(".vercel.app")) return "";
  return DEFAULT_SEQUEL_API_BASE;
}

function apiUrl(path) {
  const base = apiBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function omdbUrl(pathQuery) {
  return `${apiUrl("/api/omdb")}?${pathQuery}`;
}

function readCloudToken() {
  try {
    return localStorage.getItem(CLOUD_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function writeCloudToken(token) {
  try {
    if (!token) localStorage.removeItem(CLOUD_TOKEN_KEY);
    else localStorage.setItem(CLOUD_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

function readCloudUser() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_USER_KEY) || "null");
  } catch {
    return null;
  }
}

function writeCloudUser(user) {
  try {
    if (!user) localStorage.removeItem(CLOUD_USER_KEY);
    else localStorage.setItem(CLOUD_USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

async function cloudFetch(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  const t = token || readCloudToken();
  if (t) headers["x-sequel-token"] = t;
  const res = await fetch(apiUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `Cloud error ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/** Search IMDb via OMDb proxy (movies & TV). */
async function searchImdb(query, type = "all") {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  if (type === "book") return [];
  try {
    const res = await fetch(
      omdbUrl(
        `mode=search&q=${encodeURIComponent(q)}&type=${encodeURIComponent(type || "all")}`
      )
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.imdbStatus = data.error || data.hint || `IMDb error ${res.status}`;
      return [];
    }
    state.imdbStatus = "";
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    state.imdbStatus = "IMDb search unavailable (is /api/omdb deployed with OMDB_API_KEY?)";
    console.warn(err);
    return [];
  }
}

async function fetchImdbTitle(imdbID) {
  const id = String(imdbID || "").replace(/^imdb:/i, "");
  if (!id) return null;
  const cached = state.remoteById[`imdb:${id}`];
  if (cached?.description || cached?.genres?.length) return cached;
  const res = await fetch(omdbUrl(`mode=title&id=${encodeURIComponent(id)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.item) throw new Error(data.error || "Title not found on IMDb");
  cacheRemoteItem(data.item);
  return data.item;
}

function searchCatalog(query, type = "all", limit = 40) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  let list = catalog();
  if (type !== "all") list = list.filter((x) => x.type === type);
  if (!q) return list.slice(0, limit);
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  return list
    .map((x) => {
      const hay = [
        x.title,
        x.author,
        x.why,
        x.posterQuery,
        x.id,
        ...(x.genres || []),
        ...(x.vibe || []),
      ]
        .join(" ")
        .toLowerCase();
      // full phrase match scores highest; also match each word (shawshank → The Shawshank Redemption)
      let score = 0;
      if (hay.includes(q)) score += 10;
      tokens.forEach((t) => {
        if (hay.includes(t)) score += 3;
        if ((x.title || "").toLowerCase().includes(t)) score += 2;
      });
      return { x, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.x);
}

/* ---------- posters ---------- */

function loadPosterCache() {
  try {
    state.posterCache = JSON.parse(localStorage.getItem(POSTER_CACHE_KEY) || "{}") || {};
  } catch {
    state.posterCache = {};
  }
  try {
    state.posterFail = JSON.parse(localStorage.getItem(POSTER_FAIL_KEY) || "{}") || {};
  } catch {
    state.posterFail = {};
  }
}

function savePosterCache() {
  try {
    const keys = Object.keys(state.posterCache);
    // cap cache size
    if (keys.length > 300) {
      keys.slice(0, keys.length - 300).forEach((k) => delete state.posterCache[k]);
    }
    localStorage.setItem(POSTER_CACHE_KEY, JSON.stringify(state.posterCache));
  } catch {
    /* quota — ignore */
  }
}

function savePosterFail() {
  try {
    localStorage.setItem(POSTER_FAIL_KEY, JSON.stringify(state.posterFail || {}));
  } catch {
    /* ignore */
  }
}

function posterInitial(item) {
  const t = String(item?.title || "?").trim();
  return (t[0] || "?").toUpperCase();
}

function posterTone(type) {
  return type === "movie" ? "ph-movie" : type === "tv" ? "ph-tv" : "ph-book";
}

/** Soft skeleton while art loads — looks intentional, not broken. */
function posterSkeletonHtml(item, size = "md") {
  const tone = posterTone(item.type);
  return `<div class="poster-skel ${tone} ${size}" aria-hidden="true">
    <span class="skel-shimmer"></span>
    <span class="skel-letter">${escapeHtml(posterInitial(item))}</span>
  </div>`;
}

function posterFinalPlaceholder(item, size = "md") {
  const tone = posterTone(item.type);
  return `<div class="poster-ph ${tone} ${size}" role="img" aria-label="Cover unavailable">
    <span class="skel-letter static">${escapeHtml(posterInitial(item))}</span>
    <span class="poster-none-label">No cover</span>
  </div>`;
}

function posterAttrs(item) {
  return `data-poster-id="${escapeHtml(item.id)}" data-poster-type="${escapeHtml(
    item.type || "movie"
  )}" data-poster-title="${escapeHtml(item.title || "")}" data-poster-query="${escapeHtml(
    item.posterQuery || item.title || ""
  )}" data-poster-isbn="${escapeHtml(item.isbn || "")}" data-poster-author="${escapeHtml(
    item.author || ""
  )}" data-poster-wiki="${escapeHtml(item.wiki || "")}" data-poster-year="${escapeHtml(
    item.year != null ? String(item.year) : ""
  )}"`;
}

function posterHtml(item, size = "md") {
  const cached = state.posterCache[item.id];
  let src = cached || item.poster || "";
  if (src) src = String(src).split("?")[0];
  // Known-bad URL in fail map — show soft placeholder, still allow hydrate retry later
  if (src && state.posterFail[item.id] === src) src = "";

  if (src) {
    return `<div class="poster-slot ${size}" ${posterAttrs(item)}>
      ${posterSkeletonHtml(item, size)}
      <img class="poster ${size} poster-fade" src="${escapeHtml(src)}" alt="" loading="lazy"
        data-poster-id="${escapeHtml(item.id)}"
        onload="this.classList.add('is-loaded');this.previousElementSibling&&this.previousElementSibling.remove();"
        onerror="window.__sequelPosterImgError&&window.__sequelPosterImgError(this,'${escapeHtml(
          item.id
        )}','${escapeHtml(item.type || "movie")}','${escapeHtml(size)}')" />
    </div>`;
  }

  return `<div class="poster-slot ${size} poster-loading" ${posterAttrs(item)}>
    ${posterSkeletonHtml(item, size)}
  </div>`;
}

window.__sequelPosterFallback = function (id, type, size) {
  const item = catalogById(id) || resolveItem(id) || { id, type, title: "?" };
  const wrap = document.createElement("div");
  wrap.className = `poster-slot ${size || "md"}`;
  wrap.innerHTML = posterFinalPlaceholder(item, size || "md");
  return wrap;
};

window.__sequelMarkPosterFail = function (id, url) {
  if (!id) return;
  state.posterFail[id] = url || true;
  if (state.posterCache[id] && (!url || state.posterCache[id] === url)) {
    delete state.posterCache[id];
    savePosterCache();
  }
  savePosterFail();
};

/** Broken img → try live resolve once, then soft placeholder. */
window.__sequelPosterImgError = function (img, id, type, size) {
  const bad = img.getAttribute("src") || "";
  window.__sequelMarkPosterFail(id, bad);
  const slot = img.closest(".poster-slot") || img.parentNode;
  const item =
    catalogById(id) ||
    resolveItem(id) || {
      id,
      type,
      title: img.getAttribute("data-poster-title") || "",
    };
  resolvePosterUrl(item, { force: true })
    .then((url) => {
      if (url && url !== bad) {
        img.onerror = function () {
          if (slot) slot.replaceWith(window.__sequelPosterFallback(id, type, size));
        };
        img.src = url;
        return;
      }
      if (slot) slot.replaceWith(window.__sequelPosterFallback(id, type, size));
    })
    .catch(() => {
      if (slot) slot.replaceWith(window.__sequelPosterFallback(id, type, size));
    });
};

function probeImage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      clearTimeout(t);
      finish(true);
    };
    img.onerror = () => {
      clearTimeout(t);
      finish(false);
    };
    img.src = url;
  });
}

function queryVariants(item) {
  const base = (item.posterQuery || item.title || "").trim();
  const title = (item.title || "").trim();
  const year = item.year ? String(item.year) : "";
  const set = new Set();
  [base, title, `${title} ${year}`, `${base} ${year}`, title.replace(/&/g, "and"), base.replace(/&/g, "and")]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .forEach((s) => set.add(s));
  return [...set];
}

function upscaleItunesArt(url) {
  if (!url) return "";
  return String(url)
    .replace(/100x100bb/g, "600x600bb")
    .replace(/60x60bb/g, "600x600bb")
    .replace(/200x200bb/g, "600x600bb");
}

async function fetchItunesArtwork(query, entity) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    query
  )}&entity=${entity}&limit=8&country=us`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  const results = data.results || [];
  // Prefer tracks/collections whose name roughly matches
  const q = query.toLowerCase();
  const scored = results
    .map((r) => {
      const name = String(r.trackName || r.collectionName || r.artistName || "").toLowerCase();
      let score = 0;
      if (name.includes(q.slice(0, 12).toLowerCase())) score += 3;
      q.split(/\s+/).forEach((w) => {
        if (w.length > 2 && name.includes(w)) score += 1;
      });
      if (r.artworkUrl100 || r.artworkUrl60) score += 1;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);
  const hit = (scored[0] && scored[0].score > 0 ? scored[0].r : null) || results[0];
  if (!hit) return "";
  return upscaleItunesArt(hit.artworkUrl100 || hit.artworkUrl60 || "");
}

async function fetchOpenLibraryCover(item) {
  // Prefer cover_i from search — more reliable than ISBN CDN (which 404s often)
  const q = item.posterQuery || item.title;
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}${
    item.author ? `&author=${encodeURIComponent(item.author)}` : ""
  }&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  const doc = (data.docs || []).find((d) => d.cover_i) || null;
  if (doc?.cover_i) {
    return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  }
  if (item.isbn) {
    return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(item.isbn)}-L.jpg`;
  }
  return "";
}

/** Wikipedia page summary often has a free thumbnail (CORS ok). */
async function fetchWikipediaThumb(titles) {
  for (const title of titles) {
    if (!title) continue;
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        title.replace(/ /g, "_")
      )}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      const src = data.thumbnail?.source || data.originalimage?.source || "";
      if (src) return src.replace(/\/\d+px-/, "/500px-");
    } catch {
      /* try next */
    }
  }
  return "";
}

function wikiTitleCandidates(item) {
  const t = item.title || "";
  const y = item.year;
  const list = [];
  if (item.wiki) list.push(item.wiki);
  if (item.type === "movie") {
    list.push(`${t} (${y} film)`, `${t} (film)`, t);
  } else if (item.type === "tv") {
    list.push(`${t} (TV series)`, `${t} (American TV series)`, `${t} (TV series)`, t);
  } else {
    list.push(`${t} (novel)`, `${t} (book)`, t);
    if (item.author) list.push(`${t} (${item.author} novel)`);
  }
  return [...new Set(list.filter(Boolean))];
}

async function resolvePosterUrl(item, { force = false } = {}) {
  if (!item?.id) return "";
  if (!force && state.posterCache[item.id]) {
    const cached = state.posterCache[item.id];
    if (state.posterFail[item.id] !== cached) return cached;
  }

  const remember = async (url) => {
    if (!url) return "";
    if (state.posterFail[item.id] === url) return "";
    const ok = await probeImage(url);
    if (!ok) {
      state.posterFail[item.id] = url;
      savePosterFail();
      return "";
    }
    state.posterCache[item.id] = url;
    if (state.posterFail[item.id]) {
      delete state.posterFail[item.id];
      savePosterFail();
    }
    savePosterCache();
    return url;
  };

  try {
    // 0) Catalog-provided URL (probe — some wiki links 404)
    if (item.poster && (force || state.posterFail[item.id] !== item.poster)) {
      const ok = await remember(item.poster);
      if (ok) return ok;
    }

    // 1) Wikipedia thumbnails
    const wiki = await fetchWikipediaThumb(wikiTitleCandidates(item));
    {
      const ok = await remember(wiki);
      if (ok) return ok;
    }

    // 2) Type-specific free APIs with multiple query spellings
    const variants = queryVariants(item);
    if (item.type === "book") {
      const cover = await fetchOpenLibraryCover(item);
      {
        const ok = await remember(cover);
        if (ok) return ok;
      }
      for (const q of variants) {
        const art = await fetchItunesArtwork(q, "ebook");
        const ok = await remember(art);
        if (ok) return ok;
      }
    } else if (item.type === "tv") {
      for (const q of variants) {
        for (const ent of ["tvSeason", "tvShow", "movie"]) {
          const art = await fetchItunesArtwork(q, ent);
          const ok = await remember(art);
          if (ok) return ok;
        }
      }
    } else {
      for (const q of variants) {
        const art = await fetchItunesArtwork(q, "movie");
        const ok = await remember(art);
        if (ok) return ok;
      }
      // TV art sometimes used for cinematic titles
      for (const q of variants.slice(0, 2)) {
        const art = await fetchItunesArtwork(q, "tvSeason");
        const ok = await remember(art);
        if (ok) return ok;
      }
    }

    // 3) Wikipedia looser
    const loose = await fetchWikipediaThumb([item.title, `${item.title} film`, `${item.title} series`]);
    {
      const ok = await remember(loose);
      if (ok) return ok;
    }
  } catch (err) {
    console.warn("poster fetch failed", item.id, err);
  }
  return "";
}

function slotSizeClass(el) {
  const c = el.className || "";
  if (c.includes("lg")) return "lg";
  if (c.includes("sm")) return "sm";
  return "md";
}

async function hydratePosters(root = document) {
  const nodes = root.querySelectorAll(".poster-slot.poster-loading");
  const seen = new Set();
  const queue = [];
  nodes.forEach((el) => {
    const id = el.getAttribute("data-poster-id");
    if (!id || seen.has(id + el.className)) return;
    // Skip if already showing a loaded image
    if (el.querySelector("img.is-loaded")) return;
    // Skip pure final placeholders without loading flag
    if (el.classList.contains("poster-done")) return;
    seen.add(id + el.className);
    const item =
      catalogById(id) ||
      resolveItem(id) || {
        id,
        type: el.getAttribute("data-poster-type") || "movie",
        title: el.getAttribute("data-poster-title") || "",
        posterQuery: el.getAttribute("data-poster-query") || "",
        isbn: el.getAttribute("data-poster-isbn") || "",
        author: el.getAttribute("data-poster-author") || "",
        wiki: el.getAttribute("data-poster-wiki") || "",
        year: el.getAttribute("data-poster-year") || null,
      };
    queue.push({ el, item, size: slotSizeClass(el) });
  });

  // Also catch bare loading divs that aren't slots (legacy)
  root.querySelectorAll("[data-poster-id].poster-loading:not(.poster-slot)").forEach((el) => {
    const id = el.getAttribute("data-poster-id");
    if (!id) return;
    const item =
      catalogById(id) ||
      resolveItem(id) || {
        id,
        type: el.getAttribute("data-poster-type") || "movie",
        title: el.getAttribute("data-poster-title") || "",
        posterQuery: el.getAttribute("data-poster-query") || "",
        isbn: el.getAttribute("data-poster-isbn") || "",
        author: el.getAttribute("data-poster-author") || "",
        wiki: el.getAttribute("data-poster-wiki") || "",
      };
    queue.push({ el, item, size: slotSizeClass(el) });
  });

  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const job = queue[i++];
      if (!job.el.isConnected) continue;
      const url = await resolvePosterUrl(job.item);
      if (!job.el.isConnected) continue;
      if (!url) {
        job.el.classList.remove("poster-loading");
        job.el.classList.add("poster-done");
        job.el.innerHTML = posterFinalPlaceholder(job.item, job.size);
        continue;
      }
      const size = job.size;
      const img = document.createElement("img");
      img.className = `poster ${size} poster-fade`;
      img.alt = "";
      img.loading = "lazy";
      img.dataset.posterId = job.item.id;
      img.onload = () => {
        img.classList.add("is-loaded");
        job.el.querySelector(".poster-skel")?.remove();
      };
      img.onerror = () => {
        window.__sequelPosterImgError(img, job.item.id, job.item.type, size);
      };
      img.src = url;
      job.el.classList.remove("poster-loading");
      // keep skeleton until load
      if (!job.el.querySelector(".poster-skel")) {
        job.el.insertAdjacentHTML("afterbegin", posterSkeletonHtml(job.item, size));
      }
      job.el.querySelectorAll("img").forEach((n) => n.remove());
      job.el.appendChild(img);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ---------- storage (per-user) ---------- */

function defaultProfile() {
  return {
    birthYear: null,
    maxRating: "PG-13",
    streaming: [],
    onboardingDone: false,
  };
}

function defaultLibrary() {
  return { items: [], dismissed: [], version: 1, profile: defaultProfile() };
}

function normalizeProfile(p) {
  const base = defaultProfile();
  if (!p || typeof p !== "object") return base;
  const year = p.birthYear != null ? Number(p.birthYear) : null;
  const maxRating = CONTENT_RATING_LEVEL[p.maxRating] != null ? p.maxRating : "PG-13";
  const streaming = Array.isArray(p.streaming)
    ? p.streaming.map(String).filter((s) => STREAMING_LABELS[s])
    : [];
  return {
    birthYear: year && year >= 1920 && year <= 2020 ? year : null,
    maxRating,
    streaming,
    onboardingDone: !!p.onboardingDone,
  };
}

function load() {
  try {
    const key = userStorageKey();
    let raw = localStorage.getItem(key);
    // one-time migrate pre-account library into current user
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy && meId()) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        raw = legacy;
      }
    }
    if (!raw) return defaultLibrary();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.items)) data.items = [];
    if (!Array.isArray(data.dismissed)) data.dismissed = [];
    data.profile = normalizeProfile(data.profile);
    return data;
  } catch {
    return defaultLibrary();
  }
}

function save(data) {
  const id = meId();
  if (!id) return;
  if (!data.profile) data.profile = defaultProfile();
  else data.profile = normalizeProfile(data.profile);
  localStorage.setItem(userStorageKey(id), JSON.stringify(data));
  scheduleCloudLibraryPush();
}

function getProfile() {
  return normalizeProfile(load().profile);
}

function userAge(profile = getProfile()) {
  if (!profile.birthYear) return null;
  const now = new Date().getFullYear();
  return Math.max(0, now - profile.birthYear);
}

function profileNeedsOnboarding(profile = getProfile()) {
  if (profile.onboardingDone) return false;
  // Need at least birth year + max rating chosen once
  return !profile.birthYear;
}

function update(fn) {
  const data = load();
  fn(data);
  save(data);
  return data;
}

function scheduleCloudLibraryPush() {
  if (!readCloudToken() || !meId() || meId() === "guest-local") return;
  clearTimeout(state.cloudSyncTimer);
  state.cloudSyncTimer = setTimeout(() => {
    pushLibraryToCloud().catch((err) => console.warn("Cloud library push failed", err));
  }, 600);
}

async function pushLibraryToCloud() {
  const token = readCloudToken();
  if (!token || meId() === "guest-local") return;
  const data = load();
  await cloudFetch("/api/library", {
    method: "POST",
    body: {
      token,
      library: {
        items: data.items,
        dismissed: data.dismissed || [],
        profile: data.profile || defaultProfile(),
      },
    },
  });
}

async function pullLibraryFromCloud() {
  const token = readCloudToken();
  if (!token || meId() === "guest-local") return null;
  try {
    const res = await cloudFetch(`/api/library?token=${encodeURIComponent(token)}`, {
      method: "GET",
    });
    if (res.library && Array.isArray(res.library.items)) {
      const local = load();
      const cloudItems = res.library.items;
      const cloudProfile = res.library.profile
        ? normalizeProfile(res.library.profile)
        : null;
      const cloudDismissed = Array.isArray(res.library.dismissed)
        ? res.library.dismissed
        : [];
      const mergeDismissed = [
        ...new Set([...(local.dismissed || []), ...cloudDismissed]),
      ].slice(-500);
      // Prefer cloud if it has more (or equal) items, else keep local and push
      if (cloudItems.length >= local.items.length) {
        save({
          items: cloudItems,
          dismissed: mergeDismissed,
          version: 1,
          profile: cloudProfile || local.profile || defaultProfile(),
        });
        clearTimeout(state.cloudSyncTimer);
      } else if (local.items.length > cloudItems.length) {
        // still merge profile from cloud if local never finished onboarding
        if (cloudProfile?.onboardingDone && !local.profile?.onboardingDone) {
          update((d) => {
            d.profile = cloudProfile;
            d.dismissed = mergeDismissed;
          });
        } else {
          update((d) => {
            d.dismissed = mergeDismissed;
          });
        }
        await pushLibraryToCloud();
      } else if (cloudProfile?.onboardingDone) {
        update((d) => {
          d.profile = cloudProfile;
          d.dismissed = mergeDismissed;
        });
        clearTimeout(state.cloudSyncTimer);
      }
      return res.library;
    }
  } catch (err) {
    console.warn("Cloud library pull failed", err);
  }
  return null;
}

function applyCloudLibrary(library) {
  if (!library || !Array.isArray(library.items)) return;
  const key = userStorageKey();
  const local = load();
  const profile = library.profile
    ? normalizeProfile(library.profile)
    : local.profile || defaultProfile();
  localStorage.setItem(
    key,
    JSON.stringify({ items: library.items, version: 1, profile })
  );
}

/** After login: prefer richer library; upload local if cloud is empty. */
function mergeCloudLibraryOnLogin(library) {
  const cloudItems = Array.isArray(library?.items) ? library.items : [];
  const local = load();
  const cloudProfile = library?.profile ? normalizeProfile(library.profile) : null;
  if (cloudItems.length === 0 && local.items.length > 0) {
    if (cloudProfile?.onboardingDone && !local.profile?.onboardingDone) {
      update((d) => {
        d.profile = cloudProfile;
      });
    }
    scheduleCloudLibraryPush();
    return;
  }
  if (cloudItems.length >= local.items.length) {
    applyCloudLibrary({
      items: cloudItems,
      profile: cloudProfile || local.profile,
    });
    return;
  }
  // local has more entries for this account — keep and push
  if (cloudProfile?.onboardingDone && !local.profile?.onboardingDone) {
    update((d) => {
      d.profile = cloudProfile;
    });
  }
  scheduleCloudLibraryPush();
}

/**
 * Infer approximate content rating when catalog has no official label.
 * Used only for filtering — not legal ratings.
 */
function inferContentRating(item) {
  if (!item) return "PG-13";
  if (item.contentRating && CONTENT_RATING_LEVEL[item.contentRating] != null) {
    return item.contentRating;
  }
  if (item.type === "book") return "G"; // books not filtered by movie ratings

  const genres = (item.genres || []).map((g) => String(g).toLowerCase());
  const text = `${item.why || ""} ${item.description || ""} ${item.title || ""}`.toLowerCase();
  const vibe = (item.vibe || []).map((v) => String(v).toLowerCase());

  if (/\br[- ]?rated\b|\bnc-17\b|\bexplicit\b/.test(text)) return "R";
  if (genres.includes("horror") || genres.includes("erotic")) return "R";
  if (vibe.includes("sexy") || vibe.includes("brutal") || vibe.includes("raw")) {
    if (genres.includes("family") || genres.includes("animation")) return "PG-13";
    return "R";
  }
  if (
    genres.includes("family") ||
    (genres.includes("animation") && !genres.includes("horror") && !genres.includes("dark"))
  ) {
    return genres.includes("teen") ? "PG" : "G";
  }
  if (genres.includes("ya") || genres.includes("teen") || genres.includes("kids")) {
    return "PG-13";
  }
  if (genres.includes("crime") || genres.includes("thriller") || genres.includes("war")) {
    return "R";
  }
  // Default: mainstream cinema / TV
  return "PG-13";
}

function allowedByMaxRating(item, maxRating) {
  if (!maxRating || maxRating === "any") return true;
  if (item?.type === "book") return true;
  const cap = CONTENT_RATING_LEVEL[maxRating] ?? CONTENT_RATING_LEVEL["PG-13"];
  const level = CONTENT_RATING_LEVEL[inferContentRating(item)] ?? 2;
  return level <= cap;
}

function streamingBoostFor(item, streaming = []) {
  if (!streaming?.length || streaming.includes("none")) return 0;
  let boost = 0;
  const genres = new Set((item.genres || []).map(String));
  const vibes = new Set((item.vibe || []).map(String));
  streaming.forEach((svc) => {
    const taste = STREAMING_TASTE[svc];
    if (!taste) return;
    taste.genres.forEach((g) => {
      if (genres.has(g)) boost += 0.35;
    });
    taste.vibe.forEach((v) => {
      if (vibes.has(v)) boost += 0.25;
    });
  });
  return Math.min(boost, 2.5);
}

function ageBoostFor(item, age) {
  if (age == null) return 0;
  const genres = (item.genres || []).map(String);
  if (age < 13) {
    if (genres.some((g) => ["family", "animation", "kids", "ya", "teen"].includes(g))) return 0.8;
    if (genres.some((g) => ["horror", "crime", "erotic"].includes(g))) return -2;
  } else if (age < 17) {
    if (genres.some((g) => ["ya", "teen", "superhero", "adventure", "scifi"].includes(g))) {
      return 0.45;
    }
  } else if (age >= 30) {
    if (genres.some((g) => ["drama", "biography", "history", "literary"].includes(g))) {
      return 0.25;
    }
  }
  return 0;
}

function libraryMap() {
  const map = new Map();
  load().items.forEach((it) => map.set(it.id, it));
  return map;
}

function ratedCount() {
  return load().items.filter((x) => x.rating > 0).length;
}

/* ---------- recommendations ---------- */

/**
 * Score unwatched catalog items from genres/vibes of highly rated titles.
 * Penalize genres from low ratings. Boost same type as loved items.
 * Returns { item, score, matched, becauseTitles, becauseText }.
 */
function recommend(typeFilter = "all", limit = 12) {
  const data = load();
  const lib = data.items;
  const profile = normalizeProfile(data.profile);
  const age = userAge(profile);
  const owned = new Set(lib.map((x) => x.id));
  const dismissed = new Set(data.dismissed || []);

  const genreScore = new Map();
  const vibeScore = new Map();
  const typeBoost = { movie: 0, tv: 0, book: 0 };
  /** Loved entries for “Because you liked…” */
  const lovedItems = [];

  // Seed taste from streaming services even before ratings
  (profile.streaming || []).forEach((svc) => {
    const taste = STREAMING_TASTE[svc];
    if (!taste) return;
    taste.genres.forEach((g) => genreScore.set(g, (genreScore.get(g) || 0) + 0.55));
    taste.vibe.forEach((v) => vibeScore.set(v, (vibeScore.get(v) || 0) + 0.4));
  });
  if (age != null && age < 13) {
    ["family", "animation", "adventure", "ya"].forEach((g) => {
      genreScore.set(g, (genreScore.get(g) || 0) + 0.7);
    });
  }

  lib.forEach((entry) => {
    const item = resolveItem(entry.id);
    if (!item) return;
    const rating = Number(entry.rating) || 0;
    if (entry.status === "want") return;
    // weight: 5★ = +3, 4★ = +2, 3★ = +0.5, 2★ = -1.5, 1★ = -3, dropped = -2
    let w = 0;
    if (entry.status === "dropped") w = -2;
    else if (rating >= 5) w = 3;
    else if (rating >= 4) w = 2;
    else if (rating >= 3) w = 0.5;
    else if (rating === 2) w = -1.5;
    else if (rating === 1) w = -3;
    else return;

    if (rating >= 4 && entry.status !== "dropped") {
      lovedItems.push({ item, rating, entry });
    }

    typeBoost[item.type] = (typeBoost[item.type] || 0) + w;
    (item.genres || []).forEach((g) => {
      genreScore.set(g, (genreScore.get(g) || 0) + w);
    });
    (item.vibe || []).forEach((v) => {
      vibeScore.set(v, (vibeScore.get(v) || 0) + w);
    });
  });

  lovedItems.sort((a, b) => b.rating - a.rating);

  const hasTaste =
    [...genreScore.values()].some((v) => v > 0) ||
    [...vibeScore.values()].some((v) => v > 0);

  if (!hasTaste) {
    return [];
  }

  const topGenres = [...genreScore.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);

  function becauseFor(candidate) {
    const cGenres = new Set(candidate.genres || []);
    const cVibe = new Set(candidate.vibe || []);
    const hits = [];
    for (const { item: loved } of lovedItems) {
      const overlap =
        (loved.genres || []).some((g) => cGenres.has(g)) ||
        (loved.vibe || []).some((v) => cVibe.has(v)) ||
        loved.type === candidate.type;
      if (overlap) hits.push(loved.title);
      if (hits.length >= 2) break;
    }
    if (hits.length) {
      return {
        becauseTitles: hits,
        becauseText:
          hits.length === 1
            ? `Because you liked ${hits[0]}`
            : `Because you liked ${hits[0]} and ${hits[1]}`,
      };
    }
    if (topGenres.length) {
      const g = (candidate.genres || []).filter((x) => topGenres.includes(x)).slice(0, 2);
      if (g.length) {
        return {
          becauseTitles: [],
          becauseText: `Because you like ${g.join(" · ")}`,
          matched: g,
        };
      }
    }
    if (profile.streaming?.length && !profile.streaming.includes("none")) {
      const label = STREAMING_LABELS[profile.streaming[0]] || "your services";
      return {
        becauseTitles: [],
        becauseText: `Fits what you stream (${label})`,
        matched: [],
      };
    }
    return { becauseTitles: [], becauseText: "Picked for your taste", matched: [] };
  }

  let candidates = catalog().filter(
    (c) =>
      !owned.has(c.id) &&
      !dismissed.has(c.id) &&
      !c.comingSoon &&
      allowedByMaxRating(c, profile.maxRating)
  );
  if (typeFilter !== "all") candidates = candidates.filter((c) => c.type === typeFilter);

  const scored = candidates
    .map((c) => {
      let score = 0;
      const matched = [];
      (c.genres || []).forEach((g) => {
        const s = genreScore.get(g) || 0;
        if (s) {
          score += s;
          if (s > 0) matched.push(g);
        }
      });
      (c.vibe || []).forEach((v) => {
        const s = vibeScore.get(v) || 0;
        if (s) {
          score += s * 0.85;
          if (s > 0 && !matched.includes(v)) matched.push(v);
        }
      });
      score += (typeBoost[c.type] || 0) * 0.15;
      score += streamingBoostFor(c, profile.streaming);
      score += ageBoostFor(c, age);
      // slight popularity bias for seed variety
      score += c.year && c.year >= 2015 ? 0.15 : 0;
      const because = becauseFor(c);
      return {
        item: c,
        score,
        matched: matched.slice(0, 4),
        becauseTitles: because.becauseTitles,
        becauseText: because.becauseText,
      };
    })
    .filter((x) => x.score > 0.6)
    .sort((a, b) => b.score - a.score);

  // diversify types a bit if "all"
  const out = [];
  const typeCount = { movie: 0, tv: 0, book: 0 };
  for (const row of scored) {
    if (out.length >= limit) break;
    if (typeFilter === "all") {
      const t = row.item.type;
      if (typeCount[t] >= Math.ceil(limit / 2) && out.length < limit - 1) {
        // soft cap — skip if other types still available later
        const remaining = scored.slice(scored.indexOf(row) + 1);
        if (remaining.some((r) => typeCount[r.item.type] < typeCount[t])) continue;
      }
      typeCount[t] += 1;
    }
    out.push(row);
  }

  // if still empty but user has ratings, show soft genre matches from topGenres
  if (!out.length && topGenres.length) {
    return candidates
      .filter((c) => (c.genres || []).some((g) => topGenres.includes(g)))
      .slice(0, limit)
      .map((c) => {
        const because = becauseFor(c);
        return {
          item: c,
          score: 1,
          matched: (c.genres || []).filter((g) => topGenres.includes(g)).slice(0, 3),
          becauseTitles: because.becauseTitles,
          becauseText: because.becauseText,
        };
      });
  }

  return out;
}

function dismissRecommendation(id) {
  if (!id) return;
  update((d) => {
    if (!Array.isArray(d.dismissed)) d.dismissed = [];
    if (!d.dismissed.includes(id)) d.dismissed.push(id);
    // cap list
    if (d.dismissed.length > 500) d.dismissed = d.dismissed.slice(-400);
  });
  renderRecs();
}

/** One-tap Want to watch/read — no dialog. */
function quickWant(id) {
  const item = resolveItem(id);
  if (!item) return;
  update((d) => {
    const now = new Date().toISOString();
    const existing = d.items.find((x) => x.id === id);
    const payload = {
      id,
      imdbID: item.imdbID || (String(id).startsWith("imdb:") ? id.slice(5) : ""),
      type: item.type,
      title: item.title,
      year: item.year || null,
      author: item.author || "",
      genres: item.genres || [],
      vibe: item.vibe || [],
      why: item.why || "",
      description: item.description || "",
      poster: item.poster || state.posterCache[id] || "",
      status: "want",
      rating: existing?.rating || 0,
      note: existing?.note || "",
      updatedAt: now,
      createdAt: existing?.createdAt || now,
      custom: !!item.custom,
      source: item.source || (item.custom ? "custom" : "local"),
    };
    if (existing) Object.assign(existing, payload);
    else d.items.push(payload);
  });
  showToast(`Saved “${item.title}” to Want`);
  if (state.panel === "home") renderHome();
  else if (state.panel === "browse") renderBrowse();
  else if (state.panel === "foryou") renderRecs();
  else if (state.panel === "library") renderLibrary();
  updateStat();
}

function showToast(msg) {
  let el = document.getElementById("sequel-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "sequel-toast";
    el.className = "sequel-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- render ---------- */

function updateStat() {
  const el = document.getElementById("lib-stat");
  if (!el) return;
  const n = ratedCount();
  const total = load().items.length;
  el.textContent = n ? `${n} rated` : total ? `${total} logged` : "0 rated";
}

function showPanel(name) {
  state.panel = name;
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  document.querySelectorAll(".tab").forEach((t) => {
    // profile is not a tab — clear tab highlight when on profile
    t.classList.toggle("active", name !== "profile" && t.dataset.nav === name);
  });
  if (name === "home") renderHome();
  if (name === "foryou") renderRecs();
  if (name === "library") renderLibrary();
  if (name === "browse") renderBrowse();
  if (name === "profile") renderProfile();
}

function renderProfile() {
  const user = currentUser();
  const profile = getProfile();
  const age = userAge(profile);
  const lib = load();

  const nameEl = document.getElementById("profile-name");
  const handleEl = document.getElementById("profile-handle");
  const avatarEl = document.getElementById("profile-avatar");

  if (nameEl) nameEl.textContent = user?.name || user?.handle || "You";
  if (handleEl) {
    handleEl.textContent = user?.isGuest ? "guest" : `@${user?.handle || "you"}`;
  }
  if (avatarEl) {
    const seed = (user?.name || user?.handle || "S").trim();
    avatarEl.textContent = (seed[0] || "S").toUpperCase();
  }

  const ratedEl = document.getElementById("profile-stat-rated");
  const loggedEl = document.getElementById("profile-stat-logged");
  const ageEl = document.getElementById("profile-stat-age");
  if (ratedEl) ratedEl.textContent = String(lib.items.filter((x) => x.rating > 0).length);
  if (loggedEl) loggedEl.textContent = String(lib.items.length);
  if (ageEl) ageEl.textContent = age != null ? String(age) : "—";

  const birthEl = document.getElementById("profile-birth");
  const maxEl = document.getElementById("profile-max-rating");
  const streamEl = document.getElementById("profile-streaming");

  if (birthEl) {
    birthEl.textContent = profile.birthYear
      ? `${profile.birthYear}${age != null ? ` (age ${age})` : ""}`
      : "Not set";
  }
  if (maxEl) {
    maxEl.textContent =
      profile.maxRating === "any" ? "Any" : profile.maxRating || "Not set";
  }
  if (streamEl) {
    streamEl.textContent = profile.streaming?.length
      ? profile.streaming.map((s) => STREAMING_LABELS[s] || s).join(", ")
      : "Not set";
  }
}

/** Prefer 2025+ titles; exclude unreleased “coming soon” from New rows. */
function newReleases(type, limit = 12) {
  const nowYear = new Date().getFullYear();
  const cutoff = Math.max(2025, nowYear - 1);
  return catalog()
    .filter(
      (c) =>
        c.type === type &&
        !c.comingSoon &&
        (c.newRelease || (c.year && c.year >= cutoff))
    )
    .sort((a, b) => {
      const da = a.releaseDate || `${a.year || 0}-01-01`;
      const db = b.releaseDate || `${b.year || 0}-01-01`;
      return db.localeCompare(da) || (b.year || 0) - (a.year || 0);
    })
    .slice(0, limit);
}

function comingSoonPicks(limit = 14) {
  const today = new Date().toISOString().slice(0, 10);
  return catalog()
    .filter((c) => {
      if (c.comingSoon) return !c.releaseDate || c.releaseDate >= today;
      // auto: dated future titles not yet marked released
      return !!(c.releaseDate && c.releaseDate > today);
    })
    .sort((a, b) => {
      const da = a.releaseDate || "9999-12-31";
      const db = b.releaseDate || "9999-12-31";
      return da.localeCompare(db);
    })
    .slice(0, limit);
}

function formatReleaseLabel(item) {
  if (!item.releaseDate) return item.year ? String(item.year) : "";
  try {
    const d = new Date(`${item.releaseDate}T12:00:00`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return item.releaseDate;
  }
}

function trendingPicks(limit = 12) {
  // Popular evergreen + recent mix (skip pure coming-soon placeholders)
  return catalog()
    .filter((c) => !c.comingSoon)
    .slice()
    .sort((a, b) => {
      const sa = (a.newRelease ? 20 : 0) + (a.year || 0) / 1000;
      const sb = (b.newRelease ? 20 : 0) + (b.year || 0) / 1000;
      return sb - sa;
    })
    .slice(0, limit);
}

function posterTileHtml(item) {
  const map = libraryMap();
  const entry = map.get(item.id);
  let badge = "";
  if (entry?.rating) {
    badge = `<span class="tile-badge stars">${starsText(entry.rating)}</span>`;
  } else if (entry?.status === "want") {
    badge = `<span class="tile-badge want">Want</span>`;
  } else if (item.comingSoon) {
    badge = `<span class="tile-badge soon">Soon</span>`;
  } else if (item.newRelease || (item.year && item.year >= new Date().getFullYear())) {
    badge = `<span class="tile-badge new">New</span>`;
  }
  const meta = item.comingSoon
    ? [formatReleaseLabel(item) || item.year, typeLabel(item.type)].filter(Boolean).join(" · ")
    : [item.year, typeLabel(item.type)].filter(Boolean).join(" · ");
  const wantLabel =
    item.type === "book" ? "Want" : item.type === "tv" ? "Want" : "Want";
  return `
    <div class="poster-tile">
      <div class="poster-frame">
        <button type="button" class="poster-tile-hit" data-open-rate="${escapeHtml(
          item.id
        )}" aria-label="Rate ${escapeHtml(item.title)}">
          ${posterHtml(item, "lg")}
          ${badge}
        </button>
        <div class="tile-quick" role="group" aria-label="Quick actions">
          <button type="button" class="tile-qbtn" data-quick-want="${escapeHtml(
            item.id
          )}" ${entry?.status === "want" ? "disabled" : ""}>${
            entry?.status === "want" ? "Saved" : wantLabel
          }</button>
          <button type="button" class="tile-qbtn primary" data-open-rate="${escapeHtml(
            item.id
          )}">Rate</button>
        </div>
      </div>
      <button type="button" class="tile-title-btn" data-open-rate="${escapeHtml(item.id)}">
        <span class="tile-title">${escapeHtml(item.title)}</span>
        <span class="tile-meta">${escapeHtml(meta)}</span>
      </button>
      <button type="button" class="desc-link tile-desc" data-full-desc="${escapeHtml(
        item.id
      )}">Full description</button>
    </div>
  `;
}

function renderHome() {
  const movies = document.getElementById("rail-movies");
  const coming = document.getElementById("rail-coming-soon");
  const tv = document.getElementById("rail-tv");
  const books = document.getElementById("rail-books");
  const trending = document.getElementById("rail-trending");
  if (movies) movies.innerHTML = newReleases("movie", 16).map(posterTileHtml).join("");
  if (coming) {
    const soon = comingSoonPicks(16);
    coming.innerHTML = soon.length
      ? soon.map(posterTileHtml).join("")
      : `<p class="rail-empty">No upcoming titles queued yet.</p>`;
  }
  if (tv) tv.innerHTML = newReleases("tv", 14).map(posterTileHtml).join("");
  if (books) books.innerHTML = newReleases("book", 14).map(posterTileHtml).join("");
  if (trending) trending.innerHTML = trendingPicks(14).map(posterTileHtml).join("");
  updateStat();
  hydratePosters(document.getElementById("home") || document.querySelector('[data-panel="home"]'));
}

function shortDescription(item) {
  return item.why || item.description || "";
}

function fullDescriptionText(item) {
  if (item.description) return item.description;
  if (item.why) return item.why;
  return `${item.title} is a ${typeLabel(item.type).toLowerCase()} in Sequel’s catalog.`;
}

function mediaCardHtml(item, { mode, entry, rec } = {}) {
  const metaParts = [];
  if (item.year) metaParts.push(item.year);
  if (item.author) metaParts.push(item.author);
  if (entry?.status) metaParts.push(statusLabel(entry.status));
  const tags = [...(item.genres || []).slice(0, 3), ...(item.vibe || []).slice(0, 1)];

  let why = "";
  if (mode === "rec" && rec) {
    if (rec.becauseText) {
      why = escapeHtml(rec.becauseText);
      // bold liked titles inside the sentence
      (rec.becauseTitles || []).forEach((t) => {
        why = why.replace(
          escapeHtml(t),
          `<strong>${escapeHtml(t)}</strong>`
        );
      });
    } else if (rec.matched?.length) {
      why = `Because you like <strong>${escapeHtml(rec.matched.join(", "))}</strong>`;
    }
  } else {
    why = escapeHtml(shortDescription(item));
  }

  const score =
    mode === "rec" && rec
      ? `<span class="match-score">${Math.min(99, Math.round(rec.score * 12))}%</span>`
      : entry?.rating
        ? `<span class="stars-inline" title="Your rating">${starsText(entry.rating)}</span>`
        : "";

  let action = "";
  if (mode === "library") {
    action = `<button type="button" class="btn soft sm" data-open-rate="${escapeHtml(
      item.id
    )}">Edit</button>`;
  } else if (mode === "rec") {
    action = `
      <button type="button" class="btn soft sm" data-quick-want="${escapeHtml(item.id)}">Want</button>
      <button type="button" class="btn soft sm" data-open-rate="${escapeHtml(item.id)}">Rate</button>
      <button type="button" class="btn ghost sm" data-dismiss-rec="${escapeHtml(
        item.id
      )}">Not interested</button>`;
  } else {
    action = `
      <button type="button" class="btn soft sm" data-quick-want="${escapeHtml(item.id)}">Want</button>
      <button type="button" class="btn soft sm" data-open-rate="${escapeHtml(item.id)}">${
        entry ? "Update" : "Rate"
      }</button>`;
  }

  return `
    <article class="m-card" data-rec-id="${escapeHtml(item.id)}">
      <div class="m-card-top">
        <div class="poster-wrap sm">
          ${posterHtml(item, "sm")}
        </div>
        <div class="m-text">
          <h3 class="m-title">${escapeHtml(item.title)}</h3>
          <p class="m-meta">${escapeHtml(metaParts.join(" · ") || typeLabel(item.type))}</p>
        </div>
        ${score}
      </div>
      ${
        why
          ? `<p class="m-why">${why} <button type="button" class="desc-link" data-full-desc="${escapeHtml(
              item.id
            )}">Full description</button></p>`
          : `<p class="m-why"><button type="button" class="desc-link" data-full-desc="${escapeHtml(
              item.id
            )}">Full description</button></p>`
      }
      <div class="tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="row-actions">${action}</div>
    </article>
  `;
}

function statusLabel(s) {
  if (s === "done") return "Finished";
  if (s === "watching") return "In progress";
  if (s === "dropped") return "Dropped";
  if (s === "want") return "Want to";
  return s;
}

function renderRecs() {
  const list = document.getElementById("recs-list");
  const empty = document.getElementById("recs-empty");
  if (!list) return;
  const recs = recommend(state.recType, 15);
  list.innerHTML = recs
    .map((r) => mediaCardHtml(r.item, { mode: "rec", rec: r, entry: libraryMap().get(r.item.id) }))
    .join("");
  empty.hidden = recs.length > 0;
  updateStat();
  hydratePosters(list);
}

function isWantEntry(entry) {
  // Pure want-list: status want and no meaningful rating yet
  return entry?.status === "want" && !(Number(entry.rating) > 0);
}

function renderLibrary() {
  const wantList = document.getElementById("library-want-list");
  const loggedList = document.getElementById("library-list");
  const wantSection = document.getElementById("lib-want-section");
  const loggedSection = document.getElementById("lib-logged-section");
  const empty = document.getElementById("library-empty");
  const wantCountEl = document.getElementById("lib-want-count");
  const loggedCountEl = document.getElementById("lib-logged-count");
  if (!wantList || !loggedList) return;

  let items = load().items.slice();
  if (state.libType !== "all") {
    items = items.filter((e) => {
      const it = resolveItem(e.id);
      return it && it.type === state.libType;
    });
  }

  const wants = items
    .filter(isWantEntry)
    .sort((a, b) =>
      (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
    );
  const logged = items
    .filter((e) => !isWantEntry(e))
    .sort((a, b) =>
      (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
    );

  const card = (entry) => {
    const item = resolveItem(entry.id);
    if (!item) return "";
    return mediaCardHtml(item, { mode: "library", entry });
  };

  wantList.innerHTML = wants.map(card).join("");
  loggedList.innerHTML = logged.map(card).join("");

  if (wantSection) wantSection.hidden = wants.length === 0;
  if (loggedSection) loggedSection.hidden = logged.length === 0;
  if (wantCountEl) wantCountEl.textContent = String(wants.length);
  if (loggedCountEl) loggedCountEl.textContent = String(logged.length);
  if (empty) empty.hidden = wants.length + logged.length > 0;

  updateStat();
  hydratePosters(wantList);
  hydratePosters(loggedList);
}

function renderBrowse() {
  const list = document.getElementById("browse-list");
  const q = document.getElementById("browse-search")?.value || "";
  if (!list) return;
  const localHits = searchCatalog(q, state.browseType, 24);
  const map = libraryMap();
  const status = state.imdbStatus
    ? `<p class="hint imdb-status">${escapeHtml(state.imdbStatus)}</p>`
    : q.trim().length >= 2 && state.browseType !== "book"
      ? `<p class="hint imdb-status" id="imdb-browse-status">Searching IMDb…</p>`
      : "";
  list.innerHTML =
    status +
    localHits
      .map((item) => mediaCardHtml(item, { mode: "browse", entry: map.get(item.id) }))
      .join("");
  hydratePosters(list);

  // Async IMDb (movies/TV)
  if (q.trim().length >= 2 && state.browseType !== "book") {
    const req = q.trim();
    searchImdb(req, state.browseType).then((remote) => {
      if ((document.getElementById("browse-search")?.value || "").trim() !== req) return;
      const seen = new Set(localHits.map((x) => x.title.toLowerCase() + "|" + (x.year || "")));
      const extra = [];
      remote.forEach((r) => {
        cacheRemoteItem(r);
        const key = r.title.toLowerCase() + "|" + (r.year || "");
        if (seen.has(key)) return;
        seen.add(key);
        extra.push(r);
      });
      const st = document.getElementById("imdb-browse-status");
      if (st) {
        st.textContent = extra.length
          ? `IMDb: ${extra.length} more result${extra.length === 1 ? "" : "s"}`
          : state.imdbStatus || "No extra IMDb hits";
      }
      if (!extra.length) return;
      list.insertAdjacentHTML(
        "beforeend",
        `<p class="section-label">From IMDb</p>` +
          extra
            .map((item) => mediaCardHtml(item, { mode: "browse", entry: map.get(item.id) }))
            .join("")
      );
      hydratePosters(list);
    });
  }
}

/* ---------- rate dialog ---------- */

async function openRateDialog(id) {
  // Hydrate full IMDb details when needed
  if (String(id).startsWith("imdb:")) {
    try {
      await fetchImdbTitle(id);
    } catch (err) {
      console.warn(err);
    }
  }
  const item = resolveItem(id);
  if (!item) return;
  const entry = libraryMap().get(id);
  state.rateDraft = {
    id,
    status: entry?.status || "done",
    rating: entry?.rating || 0,
  };
  document.getElementById("rate-id").value = id;
  document.getElementById("rate-type").textContent = typeLabel(item.type);
  document.getElementById("rate-title").textContent = item.title;
  const meta = [item.year, item.author, item.why].filter(Boolean).join(" · ");
  document.getElementById("rate-meta").textContent = meta;
  // optional poster next to title
  let art = document.getElementById("rate-poster");
  if (!art) {
    art = document.createElement("div");
    art.id = "rate-poster";
    art.className = "rate-poster";
    const title = document.getElementById("rate-title");
    title?.parentNode?.insertBefore(art, title);
  }
  art.innerHTML = posterHtml(item, "sm");
  hydratePosters(art);
  document.getElementById("rate-note").value = entry?.note || "";
  document.querySelectorAll("#rate-dialog [data-status]").forEach((b) => {
    b.classList.toggle("active", b.dataset.status === state.rateDraft.status);
  });
  paintStars(state.rateDraft.rating);
  const remove = document.getElementById("rate-remove");
  if (remove) remove.hidden = !entry;
  document.getElementById("rate-dialog")?.showModal();
}

function paintStars(n) {
  document.querySelectorAll("#rate-stars .star").forEach((s) => {
    const v = Number(s.dataset.star);
    s.classList.toggle("on", v <= n);
  });
  const hint = document.getElementById("rate-hint");
  if (hint) {
    hint.textContent = n
      ? `You rated this ${n}/5`
      : state.rateDraft.status === "want"
        ? "Optional for “Want to”."
        : "Tap a star (helps recommendations a lot).";
  }
}

function saveRating(e) {
  e.preventDefault();
  const id = document.getElementById("rate-id").value;
  const item = resolveItem(id);
  if (!item) return;
  const note = document.getElementById("rate-note").value.trim();
  const { status, rating } = state.rateDraft;
  if (status !== "want" && status !== "dropped" && !rating) {
    alert("Add a star rating (or set status to Want to / Dropped).");
    return;
  }

  update((d) => {
    const now = new Date().toISOString();
    const existing = d.items.find((x) => x.id === id);
    const payload = {
      id,
      imdbID: item.imdbID || (String(id).startsWith("imdb:") ? id.slice(5) : ""),
      type: item.type,
      title: item.title,
      year: item.year || null,
      author: item.author || "",
      genres: item.genres || [],
      vibe: item.vibe || [],
      why: item.why || "",
      description: item.description || "",
      poster: item.poster || state.posterCache[id] || "",
      status,
      rating: rating || 0,
      note,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
      custom: !!item.custom,
      source: item.source || (item.custom ? "custom" : "local"),
    };
    if (existing) Object.assign(existing, payload);
    else d.items.push(payload);
  });

  document.getElementById("rate-dialog")?.close();
  renderRecs();
  renderLibrary();
  renderBrowse();
  updateStat();
}

/* ---------- add custom / search ---------- */

function openAddDialog() {
  document.getElementById("add-search").value = "";
  document.getElementById("add-results").innerHTML = "";
  document.getElementById("custom-title").value = "";
  document.getElementById("custom-genres").value = "";
  state.customType = "movie";
  document.querySelectorAll("[data-custom-type]").forEach((b) => {
    b.classList.toggle("active", b.dataset.customType === "movie");
  });
  document.getElementById("add-dialog")?.showModal();
}

function searchHitHtml(h, badge = "") {
  const poster = h.poster
    ? `<img class="hit-poster" src="${escapeHtml(h.poster)}" alt="" loading="lazy" />`
    : `<div class="hit-poster hit-poster-empty"></div>`;
  return `
      <button type="button" class="search-hit" data-pick="${escapeHtml(h.id)}">
        ${poster}
        <span class="hit-text">
          <strong>${escapeHtml(h.title)}${badge ? ` <em class="hit-badge">${badge}</em>` : ""}</strong>
          <span>${escapeHtml(typeLabel(h.type))}${h.year ? ` · ${h.year}` : ""}${
            h.author ? ` · ${escapeHtml(h.author)}` : ""
          }</span>
        </span>
      </button>`;
}

function renderAddSearch() {
  const q = document.getElementById("add-search")?.value || "";
  const box = document.getElementById("add-results");
  if (!box) return;
  if (!q.trim()) {
    box.innerHTML = "";
    return;
  }
  const hits = searchCatalog(q, "all", 10);
  box.innerHTML =
    hits.map((h) => searchHitHtml(h)).join("") +
    `<p class="hint" id="add-imdb-status">Searching IMDb…</p>`;

  const req = q.trim();
  searchImdb(req, "all").then((remote) => {
    if ((document.getElementById("add-search")?.value || "").trim() !== req) return;
    const st = document.getElementById("add-imdb-status");
    const seen = new Set(hits.map((h) => h.title.toLowerCase()));
    const extra = [];
    remote.forEach((r) => {
      cacheRemoteItem(r);
      if (seen.has(r.title.toLowerCase())) return;
      seen.add(r.title.toLowerCase());
      extra.push(r);
    });
    if (st) {
      st.textContent = extra.length
        ? `IMDb results (${extra.length})`
        : state.imdbStatus || "No extra IMDb results";
    }
    if (extra.length) {
      box.insertAdjacentHTML(
        "beforeend",
        extra.map((h) => searchHitHtml(h, "IMDb")).join("")
      );
    }
  });
}

function addCustomTitle() {
  const title = document.getElementById("custom-title").value.trim();
  if (!title) {
    alert("Enter a title.");
    return;
  }
  const genres = String(document.getElementById("custom-genres").value || "")
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  const id = `custom-${uid()}`;
  const type = state.customType || "movie";
  // stash as library entry with custom metadata; open rate dialog
  update((d) => {
    const now = new Date().toISOString();
    d.items.push({
      id,
      type,
      title,
      year: null,
      author: "",
      genres: genres.length ? genres : ["general"],
      vibe: [],
      why: "Added by you",
      status: "done",
      rating: 0,
      note: "",
      custom: true,
      createdAt: now,
      updatedAt: now,
    });
  });
  document.getElementById("add-dialog")?.close();
  openRateDialog(id);
  renderLibrary();
}

/* ---------- events ---------- */

function setupNav() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.nav));
  });
  document.querySelectorAll("[data-jump-browse]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.jumpBrowse || "all";
      state.browseType = t;
      document.querySelectorAll("[data-browse-type]").forEach((b) => {
        b.classList.toggle("active", b.dataset.browseType === t);
      });
      showPanel("browse");
    });
  });
}

function setupFilters() {
  document.querySelectorAll("[data-rec-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.recType = btn.dataset.recType;
      document.querySelectorAll("[data-rec-type]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      renderRecs();
    });
  });
  document.querySelectorAll("[data-lib-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libType = btn.dataset.libType;
      document.querySelectorAll("[data-lib-type]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      renderLibrary();
    });
  });
  document.querySelectorAll("[data-browse-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.browseType = btn.dataset.browseType;
      document.querySelectorAll("[data-browse-type]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      renderBrowse();
    });
  });
  document.getElementById("browse-search")?.addEventListener("input", () => {
    renderBrowse();
  });
}

function openFullDescription(id) {
  const item = resolveItem(id);
  if (!item) return;
  const dialog = document.getElementById("desc-dialog");
  if (!dialog) return;
  document.getElementById("desc-type").textContent = typeLabel(item.type);
  document.getElementById("desc-title").textContent = item.title;
  const meta = [item.year, item.author, ...(item.genres || []).slice(0, 4)].filter(Boolean).join(" · ");
  document.getElementById("desc-meta").textContent = meta;
  document.getElementById("desc-short").textContent = shortDescription(item) || "";
  document.getElementById("desc-body").textContent = fullDescriptionText(item);
  const art = document.getElementById("desc-poster");
  if (art) {
    art.innerHTML = posterHtml(item, "md");
    hydratePosters(art);
  }
  const rateBtn = document.getElementById("desc-rate");
  if (rateBtn) rateBtn.dataset.openRate = id;
  dialog.showModal();
}

function setupCards() {
  document.getElementById("main")?.addEventListener("click", (e) => {
    const dismissId = e.target.closest("[data-dismiss-rec]")?.dataset.dismissRec;
    if (dismissId) {
      e.preventDefault();
      e.stopPropagation();
      dismissRecommendation(dismissId);
      showToast("Hidden from For you");
      return;
    }
    const wantId = e.target.closest("[data-quick-want]")?.dataset.quickWant;
    if (wantId) {
      e.preventDefault();
      e.stopPropagation();
      quickWant(wantId);
      return;
    }
    const descId = e.target.closest("[data-full-desc]")?.dataset.fullDesc;
    if (descId) {
      e.preventDefault();
      e.stopPropagation();
      openFullDescription(descId);
      return;
    }
    const id = e.target.closest("[data-open-rate]")?.dataset.openRate;
    if (id) openRateDialog(id);
  });

  document.getElementById("desc-close")?.addEventListener("click", () => {
    document.getElementById("desc-dialog")?.close();
  });
  document.getElementById("desc-done")?.addEventListener("click", () => {
    document.getElementById("desc-dialog")?.close();
  });
  document.getElementById("desc-rate")?.addEventListener("click", (e) => {
    const id = e.currentTarget.dataset.openRate;
    document.getElementById("desc-dialog")?.close();
    if (id) openRateDialog(id);
  });
}

function setupRateDialog() {
  document.getElementById("rate-close")?.addEventListener("click", () => {
    document.getElementById("rate-dialog")?.close();
  });
  document.getElementById("rate-cancel")?.addEventListener("click", () => {
    document.getElementById("rate-dialog")?.close();
  });
  document.getElementById("rate-form")?.addEventListener("submit", saveRating);

  document.querySelectorAll("#rate-dialog [data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.rateDraft.status = btn.dataset.status;
      document.querySelectorAll("#rate-dialog [data-status]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      paintStars(state.rateDraft.rating);
    });
  });

  document.querySelectorAll("#rate-stars .star").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = Number(btn.dataset.star);
      // toggle off if same star
      state.rateDraft.rating = state.rateDraft.rating === v ? 0 : v;
      paintStars(state.rateDraft.rating);
    });
  });

  document.getElementById("rate-remove")?.addEventListener("click", () => {
    const id = document.getElementById("rate-id").value;
    if (!id) return;
    if (!confirm("Remove this title from your library?")) return;
    update((d) => {
      d.items = d.items.filter((x) => x.id !== id);
    });
    document.getElementById("rate-dialog")?.close();
    renderRecs();
    renderLibrary();
    renderBrowse();
    updateStat();
  });
}

function setupAddDialog() {
  document.getElementById("open-add-btn")?.addEventListener("click", openAddDialog);
  document.getElementById("add-close")?.addEventListener("click", () => {
    document.getElementById("add-dialog")?.close();
  });
  document.getElementById("add-cancel")?.addEventListener("click", () => {
    document.getElementById("add-dialog")?.close();
  });
  let t = null;
  document.getElementById("add-search")?.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(renderAddSearch, 80);
  });
  document.getElementById("add-results")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-pick]")?.dataset.pick;
    if (!id) return;
    document.getElementById("add-dialog")?.close();
    openRateDialog(id);
  });
  document.querySelectorAll("[data-custom-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.customType = btn.dataset.customType;
      document.querySelectorAll("[data-custom-type]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
    });
  });
  document.getElementById("custom-save")?.addEventListener("click", addCustomTitle);
}

/* ---------- auth (local + cloud) ---------- */

function readAuthStore() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return { users: [] };
    const data = JSON.parse(raw);
    return { users: Array.isArray(data.users) ? data.users : [] };
  } catch {
    return { users: [] };
  }
}

function writeAuthStore(store) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ users: store.users || [] }));
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.userId || null;
  } catch {
    return null;
  }
}

function writeSession(userId) {
  if (!userId) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify({ userId }));
}

function currentUser() {
  const id = state.currentUserId || readSession();
  if (!id) return null;
  const fromStore = readAuthStore().users.find((u) => u.id === id);
  if (fromStore) return fromStore;
  const cloud = readCloudUser();
  if (cloud?.id === id) return cloud;
  return null;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fallbackHash(password, salt) {
  let h = 2166136261;
  const s = `${salt}:${password}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const parts = [];
  for (let i = 0; i < 8; i += 1) {
    let n = (h ^ (i * 2654435761)) >>> 0;
    parts.push(n.toString(16).padStart(8, "0"));
  }
  return parts.join("");
}

async function hashPassword(password, salt) {
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const enc = new TextEncoder();
      const data = enc.encode(`${salt}:${password}`);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return bytesToHex(digest);
    }
  } catch {
    /* fall through */
  }
  return fallbackHash(password, salt);
}

function normalizeHandle(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function cacheCloudUserLocally(cloudUser, passwordHash, salt) {
  const store = readAuthStore();
  const existing = store.users.find(
    (u) => u.id === cloudUser.id || u.handle === cloudUser.handle
  );
  if (existing) {
    existing.name = cloudUser.name;
    existing.handle = cloudUser.handle;
    existing.id = cloudUser.id;
    if (passwordHash) existing.passwordHash = passwordHash;
    if (salt) existing.salt = salt;
    existing.cloud = true;
  } else {
    store.users.push({
      id: cloudUser.id,
      name: cloudUser.name,
      handle: cloudUser.handle,
      email: cloudUser.email || "",
      passwordHash: passwordHash || "",
      salt: salt || "",
      createdAt: cloudUser.createdAt || new Date().toISOString(),
      cloud: true,
    });
  }
  writeAuthStore(store);
  writeSession(cloudUser.id);
  state.currentUserId = cloudUser.id;
  writeCloudUser(cloudUser);
}

async function createAccount({ name, handle, email, password }) {
  const h = normalizeHandle(handle);
  const em = normalizeEmail(email);
  if (h.length < 3) throw new Error("Username must be at least 3 characters.");
  if (!em.includes("@")) throw new Error("Enter a valid email.");
  if (String(password || "").length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  try {
    const cloud = await cloudFetch("/api/auth", {
      method: "POST",
      body: { action: "register", name, handle: h, email: em, password },
    });
    if (cloud.token) writeCloudToken(cloud.token);
    const salt = uid();
    const passwordHash = await hashPassword(password, salt);
    cacheCloudUserLocally({ ...cloud.user, email: em }, passwordHash, salt);
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy && !localStorage.getItem(userStorageKey(cloud.user.id))) {
        localStorage.setItem(userStorageKey(cloud.user.id), legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
    if (cloud.library) applyCloudLibrary(cloud.library);
    return cloud.user;
  } catch (cloudErr) {
    console.warn("Cloud register failed, using local account", cloudErr);
    const store = readAuthStore();
    if (store.users.some((u) => u.handle === h)) {
      throw new Error("That username is taken.");
    }
    if (store.users.some((u) => u.email === em)) {
      throw new Error("That email is already registered.");
    }
    if (cloudErr.status === 409) throw cloudErr;

    const salt = uid();
    const passwordHash = await hashPassword(password, salt);
    const user = {
      id: uid(),
      name: String(name || h).trim().slice(0, 40) || h,
      handle: h,
      email: em,
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
      localOnly: true,
    };
    store.users.push(user);
    writeAuthStore(store);
    writeSession(user.id);
    state.currentUserId = user.id;
    writeCloudToken("");
    writeCloudUser(null);
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy && !localStorage.getItem(userStorageKey(user.id))) {
        localStorage.setItem(userStorageKey(user.id), legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
    return user;
  }
}

async function loginAccount({ handleOrEmail, password }) {
  const key = String(handleOrEmail || "").trim().toLowerCase();
  if (!key) throw new Error("Enter your username or email.");
  if (!password) throw new Error("Enter your password.");

  try {
    const cloud = await cloudFetch("/api/auth", {
      method: "POST",
      body: { action: "login", handleOrEmail: key, password },
    });
    if (cloud.token) writeCloudToken(cloud.token);
    const salt = uid();
    const passwordHash = await hashPassword(password, salt);
    cacheCloudUserLocally(cloud.user, passwordHash, salt);
    mergeCloudLibraryOnLogin(cloud.library);
    return cloud.user;
  } catch (cloudErr) {
    console.warn("Cloud login failed, trying local", cloudErr);
    const store = readAuthStore();
    if (!store.users.length) {
      throw new Error(
        cloudErr.message ||
          "No account found. Create an account — it will work on any phone."
      );
    }
    const user = store.users.find(
      (u) => u.handle === normalizeHandle(key) || u.email === normalizeEmail(key)
    );
    if (!user) {
      throw new Error(
        cloudErr.message ||
          "No account found with that username or email. Create account if this is a new phone."
      );
    }
    if (user.isGuest) throw new Error("Guest has no password — use Continue as guest.");
    const passwordHash = await hashPassword(password, user.salt);
    if (passwordHash !== user.passwordHash) throw new Error("Wrong password.");
    writeSession(user.id);
    state.currentUserId = user.id;
    return user;
  }
}

function logoutAccount() {
  writeSession(null);
  state.currentUserId = null;
  writeCloudToken("");
  writeCloudUser(null);
  const shell = document.getElementById("app-shell");
  const gate = document.getElementById("auth-gate");
  if (shell) {
    shell.hidden = true;
    shell.setAttribute("hidden", "");
  }
  if (gate) {
    gate.hidden = false;
    gate.removeAttribute("hidden");
  }
  document.body.classList.add("auth-locked");
  setAuthMode(readAuthStore().users.filter((u) => !u.isGuest).length ? "login" : "signup");
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) {
    if (msg) window.alert(msg);
    return;
  }
  if (!msg) {
    el.hidden = true;
    el.setAttribute("hidden", "");
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.removeAttribute("hidden");
  el.textContent = msg;
  try {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    /* ignore */
  }
}

function enterAsGuest() {
  const guestId = "guest-local";
  const store = readAuthStore();
  if (!store.users.some((u) => u.id === guestId)) {
    store.users.push({
      id: guestId,
      name: "Guest",
      handle: "guest",
      email: "guest@local",
      passwordHash: "",
      salt: "",
      createdAt: new Date().toISOString(),
      isGuest: true,
    });
    writeAuthStore(store);
  }
  writeCloudToken("");
  writeCloudUser(null);
  writeSession(guestId);
  state.currentUserId = guestId;
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && !localStorage.getItem(userStorageKey(guestId))) {
      localStorage.setItem(userStorageKey(guestId), legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  enterApp();
}

function setAuthMode(mode) {
  state.authMode = mode === "login" ? "login" : "signup";
  const signup = state.authMode === "signup";
  const title = document.getElementById("auth-title");
  const sub = document.getElementById("auth-sub");
  const submit = document.getElementById("auth-submit");
  const switchText = document.getElementById("auth-switch-text");
  const toggle = document.getElementById("auth-toggle");
  const nameField = document.getElementById("auth-name-field");
  const emailField = document.getElementById("auth-email-field");
  const pass = document.getElementById("auth-password");
  const handleInput = document.getElementById("auth-handle");
  const handleLabel = document.getElementById("auth-handle-label");
  if (title) title.textContent = signup ? "Create account" : "Log in";
  if (sub) {
    sub.textContent = signup
      ? "Save your library and open it on any phone with the same login."
      : "Log in with the same username/password on any phone to get your library.";
  }
  if (submit) {
    submit.textContent = signup ? "Create account" : "Log in";
    submit.disabled = false;
  }
  if (switchText) {
    switchText.textContent = signup ? "Already have an account?" : "New here?";
  }
  if (toggle) toggle.textContent = signup ? "Log in" : "Create account";
  if (nameField) {
    nameField.hidden = !signup;
    if (signup) nameField.removeAttribute("hidden");
    else nameField.setAttribute("hidden", "");
  }
  if (emailField) {
    emailField.hidden = !signup;
    if (signup) emailField.removeAttribute("hidden");
    else emailField.setAttribute("hidden", "");
  }
  if (pass) {
    pass.autocomplete = signup ? "new-password" : "current-password";
    pass.placeholder = signup ? "At least 6 characters" : "Password";
  }
  if (handleInput) {
    handleInput.placeholder = signup ? "your_handle" : "username or email";
  }
  if (handleLabel) handleLabel.textContent = signup ? "Username" : "Username or email";
  showAuthError("");
}

async function submitAuth() {
  showAuthError("");
  const submit = document.getElementById("auth-submit");
  const name = document.getElementById("auth-name")?.value || "";
  const handle = document.getElementById("auth-handle")?.value || "";
  const email = document.getElementById("auth-email")?.value || "";
  const password = document.getElementById("auth-password")?.value || "";
  if (submit) submit.disabled = true;
  try {
    if (state.authMode === "signup") {
      await createAccount({ name, handle, email, password });
    } else {
      const key = handle.trim() || email.trim();
      await loginAccount({ handleOrEmail: key, password });
    }
    enterApp();
  } catch (err) {
    console.error("Sequel auth error:", err);
    showAuthError(err?.message || "Could not continue.");
  } finally {
    if (submit) submit.disabled = false;
  }
}

function setupAuth() {
  const hasUsers = readAuthStore().users.some((u) => !u.isGuest);
  setAuthMode(hasUsers ? "login" : "signup");

  document.getElementById("auth-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    setAuthMode(state.authMode === "signup" ? "login" : "signup");
  });

  document.getElementById("auth-guest")?.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      enterAsGuest();
    } catch (err) {
      showAuthError(err?.message || "Could not start guest session.");
    }
  });

  document.getElementById("auth-submit")?.addEventListener("click", (e) => {
    e.preventDefault();
    submitAuth();
  });

  document.getElementById("auth-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAuth();
  });

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    if (window.confirm("Log out of Sequel on this device?")) logoutAccount();
  });

  document.getElementById("open-profile-btn")?.addEventListener("click", () => {
    showPanel("profile");
  });
  document.getElementById("profile-back-btn")?.addEventListener("click", () => {
    showPanel("home");
  });
  document.getElementById("edit-prefs-btn")?.addEventListener("click", () => {
    openOnboarding({ edit: true });
  });
}

/* ---------- onboarding / preferences ---------- */

function showOnboardError(msg) {
  const el = document.getElementById("onboard-error");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.setAttribute("hidden", "");
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.removeAttribute("hidden");
  el.textContent = msg;
}

function paintOnboardDraft() {
  const d = state.onboardDraft;
  const yearInput = document.getElementById("onboard-birth-year");
  if (yearInput) yearInput.value = d.birthYear || "";

  document.querySelectorAll("#onboard-rating-row [data-max-rating]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.maxRating === d.maxRating);
  });
  document.querySelectorAll("#onboard-streaming [data-stream]").forEach((btn) => {
    btn.classList.toggle("active", d.streaming.includes(btn.dataset.stream));
  });
}

function openOnboarding({ edit = false } = {}) {
  const profile = getProfile();
  state.onboardDraft = {
    birthYear: profile.birthYear,
    maxRating: profile.maxRating || "PG-13",
    streaming: [...(profile.streaming || [])],
  };
  const title = document.getElementById("onboard-title");
  const sub = document.getElementById("onboard-sub");
  const skip = document.getElementById("onboard-skip");
  if (title) {
    title.textContent = edit ? "Edit preferences" : "Help Sequel suggest better";
  }
  if (sub) {
    sub.textContent = edit
      ? "Update birth year, content rating, and streaming services."
      : "A few quick questions so For you matches what you’re allowed to watch and what you can stream.";
  }
  if (skip) skip.hidden = edit;
  showOnboardError("");
  paintOnboardDraft();
  const dialog = document.getElementById("onboard-dialog");
  if (dialog && typeof dialog.showModal === "function") dialog.showModal();
}

function saveOnboarding({ skip = false } = {}) {
  showOnboardError("");
  if (skip) {
    update((d) => {
      d.profile = normalizeProfile({
        ...(d.profile || defaultProfile()),
        onboardingDone: true,
      });
    });
    document.getElementById("onboard-dialog")?.close();
    if (state.panel === "profile") renderProfile();
    renderRecs();
    return;
  }

  const yearRaw = document.getElementById("onboard-birth-year")?.value;
  const year = yearRaw ? Number(yearRaw) : null;
  const now = new Date().getFullYear();
  if (!year || year < 1920 || year > now - 3) {
    showOnboardError("Enter a valid birth year (e.g. 2010).");
    return;
  }
  if (!state.onboardDraft.maxRating) {
    showOnboardError("Pick a max content rating.");
    return;
  }

  update((d) => {
    d.profile = normalizeProfile({
      birthYear: year,
      maxRating: state.onboardDraft.maxRating,
      streaming: state.onboardDraft.streaming,
      onboardingDone: true,
    });
  });

  document.getElementById("onboard-dialog")?.close();
  if (state.panel === "profile") renderProfile();
  renderRecs();
  updateStat();
}

function setupOnboarding() {
  document.querySelectorAll("#onboard-rating-row [data-max-rating]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.onboardDraft.maxRating = btn.dataset.maxRating;
      paintOnboardDraft();
    });
  });

  document.querySelectorAll("#onboard-streaming [data-stream]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.stream;
      let list = [...state.onboardDraft.streaming];
      if (id === "none") {
        list = list.includes("none") ? [] : ["none"];
      } else {
        list = list.filter((s) => s !== "none");
        if (list.includes(id)) list = list.filter((s) => s !== id);
        else list.push(id);
      }
      state.onboardDraft.streaming = list;
      paintOnboardDraft();
    });
  });

  document.getElementById("onboard-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    saveOnboarding({ skip: false });
  });
  document.getElementById("onboard-save")?.addEventListener("click", (e) => {
    e.preventDefault();
    saveOnboarding({ skip: false });
  });
  document.getElementById("onboard-skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    saveOnboarding({ skip: true });
  });
  document.getElementById("onboard-close")?.addEventListener("click", () => {
    // closing without save — if never done, mark skip so we don't loop forever
    const p = getProfile();
    if (!p.onboardingDone) saveOnboarding({ skip: true });
    else document.getElementById("onboard-dialog")?.close();
  });
}

function maybePromptOnboarding() {
  const user = currentUser();
  if (!user || user.isGuest) return;
  if (profileNeedsOnboarding()) {
    // slight delay so shell paints first
    setTimeout(() => openOnboarding({ edit: false }), 350);
  }
}

function enterApp() {
  try {
    const user = currentUser();
    if (!user) {
      logoutAccount();
      return;
    }
    state.currentUserId = user.id;
    const gate = document.getElementById("auth-gate");
    const shell = document.getElementById("app-shell");
    if (gate) {
      gate.hidden = true;
      gate.setAttribute("hidden", "");
    }
    if (shell) {
      shell.hidden = false;
      shell.removeAttribute("hidden");
    }
    document.body.classList.remove("auth-locked");
    const handleEl = document.getElementById("user-chip-handle");
    if (handleEl) {
      handleEl.textContent = user.isGuest ? "guest" : `@${user.handle}`;
    }
    showPanel("home");
    updateStat();
    // Refresh library from cloud in background (non-guest)
    if (readCloudToken() && !user.isGuest) {
      pullLibraryFromCloud()
        .then(() => {
          updateStat();
          if (state.panel === "library") renderLibrary();
          if (state.panel === "foryou") renderRecs();
          if (state.panel === "profile") renderProfile();
          maybePromptOnboarding();
        })
        .catch(() => {
          maybePromptOnboarding();
        });
    } else {
      maybePromptOnboarding();
    }
  } catch (err) {
    console.error("enterApp failed", err);
    showAuthError(err?.message || "Could not open the app after login.");
  }
}

function init() {
  loadPosterCache();
  loadRemoteCache();
  setupAuth();
  setupNav();
  setupFilters();
  setupCards();
  setupRateDialog();
  setupAddDialog();
  setupOnboarding();

  const sessionId = readSession();
  if (
    sessionId &&
    (readAuthStore().users.some((u) => u.id === sessionId) ||
      readCloudUser()?.id === sessionId)
  ) {
    state.currentUserId = sessionId;
    enterApp();
  } else {
    document.body.classList.add("auth-locked");
    const shell = document.getElementById("app-shell");
    const gate = document.getElementById("auth-gate");
    if (shell) {
      shell.hidden = true;
      shell.setAttribute("hidden", "");
    }
    if (gate) {
      gate.hidden = false;
      gate.removeAttribute("hidden");
    }
  }
}

init();

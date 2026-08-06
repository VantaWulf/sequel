/**
 * Sequel — recommend movies, TV, and books from what you rated.
 * Local-first (localStorage). Catalog in data.js; custom titles supported.
 */

const STORAGE_KEY = "sequel.library.v1";
const POSTER_CACHE_KEY = "sequel.posters.v1";

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
};

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

function resolveItem(id) {
  const fromCat = catalogById(id);
  if (fromCat) return fromCat;
  // custom entries are stored on library items
  const lib = load().items.find((x) => x.id === id);
  if (!lib) return null;
  return {
    id: lib.id,
    type: lib.type,
    title: lib.title,
    year: lib.year || null,
    author: lib.author || "",
    genres: lib.genres || [],
    vibe: lib.vibe || [],
    why: lib.why || "Custom title",
    posterQuery: lib.title,
    custom: true,
  };
}

function searchCatalog(query, type = "all", limit = 40) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  let list = catalog();
  if (type !== "all") list = list.filter((x) => x.type === type);
  if (!q) return list.slice(0, limit);
  return list
    .filter((x) => {
      const hay = [
        x.title,
        x.author,
        x.why,
        ...(x.genres || []),
        ...(x.vibe || []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit);
}

/* ---------- posters ---------- */

function loadPosterCache() {
  try {
    state.posterCache = JSON.parse(localStorage.getItem(POSTER_CACHE_KEY) || "{}") || {};
  } catch {
    state.posterCache = {};
  }
}

function savePosterCache() {
  try {
    const keys = Object.keys(state.posterCache);
    // cap cache size
    if (keys.length > 200) {
      keys.slice(0, keys.length - 200).forEach((k) => delete state.posterCache[k]);
    }
    localStorage.setItem(POSTER_CACHE_KEY, JSON.stringify(state.posterCache));
  } catch {
    /* quota — ignore */
  }
}

function posterPlaceholder(item) {
  const letter = escapeHtml((item.title || "?").charAt(0).toUpperCase());
  const tone =
    item.type === "movie" ? "ph-movie" : item.type === "tv" ? "ph-tv" : "ph-book";
  return `<div class="poster-ph ${tone}" aria-hidden="true"><span>${letter}</span></div>`;
}

function posterHtml(item, size = "md") {
  const cached = state.posterCache[item.id];
  const src = cached || item.poster || "";
  if (src) {
    return `<img class="poster ${size}" src="${escapeHtml(src)}" alt="" loading="lazy" data-poster-id="${escapeHtml(
      item.id
    )}" onerror="this.replaceWith(window.__sequelPosterFallback && window.__sequelPosterFallback('${escapeHtml(
      item.id
    )}','${escapeHtml(item.type)}','${escapeHtml((item.title || "?").charAt(0))}'))" />`;
  }
  return `<div class="poster ${size} poster-loading" data-poster-id="${escapeHtml(
    item.id
  )}" data-poster-type="${escapeHtml(item.type)}" data-poster-title="${escapeHtml(
    item.title || ""
  )}" data-poster-query="${escapeHtml(item.posterQuery || item.title || "")}" data-poster-isbn="${escapeHtml(
    item.isbn || ""
  )}" data-poster-author="${escapeHtml(item.author || "")}">${posterPlaceholder(item)}</div>`;
}

window.__sequelPosterFallback = function (id, type, letter) {
  const tone = type === "movie" ? "ph-movie" : type === "tv" ? "ph-tv" : "ph-book";
  const el = document.createElement("div");
  el.className = `poster-ph ${tone}`;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<span>${letter || "?"}</span>`;
  return el;
};

async function fetchItunesArtwork(query, entity) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=${entity}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  const results = data.results || [];
  const hit =
    results.find((r) => r.artworkUrl100 || r.artworkUrl60) || results[0];
  if (!hit) return "";
  const art = hit.artworkUrl100 || hit.artworkUrl60 || "";
  // request a larger size
  return art.replace(/100x100bb|60x60bb/g, "400x400bb");
}

async function fetchOpenLibraryCover(item) {
  if (item.isbn) {
    return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(item.isbn)}-L.jpg`;
  }
  const q = item.posterQuery || item.title;
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}${
    item.author ? `&author=${encodeURIComponent(item.author)}` : ""
  }&limit=3`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  const doc = (data.docs || []).find((d) => d.cover_i) || (data.docs || [])[0];
  if (!doc?.cover_i) return "";
  return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
}

async function resolvePosterUrl(item) {
  if (state.posterCache[item.id]) return state.posterCache[item.id];
  if (item.poster) {
    state.posterCache[item.id] = item.poster;
    savePosterCache();
    return item.poster;
  }
  const q = item.posterQuery || item.title;
  try {
    if (item.type === "book") {
      const cover = await fetchOpenLibraryCover(item);
      if (cover) {
        state.posterCache[item.id] = cover;
        savePosterCache();
        return cover;
      }
      // fallback to iTunes ebooks
      const art = await fetchItunesArtwork(q, "ebook");
      if (art) {
        state.posterCache[item.id] = art;
        savePosterCache();
        return art;
      }
    } else if (item.type === "tv") {
      const art =
        (await fetchItunesArtwork(q, "tvSeason")) ||
        (await fetchItunesArtwork(q, "tvShow"));
      if (art) {
        state.posterCache[item.id] = art;
        savePosterCache();
        return art;
      }
    } else {
      const art = await fetchItunesArtwork(q, "movie");
      if (art) {
        state.posterCache[item.id] = art;
        savePosterCache();
        return art;
      }
    }
  } catch (err) {
    console.warn("poster fetch failed", item.id, err);
  }
  return "";
}

async function hydratePosters(root = document) {
  const nodes = root.querySelectorAll("[data-poster-id]");
  const queue = [];
  nodes.forEach((el) => {
    const id = el.getAttribute("data-poster-id");
    if (!id) return;
    if (el.tagName === "IMG" && el.getAttribute("src")) return;
    const item =
      catalogById(id) ||
      resolveItem(id) || {
        id,
        type: el.getAttribute("data-poster-type") || "movie",
        title: el.getAttribute("data-poster-title") || "",
        posterQuery: el.getAttribute("data-poster-query") || "",
        isbn: el.getAttribute("data-poster-isbn") || "",
        author: el.getAttribute("data-poster-author") || "",
      };
    queue.push({ el, item });
  });

  // modest concurrency
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const job = queue[i++];
      const url = await resolvePosterUrl(job.item);
      if (!url) continue;
      const img = document.createElement("img");
      img.className = job.el.className.replace("poster-loading", "").trim() + " poster";
      if (!img.className.includes("poster")) img.className += " poster md";
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.dataset.posterId = job.item.id;
      img.onerror = function () {
        this.replaceWith(
          window.__sequelPosterFallback(
            job.item.id,
            job.item.type,
            (job.item.title || "?").charAt(0)
          )
        );
      };
      if (job.el.parentNode) job.el.replaceWith(img);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
}

/* ---------- storage ---------- */

function defaultLibrary() {
  return { items: [], version: 1 };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLibrary();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  } catch {
    return defaultLibrary();
  }
}

function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function update(fn) {
  const data = load();
  fn(data);
  save(data);
  return data;
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
 */
function recommend(typeFilter = "all", limit = 12) {
  const lib = load().items;
  const owned = new Set(lib.map((x) => x.id));

  const genreScore = new Map();
  const vibeScore = new Map();
  const typeBoost = { movie: 0, tv: 0, book: 0 };

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

    typeBoost[item.type] = (typeBoost[item.type] || 0) + w;
    (item.genres || []).forEach((g) => {
      genreScore.set(g, (genreScore.get(g) || 0) + w);
    });
    (item.vibe || []).forEach((v) => {
      vibeScore.set(v, (vibeScore.get(v) || 0) + w);
    });
  });

  if (![...genreScore.values()].some((v) => v > 0) && ![...vibeScore.values()].some((v) => v > 0)) {
    return [];
  }

  const topGenres = [...genreScore.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);

  let candidates = catalog().filter((c) => !owned.has(c.id));
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
      // slight popularity bias for seed variety
      score += (c.year && c.year >= 2015 ? 0.15 : 0);
      return { item: c, score, matched: matched.slice(0, 4) };
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
      .map((c) => ({
        item: c,
        score: 1,
        matched: (c.genres || []).filter((g) => topGenres.includes(g)).slice(0, 3),
      }));
  }

  return out;
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
    t.classList.toggle("active", t.dataset.nav === name);
  });
  if (name === "home") renderHome();
  if (name === "foryou") renderRecs();
  if (name === "library") renderLibrary();
  if (name === "browse") renderBrowse();
}

function newReleases(type, limit = 12) {
  return catalog()
    .filter((c) => c.type === type && (c.newRelease || (c.year && c.year >= 2022)))
    .sort((a, b) => (b.year || 0) - (a.year || 0))
    .slice(0, limit);
}

function trendingPicks(limit = 12) {
  // Popular evergreen + recent mix
  return catalog()
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
  const badge = entry?.rating
    ? `<span class="tile-badge stars">${starsText(entry.rating)}</span>`
    : item.newRelease
      ? `<span class="tile-badge new">New</span>`
      : "";
  return `
    <button type="button" class="poster-tile" data-open-rate="${escapeHtml(item.id)}">
      <div class="poster-frame">
        ${posterHtml(item, "lg")}
        ${badge}
      </div>
      <span class="tile-title">${escapeHtml(item.title)}</span>
      <span class="tile-meta">${escapeHtml(
        [item.year, typeLabel(item.type)].filter(Boolean).join(" · ")
      )}</span>
    </button>
  `;
}

function renderHome() {
  const movies = document.getElementById("rail-movies");
  const tv = document.getElementById("rail-tv");
  const books = document.getElementById("rail-books");
  const trending = document.getElementById("rail-trending");
  if (movies) movies.innerHTML = newReleases("movie", 14).map(posterTileHtml).join("");
  if (tv) tv.innerHTML = newReleases("tv", 14).map(posterTileHtml).join("");
  if (books) books.innerHTML = newReleases("book", 14).map(posterTileHtml).join("");
  if (trending) trending.innerHTML = trendingPicks(14).map(posterTileHtml).join("");
  updateStat();
  hydratePosters(document.getElementById("home") || document.querySelector('[data-panel="home"]'));
}

function mediaCardHtml(item, { mode, entry, rec } = {}) {
  const metaParts = [];
  if (item.year) metaParts.push(item.year);
  if (item.author) metaParts.push(item.author);
  if (entry?.status) metaParts.push(statusLabel(entry.status));
  const tags = [...(item.genres || []).slice(0, 3), ...(item.vibe || []).slice(0, 1)];
  const why =
    mode === "rec" && rec?.matched?.length
      ? `Because you liked <strong>${escapeHtml(rec.matched.join(", "))}</strong>`
      : escapeHtml(item.why || "");

  const score =
    mode === "rec" && rec
      ? `<span class="match-score">${Math.min(99, Math.round(rec.score * 12))}%</span>`
      : entry?.rating
        ? `<span class="stars-inline" title="Your rating">${starsText(entry.rating)}</span>`
        : "";

  const action =
    mode === "library"
      ? `<button type="button" class="btn soft sm" data-open-rate="${escapeHtml(item.id)}">Edit</button>`
      : `<button type="button" class="btn soft sm" data-open-rate="${escapeHtml(item.id)}">${
          entry ? "Update" : "Rate / save"
        }</button>`;

  return `
    <article class="m-card">
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
      ${why ? `<p class="m-why">${why}</p>` : ""}
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

function renderLibrary() {
  const list = document.getElementById("library-list");
  const empty = document.getElementById("library-empty");
  if (!list) return;
  let items = load().items.slice();
  if (state.libType !== "all") {
    items = items.filter((e) => {
      const it = resolveItem(e.id);
      return it && it.type === state.libType;
    });
  }
  items.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  list.innerHTML = items
    .map((entry) => {
      const item = resolveItem(entry.id);
      if (!item) return "";
      return mediaCardHtml(item, { mode: "library", entry });
    })
    .join("");
  empty.hidden = items.length > 0;
  updateStat();
  hydratePosters(list);
}

function renderBrowse() {
  const list = document.getElementById("browse-list");
  const q = document.getElementById("browse-search")?.value || "";
  if (!list) return;
  const hits = searchCatalog(q, state.browseType, 40);
  const map = libraryMap();
  list.innerHTML = hits
    .map((item) => mediaCardHtml(item, { mode: "browse", entry: map.get(item.id) }))
    .join("");
  hydratePosters(list);
}

/* ---------- rate dialog ---------- */

function openRateDialog(id) {
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
      type: item.type,
      title: item.title,
      year: item.year || null,
      author: item.author || "",
      genres: item.genres || [],
      vibe: item.vibe || [],
      why: item.why || "",
      status,
      rating: rating || 0,
      note,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
      custom: !!item.custom,
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

function renderAddSearch() {
  const q = document.getElementById("add-search")?.value || "";
  const box = document.getElementById("add-results");
  if (!box) return;
  if (!q.trim()) {
    box.innerHTML = "";
    return;
  }
  const hits = searchCatalog(q, "all", 12);
  box.innerHTML = hits
    .map(
      (h) => `
      <button type="button" class="search-hit" data-pick="${escapeHtml(h.id)}">
        <strong>${escapeHtml(h.title)}</strong>
        <span>${escapeHtml(typeLabel(h.type))}${h.year ? ` · ${h.year}` : ""}${
          h.author ? ` · ${escapeHtml(h.author)}` : ""
        }</span>
      </button>`
    )
    .join("");
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

function setupCards() {
  document.getElementById("main")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-open-rate]")?.dataset.openRate;
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

function init() {
  loadPosterCache();
  setupNav();
  setupFilters();
  setupCards();
  setupRateDialog();
  setupAddDialog();
  showPanel("home");
  updateStat();
}

init();

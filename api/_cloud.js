/**
 * Sequel cloud helpers — Supabase Storage + HMAC sessions.
 */
const crypto = require("crypto");

const BUCKET = "sequel";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function env(name) {
  return (process.env[name] || "").trim();
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    const err = new Error("Cloud not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    err.code = "NO_CLOUD";
    throw err;
  }
  return { url, key };
}

function sessionSecret() {
  return (
    env("SEQUEL_SESSION_SECRET") ||
    env("SILLAGE_SESSION_SECRET") ||
    env("SUPABASE_SERVICE_ROLE_KEY") ||
    "sequel-dev"
  );
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-sequel-token"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  cors(res);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    cors(res);
    res.end();
    return true;
  }
  return false;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function signToken(userId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ uid: userId, exp }));
  const sig = b64url(
    crypto.createHmac("sha256", sessionSecret()).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = b64url(
    crypto.createHmac("sha256", sessionSecret()).update(payload).digest()
  );
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(fromB64url(payload).toString("utf8"));
    if (!data.uid || !data.exp || Date.now() > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

function tokenFromReq(req, body = {}) {
  const h = req.headers["x-sequel-token"] || req.headers["authorization"] || "";
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  if (typeof h === "string" && h && !h.toLowerCase().startsWith("bearer")) {
    return h.trim();
  }
  return body.token || "";
}

async function sbFetch(path, { method = "GET", body, contentType, rawBody } = {}) {
  const { url, key } = supabaseConfig();
  const headers = { Authorization: `Bearer ${key}`, apikey: key };
  if (contentType) headers["Content-Type"] = contentType;
  else if (body !== undefined && !rawBody) headers["Content-Type"] = "application/json";
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: rawBody ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function ensureBucket() {
  const { status } = await sbFetch(`/storage/v1/bucket/${BUCKET}`);
  if (status === 200) return;
  await sbFetch("/storage/v1/bucket", {
    method: "POST",
    body: { id: BUCKET, name: BUCKET, public: false, file_size_limit: 5_000_000 },
  });
}

async function storageUpload(path, buffer, contentType) {
  await ensureBucket();
  let r = await sbFetch(`/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    contentType: contentType || "application/octet-stream",
    rawBody: true,
    body: buffer,
  });
  if (!r.ok && (r.status === 400 || r.status === 409)) {
    r = await sbFetch(`/storage/v1/object/${BUCKET}/${path}`, {
      method: "PUT",
      contentType: contentType || "application/octet-stream",
      rawBody: true,
      body: buffer,
    });
  }
  if (!r.ok) throw new Error(`Storage upload failed: ${r.status} ${r.text}`);
}

async function storageDownload(path) {
  const { url, key } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Storage download failed: ${res.status} ${t.slice(0, 120)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function storageReadJson(path) {
  const buf = await storageDownload(path);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf8"));
}

async function storageWriteJson(path, obj) {
  await storageUpload(path, Buffer.from(JSON.stringify(obj), "utf8"), "application/json");
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

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    handle: u.handle,
    createdAt: u.createdAt,
  };
}

async function getUserById(id) {
  if (!id) return null;
  return storageReadJson(`users/by-id/${id}.json`);
}

async function getUserByHandle(handle) {
  const h = normalizeHandle(handle);
  if (!h) return null;
  const idx = await storageReadJson(`users/by-handle/${h}.json`);
  if (!idx?.id) return null;
  return getUserById(idx.id);
}

async function getUserByEmail(email) {
  const em = normalizeEmail(email);
  if (!em) return null;
  const idx = await storageReadJson(`users/by-email/${encodeURIComponent(em)}.json`);
  if (!idx?.id) return null;
  return getUserById(idx.id);
}

async function saveUser(user) {
  await storageWriteJson(`users/by-id/${user.id}.json`, user);
  await storageWriteJson(`users/by-handle/${user.handle}.json`, { id: user.id });
  await storageWriteJson(`users/by-email/${encodeURIComponent(user.email)}.json`, {
    id: user.id,
  });
}

async function getLibrary(userId) {
  const data = await storageReadJson(`libraries/${userId}.json`);
  if (!data || !Array.isArray(data.items)) {
    return { items: [], version: 1, profile: null };
  }
  return {
    items: data.items,
    version: data.version || 1,
    profile: data.profile || null,
    updatedAt: data.updatedAt || null,
  };
}

async function saveLibrary(userId, library) {
  await storageWriteJson(`libraries/${userId}.json`, {
    items: Array.isArray(library.items) ? library.items : [],
    profile: library.profile || null,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
}

module.exports = {
  BUCKET,
  cors,
  json,
  readBody,
  handleOptions,
  signToken,
  verifyToken,
  tokenFromReq,
  normalizeHandle,
  normalizeEmail,
  hashPassword,
  publicUser,
  getUserById,
  getUserByHandle,
  getUserByEmail,
  saveUser,
  getLibrary,
  saveLibrary,
  ensureBucket,
};

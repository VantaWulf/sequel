/**
 * GET  /api/library?token=
 * POST /api/library  { token, library: { items: [...] } }
 */
const {
  json,
  readBody,
  handleOptions,
  tokenFromReq,
  verifyToken,
  getLibrary,
  saveLibrary,
  getUserById,
  publicUser,
} = require("./_cloud");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token") || "";
      const userId = verifyToken(token);
      if (!userId) return json(res, 401, { error: "Log in required." });
      const user = await getUserById(userId);
      if (!user) return json(res, 401, { error: "Account not found." });
      const library = await getLibrary(userId);
      return json(res, 200, { ok: true, user: publicUser(user), library });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const token = tokenFromReq(req, body);
      const userId = verifyToken(token);
      if (!userId) return json(res, 401, { error: "Log in required." });
      const user = await getUserById(userId);
      if (!user) return json(res, 401, { error: "Account not found." });

      const items = Array.isArray(body.library?.items)
        ? body.library.items
        : Array.isArray(body.items)
          ? body.items
          : null;
      if (!items) return json(res, 400, { error: "Expected library.items array." });
      if (items.length > 5000) {
        return json(res, 413, { error: "Library too large." });
      }

      await saveLibrary(userId, { items });
      return json(res, 200, { ok: true, saved: items.length });
    }

    return json(res, 405, { error: "GET or POST only" });
  } catch (e) {
    const status = e.code === "NO_CLOUD" ? 503 : 500;
    return json(res, status, { error: e.message || String(e) });
  }
};

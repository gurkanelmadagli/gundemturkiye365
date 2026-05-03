/**
 * Haber arşivi: RSS turunda gelen haberler SQLite (sql.js) dosyasında tutulur.
 * Varsayılan: yayın zamanı (ts) üzerinden 14 günden eski kayıtlar periyodik silinir (NEWS_DB_RETENTION_DAYS).
 * `NEWS_DISABLE_DB=1` ile kapatılabilir. Yerel dosya: varsayılan `data/news.sqlite`.
 */
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js").default;

let SQLModule = null;
let db = null;
let dbPath = null;
let initPromise = null;
let persistChain = Promise.resolve();

function isDbDisabled() {
  return process.env.NEWS_DISABLE_DB === "1" || process.env.NEWS_DISABLE_DB === "true";
}

function getDbPath() {
  return String(process.env.NEWS_DB_PATH || path.join(__dirname, "data", "news.sqlite"));
}

async function getSql() {
  if (SQLModule) return SQLModule;
  if (!initPromise) {
    initPromise = initSqlJs();
  }
  SQLModule = await initPromise;
  return SQLModule;
}

function createSchema(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      link TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT,
      pub_date TEXT,
      ts INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      category TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
  database.run(`CREATE INDEX IF NOT EXISTS idx_articles_ts ON articles (ts DESC);`);
}

async function ensureDb() {
  if (isDbDisabled()) return null;
  if (db) return db;
  const SQL = await getSql();
  dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  createSchema(db);
  return db;
}

function persistDbSync() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function schedulePersist() {
  persistChain = persistChain.then(() => {
    try {
      persistDbSync();
    } catch (e) {
      console.warn("news-db persist:", e.message || String(e));
    }
  });
  return persistChain;
}

/** Arşiv / kategori listelerinde gösterilmeyecek tanıtım–abonelik tarzı başlıklar (küçük harf eşleşir). */
const LIST_EXCLUDE_TITLE_SUBSTRINGS = [
  "abone ol",
  "abone olun",
  "aboneliği",
  "aboneliğe",
  "kanalımıza abone",
  "kanalimize abone",
  "bize abone ol",
  "bültenimize kayıt",
  "e-bülten",
  "ebülten",
  "newsletter",
  "subscribe to our",
  "subscribe to the",
  "click to subscribe",
  "ücretsiz abone",
];

/**
 * @param {boolean} enabled
 * @returns {{ sql: string, binds: string[] }}
 */
function buildListTitleExclusion(enabled) {
  if (!enabled || !LIST_EXCLUDE_TITLE_SUBSTRINGS.length) {
    return { sql: "1", binds: [] };
  }
  const binds = LIST_EXCLUDE_TITLE_SUBSTRINGS.map((s) => String(s).toLowerCase());
  const parts = binds.map(() => "lower(title) NOT LIKE ('%' || ? || '%')");
  return { sql: `(${parts.join(" AND ")})`, binds };
}

/**
 * @param {Array<{ id: string, link: string, title: string, excerpt?: string, pubDate?: string, ts: number, image?: string, category?: string }>} rows
 */
async function upsertArticles(rows) {
  if (!rows || !rows.length) return 0;
  const database = await ensureDb();
  if (!database) return 0;
  const now = new Date().toISOString();
  const sql = `
    INSERT INTO articles (id, link, title, excerpt, pub_date, ts, image, category, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(link) DO UPDATE SET
      title = excluded.title,
      excerpt = excluded.excerpt,
      pub_date = excluded.pub_date,
      ts = excluded.ts,
      image = excluded.image,
      category = excluded.category,
      last_seen_at = excluded.last_seen_at
  `;
  let n = 0;
  database.run("BEGIN");
  try {
    for (const r of rows) {
      if (!r || !r.link || !r.id) continue;
      database.run(sql, [
        r.id,
        r.link,
        String(r.title || "").slice(0, 2000),
        String(r.excerpt || "").slice(0, 250000),
        String(r.pubDate || "").slice(0, 120),
        Number(r.ts) || 0,
        String(r.image || "").slice(0, 4000),
        String(r.category || "gundem").slice(0, 64),
        now,
        now,
      ]);
      n++;
    }
    database.run("COMMIT");
  } catch (e) {
    try {
      database.run("ROLLBACK");
    } catch (_r) {}
    throw e;
  }
  schedulePersist();
  return n;
}

function rowToArticle(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt || "",
    pubDate: row.pub_date || "",
    ts: row.ts,
    image: row.image || "",
    link: row.link,
    category: row.category || "gundem",
  };
}

async function getArticleById(id) {
  const database = await ensureDb();
  if (!database) return null;
  const sid = String(id || "").trim();
  if (!sid) return null;
  const stmt = database.prepare(
    "SELECT id, link, title, excerpt, pub_date, ts, image, category FROM articles WHERE id = ?"
  );
  stmt.bind([sid]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return rowToArticle(row);
}

/**
 * @param {{ page?: number, pageSize?: number, category?: string | null, requireNonEmptyImage?: boolean, excludePromoTitles?: boolean }} opts
 * @returns {Promise<{ items: object[], total: number, page: number, pageSize: number, totalPages: number }>}
 */
async function listArticles(opts) {
  const database = await ensureDb();
  const pageSize = Math.min(100, Math.max(1, Number(opts && opts.pageSize) || 24));
  const page = Math.max(1, Number(opts && opts.page) || 1);
  const offset = (page - 1) * pageSize;
  const cat = opts && opts.category ? String(opts.category).trim() : "";
  const needImg = !!(opts && opts.requireNonEmptyImage);
  const imgWhere = needImg ? "TRIM(COALESCE(image, '')) <> ''" : "1";
  const excludePromo =
    opts && Object.prototype.hasOwnProperty.call(opts, "excludePromoTitles")
      ? !!opts.excludePromoTitles
      : true;
  const titleEx = buildListTitleExclusion(excludePromo);
  const promoSql = titleEx.sql;
  const promoBinds = titleEx.binds;

  if (!database) {
    return { items: [], total: 0, page, pageSize, totalPages: 0 };
  }

  let total = 0;
  if (cat) {
    const cStmt = database.prepare(
      `SELECT COUNT(*) AS c FROM articles WHERE category = ? AND (${imgWhere}) AND (${promoSql})`
    );
    cStmt.bind([cat, ...promoBinds]);
    if (cStmt.step()) {
      const o = cStmt.getAsObject();
      total = Number(o.c) || 0;
    }
    cStmt.free();
  } else {
    const cStmt = database.prepare(
      `SELECT COUNT(*) AS c FROM articles WHERE (${imgWhere}) AND (${promoSql})`
    );
    cStmt.bind([...promoBinds]);
    cStmt.step();
    const o = cStmt.getAsObject();
    total = Number(o.c) || 0;
    cStmt.free();
  }

  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  const listSql = cat
    ? `SELECT id, link, title, excerpt, pub_date, ts, image, category FROM articles WHERE category = ? AND (${imgWhere}) AND (${promoSql}) ORDER BY ts DESC LIMIT ? OFFSET ?`
    : `SELECT id, link, title, excerpt, pub_date, ts, image, category FROM articles WHERE (${imgWhere}) AND (${promoSql}) ORDER BY ts DESC LIMIT ? OFFSET ?`;
  const stmt = database.prepare(listSql);
  if (cat) {
    stmt.bind([cat, ...promoBinds, pageSize, offset]);
  } else {
    stmt.bind([...promoBinds, pageSize, offset]);
  }

  const items = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const art = rowToArticle(row);
    if (art) items.push(art);
  }
  stmt.free();

  return { items, total, page, pageSize, totalPages };
}

/**
 * `ts` (RSS yayın zamanı, ms) veya geçersiz ts için `first_seen_at` üzerinden eşikten eski satırları siler.
 * @param {{ retentionDays?: number }} opts
 * @returns {Promise<{ deleted: number }>}
 */
async function pruneArticlesOlderThan(opts) {
  const database = await ensureDb();
  if (!database) return { deleted: 0 };
  const retentionDays = Math.min(366, Math.max(1, Number(opts && opts.retentionDays) || 14));
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const isoCutoff = new Date(cutoffMs).toISOString();

  let deleted = 0;
  database.run("BEGIN");
  try {
    database.run("DELETE FROM articles WHERE ts > 0 AND ts < ?", [cutoffMs]);
    deleted += database.getRowsModified();
    database.run("DELETE FROM articles WHERE (ts IS NULL OR ts <= 0) AND first_seen_at < ?", [isoCutoff]);
    deleted += database.getRowsModified();
    database.run("COMMIT");
  } catch (e) {
    try {
      database.run("ROLLBACK");
    } catch (_r) {}
    throw e;
  }
  if (deleted > 0) schedulePersist();
  return { deleted };
}

module.exports = {
  upsertArticles,
  getArticleById,
  listArticles,
  pruneArticlesOlderThan,
  isDbDisabled,
};

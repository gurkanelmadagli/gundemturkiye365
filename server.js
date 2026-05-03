require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");
const { decodeHTML } = require("entities");
const rssItemUtils = require("rss-parser/lib/utils");
const rssGetContent = rssItemUtils.getContent;
const rssStripHtml = rssItemUtils.stripHtml;
const newsDb = require("./news-db");

const PORT = Number(process.env.PORT) || 3000;
/** RSS önbelleği: bu süre dolunca /api/news yeni tur çeker (env: RSS_CACHE_MS, varsayılan 2 dk) */
const CACHE_MS = Number(process.env.RSS_CACHE_MS) || 120000;
/**
 * Süre dolunca bile dolu önbelleği hemen döndürür; tazeleme arka planda tek uçuşta çalışır.
 * Kapatmak için: RSS_STALE_SERVE=0
 */
const RSS_STALE_SERVE = process.env.RSS_STALE_SERVE !== "0";
/** TR pulse içinde döviz/altın önbelleği (env: PULSE_CACHE_MS, varsayılan 60s) */
const PULSE_FX_CACHE_MS = Number(process.env.PULSE_CACHE_MS) || 60000;
/** Deprem satırı için AFAD tazeleme (env: PULSE_QUAKES_CACHE_MS, varsayılan 12s; dövizden bağımsız) */
const PULSE_QUAKES_CACHE_MS = Number(process.env.PULSE_QUAKES_CACHE_MS) || 12000;
/** KOERI lst1.asp ile listeyi zenginleştir (AFAD gecikirse güncel kalır). Kapatmak: PULSE_USE_KOERI=0 */
const PULSE_USE_KOERI = process.env.PULSE_USE_KOERI !== "0";
/** /api/weather: IP başına önbellek (Open-Meteo + ipwho.is yükünü azaltır) */
const WEATHER_CACHE_MS = Number(process.env.WEATHER_CACHE_MS) || 10 * 60 * 1000;
/** /api/fuel-prices: il bazlı özet (üçüncü parti API + EPDK bildirimleri) */
const FUEL_CACHE_MS = Number(process.env.FUEL_CACHE_MS) || 2 * 60 * 60 * 1000;
const FUEL_SEHIR_LIST_CACHE_MS = 24 * 60 * 60 * 1000;
/** /api/tr-pulse içinde dönen deprem satırı üst sınırı (env: PULSE_QUAKE_LIMIT) */
const PULSE_QUAKE_LIMIT = Math.min(20, Math.max(1, Number(process.env.PULSE_QUAKE_LIMIT) || 4));
const MAX_ITEMS = Number(process.env.RSS_MAX_ITEMS) || 60;
/** İngilizce başlık/özet için MyMemory ücretsiz çevirisi (TRANSLATE_NEWS=0 ile kapatılır). */
const TRANSLATE_NEWS = process.env.TRANSLATE_NEWS !== "0";
const TRANSLATE_MAX_ITEMS = Number(process.env.TRANSLATE_MAX_ITEMS) || 45;
const TRANSLATE_CONCURRENCY = Math.min(
  5,
  Math.max(1, Number(process.env.TRANSLATE_CONCURRENCY) || 3)
);
/** RSS’te görsel kısaysa haber URL’sinden og:image ve meta açıklama oku (ENRICH_OG_IMAGE=0 ile kapatılır). */
const ENRICH_OG_IMAGE = process.env.ENRICH_OG_IMAGE !== "0";
const OG_ENRICH_MAX = Number(process.env.OG_ENRICH_MAX) || 72;
/** API önbelleğindeki son N haberde görsel veya kısa özet varsa kaynak HTML’den tamamlama */
const PAYLOAD_OG_ENRICH_MAX = Number(process.env.PAYLOAD_OG_ENRICH_MAX) || 40;
const OG_FETCH_MS = Number(process.env.OG_FETCH_MS) || 9000;
const OG_MEMO_MS = 40 * 60 * 1000;
/** RSS özetinden kısaysa haber linkindeki HTML’den meta açıklama tamamlanır (ENRICH_OG_IMAGE=0 ile kapanır). */
const EXCERPT_ENRICH_THRESHOLD = Number(process.env.EXCERPT_ENRICH_THRESHOLD) || 400;
/** Görsel ve/veya özet için haber sayfasına yapılacak üst sınır (tek tur). */
const ARTICLE_PAGE_META_MAX = Number(process.env.ARTICLE_PAGE_META_MAX) || Math.max(OG_ENRICH_MAX, 72);
/** RSS isteklerinde bot kimliği; kaynak sitelerin iletişim URL’si olarak kullanılır */
const OFFICIAL_SITE_URL = "https://www.gundemturkiye365.com";
const USER_AGENT = `Mozilla/5.0 (compatible; GundenTurkiye365/0.1; +${OFFICIAL_SITE_URL}/) Node.js`;

/** Google AdSense — otomatik reklamlar; HTML sayfalarında head içine eklenir */
const ADSENSE_HEAD_SNIPPET = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2721201902072867"
     crossorigin="anonymous"></script>`;
const ADSENSE_ACCOUNT_META = `<meta name="google-adsense-account" content="ca-pub-2721201902072867">`;
/** Google Tag Manager — GA4 vb. etiketleri GTM arayüzünden yönetin */
const GTM_HEAD_SNIPPET = `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-KWDNB2MG');</script>
<!-- End Google Tag Manager -->`;
const GTM_BODY_NOSCRIPT = `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KWDNB2MG"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`;

const feedsPath = path.join(__dirname, "feeds.json");
let feedsConfig = [];
try {
  feedsConfig = JSON.parse(fs.readFileSync(feedsPath, "utf8"));
} catch {
  feedsConfig = [];
}

const parser = new Parser({
  headers: { "User-Agent": USER_AGENT },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["dc:description", "dcDescription"],
    ],
  },
});

let cache = { at: 0, payload: null };
/** Aynı anda birden fazla istek refreshNewsCache çağırmasın (aggregate yalnızca bir kez çalışsın) */
let newsRefreshInFlight = null;
let pulseCache = { at: 0, payload: null };
let quakePulseCache = { at: 0, earthquakes: [], errors: [] };
let fxPulseCache = { at: 0, fx: null, fxNote: null, errors: [] };
/** Truncgil başarısız olsa bile döviz kutusunda son geçerli kur (bellek önbelleği). */
let fxLastGood = { at: 0, fx: null };

function fxPayloadUsable(fx) {
  return (
    fx &&
    (Number.isFinite(fx.usd) || Number.isFinite(fx.eur) || Number.isFinite(fx.gold))
  );
}
const CACHE_VERSION = 17;
/** Haber URL’leri ve Google site haritası için kanonik kök (örn. https://www.gundemturkiye365.com) */
const PUBLIC_SITE_ORIGIN = String(process.env.PUBLIC_SITE_ORIGIN || process.env.SITE_URL || "").replace(/\/$/, "");
/** Publisher Center’daki yayın adıyla uyumlu olmalı */
const NEWS_PUBLICATION_NAME = String(process.env.NEWS_PUBLICATION_NAME || "Gündem Türkiye 365").trim();
const NEWS_SITEMAP_ARTICLE_LIMIT = Math.min(
  1000,
  Math.max(1, Number(process.env.NEWS_SITEMAP_ARTICLE_LIMIT) || 1000)
);
/** Google Haber site haritası: yalnızca son N saat (varsayılan 48) */
const NEWS_SITEMAP_MAX_AGE_MS =
  Math.max(1, Number(process.env.NEWS_SITEMAP_MAX_AGE_HOURS) || 48) * 60 * 60 * 1000;
/** Site RSS (/rss.xml): kanalda en fazla kaç öğe (Telegram vb. için) */
const RSS_FEED_ITEM_LIMIT = Math.min(100, Math.max(1, Number(process.env.RSS_FEED_ITEM_LIMIT) || 40));
/** RSS &lt;description&gt; metni üst sınırı (karakter) */
const RSS_FEED_DESCRIPTION_MAX = Math.min(
  2000,
  Math.max(120, Number(process.env.RSS_FEED_DESCRIPTION_MAX) || 600)
);
/** Haber SQLite: `ts` (yayın zamanı) bundan eskiyse silinir */
const NEWS_DB_RETENTION_DAYS = Math.min(366, Math.max(1, Number(process.env.NEWS_DB_RETENTION_DAYS) || 14));
/** Arşiv silme işinin tekrarlanma aralığı (varsayılan 14 gün). Daha sık isterseniz örn. 86400000 (1 gün). */
const NEWS_DB_PURGE_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.NEWS_DB_PURGE_INTERVAL_MS) || 14 * 24 * 60 * 60 * 1000
);
/** Publisher Center → Google News yayın sayfası (yalnızca https://news.google.com/...). Footer + JSON-LD sameAs */
function sanitizeGoogleNewsPublicationUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return "";
    const h = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (h !== "news.google.com") return "";
    return parsed.href;
  } catch {
    return "";
  }
}
const GOOGLE_NEWS_PUBLICATION_URL = sanitizeGoogleNewsPublicationUrl(process.env.GOOGLE_NEWS_PUBLICATION_URL);
const PUBLISHER_JSONLD_ID = `${OFFICIAL_SITE_URL.replace(/\/$/, "")}/#publisher`;
const IMAGE_PROXY_MAX_BYTES = 6 * 1024 * 1024;

function scheduleNewsDbRetentionPurge() {
  if (newsDb.isDbDisabled()) return;
  const run = () => {
    newsDb
      .pruneArticlesOlderThan({ retentionDays: NEWS_DB_RETENTION_DAYS })
      .then((r) => {
        if (r && r.deleted > 0) {
          console.log(
            `Arşiv temizliği: ${r.deleted} haber kaydı silindi (yayın zamanı ${NEWS_DB_RETENTION_DAYS} günden eski).`
          );
        }
      })
      .catch((e) => console.warn("Arşiv temizliği:", e && e.message ? e.message : String(e)));
  };
  setTimeout(run, 120000);
  setInterval(run, NEWS_DB_PURGE_INTERVAL_MS);
}
/** Bazı kaynaklar bot User-Agent ile 403 döndürür; görsel vekili için tarayıcı benzeri UA kullanılır. */
const IMAGE_FETCH_UA =
  process.env.IMAGE_PROXY_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
/** @type {Map<string, { id: string, title: string, excerpt: string, image: string, link: string, pubDate: string, ts: number }>} */
const haberById = new Map();

const translateMemoryCache = new Map();
const TRANSLATE_CACHE_CAP = 500;

const FEED_CATEGORY_SLUGS = new Set([
  "gundem",
  "ekonomi",
  "dunya",
  "spor",
  "teknoloji",
  "kultur",
  "yasam",
  "video",
]);

function feedCategorySlug(cfg) {
  const c = String(cfg.category || "gundem")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
  return FEED_CATEGORY_SLUGS.has(c) ? c : "gundem";
}

function feedPrimaryTR(cfg) {
  const v = String(cfg.lang || cfg.locale || "").toLowerCase();
  if (v === "tr") return true;
  if (cfg.turkish === true) return true;
  if (String(cfg.region || "").toLowerCase() === "tr") return true;
  return false;
}

function looksMostlyTurkish(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/[ğüşıöç��ÜŞİÖÇ]/.test(t)) return true;
  if (
    /\b(ve|bir|için|ile|olan|bu|şu|de|da|mi|mı|mu|mü|Cumhurbaşkanı|Türkiye|İstanbul|Ankara|Antalya|Bakan)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function pickHttpLib(protocol) {
  if (protocol === "https:") return https;
  if (protocol === "http:") return http;
  throw new Error("Yalnızca http veya https desteklenir.");
}

/**
 * Node fetch bazı ortamlarda dış HTTPS için "fetch failed" verebiliyor; http/https ile tek GET.
 * Gövde tamamen tamponlanır (küçük/orta yanıtlar için).
 */
function httpGetBufferOnce(urlStr, { headers = {}, timeoutMs = 20000, maxBodyBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    let lib;
    try {
      lib = pickHttpLib(u.protocol);
    } catch (e) {
      reject(e);
      return;
    }
    const defaultPort = u.protocol === "https:" ? 443 : 80;
    let req;
    let settled = false;
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    }
    const timer = setTimeout(() => {
      if (req) req.destroy();
      finish(new Error("İstek zaman aşımı"));
    }, timeoutMs);
    req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || defaultPort,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        clearTimeout(timer);
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          if (maxBodyBytes != null) {
            size += c.length;
            if (size > maxBodyBytes) {
              res.destroy();
              finish(new Error("Yanıt çok büyük"));
              return;
            }
          }
          chunks.push(c);
        });
        res.on("end", () => {
          finish(null, {
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", (err) => finish(err));
    req.end();
  });
}

async function httpGetBufferFollow(urlStr, options = {}, maxRedirects = 5) {
  let current = String(urlStr);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await httpGetBufferOnce(current, options);
    const sc = res.statusCode;
    if (sc >= 300 && sc < 400 && res.headers.location) {
      const loc = String(res.headers.location).trim();
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error("Çok fazla HTTP yönlendirmesi");
}

/** 2xx yanıtta gövdeyi UTF-8 metin olarak döndürür. */
async function fetchUrlText(urlStr, options = {}) {
  const { maxRedirects = 5, ...onceOpts } = options;
  const r = await httpGetBufferFollow(urlStr, onceOpts, maxRedirects);
  if (r.statusCode < 200 || r.statusCode >= 300) {
    throw new Error(`HTTP ${r.statusCode}`);
  }
  return r.body.toString("utf8");
}

/** KOERI gibi ISO-8859-9 / Windows-1254 sayfalar için latin1 bayt eşlemesi (Türkçe yer adları). */
async function fetchUrlTextLatin1(urlStr, options = {}) {
  const { maxRedirects = 5, ...onceOpts } = options;
  const r = await httpGetBufferFollow(urlStr, onceOpts, maxRedirects);
  if (r.statusCode < 200 || r.statusCode >= 300) {
    throw new Error(`HTTP ${r.statusCode}`);
  }
  return r.body.toString("latin1");
}

async function fetchUrlAnyStatus(urlStr, options = {}, maxRedirects = 5) {
  const r = await httpGetBufferFollow(urlStr, options, maxRedirects);
  return { statusCode: r.statusCode || 0, text: r.body.toString("utf8") };
}

async function translateChunkEnToTr(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (looksMostlyTurkish(t)) return t;
  const key = crypto.createHash("sha256").update(t).digest("hex").slice(0, 40);
  if (translateMemoryCache.has(key)) return translateMemoryCache.get(key);
  const chunk = t.length > 420 ? `${t.slice(0, 417)}…` : t;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|tr`;
  let raw;
  try {
    raw = await fetchUrlText(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeoutMs: 15000,
      maxRedirects: 3,
    });
  } catch {
    return t;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return t;
  }
  let out = String(j?.responseData?.translatedText || "").trim();
  if (!out || out === chunk) out = t;
  if (/MYMEMORY\s*WARNING/i.test(out)) out = t;
  if (translateMemoryCache.size > TRANSLATE_CACHE_CAP) translateMemoryCache.clear();
  translateMemoryCache.set(key, out);
  return out;
}

async function mapWithConcurrency(arr, fn, n) {
  const ret = new Array(arr.length);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= arr.length) break;
      ret[i] = await fn(arr[i]);
    }
  };
  const workers = Math.min(n, Math.max(1, arr.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return ret;
}

async function translateIntlItem(it) {
  if (!TRANSLATE_NEWS) return it;
  if (it.primaryTR) return it;
  if (looksMostlyTurkish(it.title) && (!it.excerpt || looksMostlyTurkish(it.excerpt))) return it;
  try {
    const title = await translateChunkEnToTr(it.title);
    const rawEx = it.excerpt ? String(it.excerpt) : "";
    let excerpt = rawEx;
    if (rawEx && !looksMostlyTurkish(rawEx)) {
      /* MyMemory tek istekte ~420 karakter; uzun özetleri kesip çevirmek yerine tam metni koru */
      if (rawEx.length <= 420) {
        excerpt = (await translateChunkEnToTr(rawEx)) || rawEx;
      }
    }
    return { ...it, title: title || it.title, excerpt: excerpt || rawEx };
  } catch {
    return it;
  }
}

function sortGroupByImageThenTime(list) {
  const w = list.filter((i) => i.image).sort((a, b) => b.ts - a.ts);
  const n = list.filter((i) => !i.image).sort((a, b) => b.ts - a.ts);
  return [...w, ...n];
}

const articlePageMemo = new Map();

function extractOgImageFromHtml(html, baseUrl) {
  const chunk = String(html || "").slice(0, 500000);
  const m =
    chunk.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    chunk.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i) ||
    chunk.match(/property=["']og:image:url["']\s+content=["']([^"']+)["']/i) ||
    chunk.match(/name=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']/i);
  if (!m) return "";
  const raw = decodeHtmlEntities(m[1].trim());
  return resolveMediaUrl(raw, baseUrl) || normalizeMediaUrl(raw);
}

/** Haber URL’sindeki HTML’den düz metin özet (og:description, twitter:description, meta description). */
function extractMetaDescriptionFromHtml(html) {
  const chunk = String(html || "").slice(0, 450000);
  const stripLite = (s) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const patterns = [
    /property=["']og:description["']\s+content=["']([^"']*)["']/gi,
    /content=["']([^"']*)["']\s+property=["']og:description["']/gi,
    /name=["']twitter:description["']\s+content=["']([^"']*)["']/gi,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/gi,
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/gi,
  ];
  let best = "";
  for (const re of patterns) {
    const r = new RegExp(re.source, re.flags.replace("g", "") + "g");
    let m;
    while ((m = r.exec(chunk)) !== null) {
      const raw = m[1];
      if (!raw || !String(raw).trim()) continue;
      let t = decodeHtmlEntities(String(raw).trim());
      try {
        t = decodeHTML(t);
      } catch (_e) {}
      t = stripLite(t);
      if (t.length > best.length) best = t;
    }
  }
  return best;
}

async function fetchArticlePageMeta(pageUrl) {
  const canonical = String(pageUrl || "").trim().split("#")[0];
  if (!canonical || !/^https?:\/\//i.test(canonical)) return { image: "", description: "" };
  try {
    const u = new URL(canonical);
    if (!isSafeImageProxyHost(u.hostname)) return { image: "", description: "" };
  } catch {
    return { image: "", description: "" };
  }

  const memo = articlePageMemo.get(canonical);
  if (memo && Date.now() - memo.at < OG_MEMO_MS) {
    return {
      image: memo.image || "",
      description: memo.description || "",
    };
  }

  let image = "";
  let description = "";
  try {
    const r = await httpGetBufferFollow(
      canonical,
      {
        headers: {
          "User-Agent": IMAGE_FETCH_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        },
        timeoutMs: OG_FETCH_MS,
        maxBodyBytes: 500000,
      },
      6
    );
    if (r.statusCode < 200 || r.statusCode >= 300) {
      articlePageMemo.set(canonical, { image: "", description: "", at: Date.now() });
      return { image: "", description: "" };
    }
    const ct = String(r.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml") && !ct.includes("text/plain")) {
      articlePageMemo.set(canonical, { image: "", description: "", at: Date.now() });
      return { image: "", description: "" };
    }
    const html = r.body.toString("utf8");
    image = extractOgImageFromHtml(html, canonical) || "";
    description = extractMetaDescriptionFromHtml(html) || "";
  } catch {
    image = "";
    description = "";
  }
  articlePageMemo.set(canonical, { image, description, at: Date.now() });
  return { image, description };
}

function needsArticlePageEnrich(it) {
  if (!it || !it.link) return false;
  if (!String(it.image || "").trim()) return true;
  if (String(it.excerpt || "").trim().length < EXCERPT_ENRICH_THRESHOLD) return true;
  return false;
}

function mergePageMetaIntoExcerpt(rssExcerpt, pageDescription) {
  const maxLen = 250000;
  const norm = (s) =>
    String(s || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const a = norm(rssExcerpt);
  let b = norm(pageDescription);
  if (b.length > maxLen) b = `${b.slice(0, maxLen - 1)}…`;
  if (!b) return a;
  if (!a) return b;
  if (b.length > a.length && (b.length >= a.length + 60 || b.length >= Math.floor(a.length * 1.12))) return b;
  return a;
}

async function enrichDedupedFromArticlePages(deduped) {
  if (!ENRICH_OG_IMAGE || !deduped.length) return;
  const need = deduped.filter(needsArticlePageEnrich);
  if (!need.length) return;
  need.sort((a, b) => {
    const dt = (Number(b.ts) || 0) - (Number(a.ts) || 0);
    if (dt !== 0) return dt;
    if (a.primaryTR === b.primaryTR) return 0;
    return a.primaryTR ? -1 : 1;
  });
  const prioritized = need.slice(0, ARTICLE_PAGE_META_MAX);
  await mapWithConcurrency(
    prioritized,
    async (it) => {
      const { image, description } = await fetchArticlePageMeta(it.link);
      if (image && !String(it.image || "").trim()) it.image = image;
      const merged = mergePageMetaIntoExcerpt(it.excerpt, description);
      if (merged && merged !== it.excerpt) it.excerpt = merged;
    },
    4
  );
}

async function enrichItemsWithArticlePages(items, maxToEnrich) {
  if (!ENRICH_OG_IMAGE || !items || !items.length) return;
  const need = items.filter(needsArticlePageEnrich);
  if (!need.length) return;
  need.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const cap = Math.max(1, Number(maxToEnrich) || PAYLOAD_OG_ENRICH_MAX);
  const slice = need.slice(0, cap);
  await mapWithConcurrency(
    slice,
    async (it) => {
      const { image, description } = await fetchArticlePageMeta(it.link);
      if (image && !String(it.image || "").trim()) it.image = image;
      const merged = mergePageMetaIntoExcerpt(it.excerpt, description);
      if (merged && merged !== it.excerpt) it.excerpt = merged;
    },
    4
  );
}

async function enrichPayloadItemsWithArticlePages(items) {
  await enrichItemsWithArticlePages(items, PAYLOAD_OG_ENRICH_MAX);
}

function haberIdFromLink(link) {
  return crypto.createHash("sha256").update(String(link)).digest("base64url").slice(0, 24);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXmlText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getPublicSiteOrigin(req) {
  const fixed = PUBLIC_SITE_ORIGIN.replace(/\/$/, "");
  if (fixed) return fixed;
  try {
    const rawProto = req.get("x-forwarded-proto");
    const proto = String(rawProto || "")
      .split(",")[0]
      .trim()
      .split(/\s+/)[0];
    const p = proto || req.protocol || "https";
    const rawHost = req.get("x-forwarded-host") || req.get("host") || "";
    const host = String(rawHost).split(",")[0].trim().split(/\s+/)[0];
    if (!host) return "";
    if (/^localhost(?::\d+)?$/i.test(host) || /^127\.\d+\.\d+\.\d+(?::\d+)?$/.test(host)) return "";
    return `${p}://${host}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function truncateNewsTitle(title, maxLen) {
  const m = maxLen == null ? 110 : maxLen;
  const chars = Array.from(String(title || "").trim());
  if (chars.length <= m) return chars.join("");
  return chars.slice(0, Math.max(0, m - 1)).join("") + "…";
}

function publicationDateW3cForItem(item) {
  const raw = item.pubDate ? new Date(item.pubDate) : item.ts ? new Date(item.ts) : null;
  if (!raw || Number.isNaN(raw.getTime())) return "";
  const cap = new Date();
  const d = raw.getTime() > cap.getTime() ? cap : raw;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const pick = (t) => parts.find((x) => x.type === t)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+03:00`;
}

function buildNewsSitemapXml(origin, items) {
  const escName = escapeXmlText(NEWS_PUBLICATION_NAME);
  const now = Date.now();
  const cutoff = now - NEWS_SITEMAP_MAX_AGE_MS;
  const seen = new Set();
  const rows = [];
  const sorted = [...items].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  for (const it of sorted) {
    if (!it || !it.id || !it.title) continue;
    const ts = Number(it.ts) || (it.pubDate ? new Date(it.pubDate).getTime() : 0);
    if (!ts || ts < cutoff) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const pubDateStr = publicationDateW3cForItem(it);
    if (!pubDateStr) continue;
    const loc = `${origin}/haber/${encodeURIComponent(it.id)}`;
    const title = escapeXmlText(truncateNewsTitle(it.title, 110));
    rows.push(`  <url>
    <loc>${escapeXmlText(loc)}</loc>
    <news:news>
      <news:publication>
        <news:name>${escName}</news:name>
        <news:language>tr</news:language>
      </news:publication>
      <news:publication_date>${pubDateStr}</news:publication_date>
      <news:title>${title}</news:title>
    </news:news>
  </url>`);
    if (rows.length >= NEWS_SITEMAP_ARTICLE_LIMIT) break;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${rows.join("\n")}
</urlset>`;
}

/** Site haritası vb. için mevcut önbelleği veya taze aggregate sonucunu döndürür. */
async function loadNewsPayloadForSitemap() {
  const now = Date.now();
  const stale =
    !cache.payload ||
    cache.payload.v !== CACHE_VERSION ||
    !Array.isArray(cache.payload.items) ||
    (cache.payload.items.length > 0 && !cache.payload.items[0].id);
  let payload;
  if (!stale && now - cache.at < CACHE_MS) {
    payload = cache.payload;
  } else if (!feedsConfig.length) {
    payload = { v: CACHE_VERSION, items: [], errors: [], fetchedAt: new Date().toISOString() };
  } else {
    payload = await refreshNewsCache();
  }

  /** RSS turu boş dönerse (geçici ağ hatası vb.) Google’ın boş/kırık URL listesi görmesini azaltmak için arşivden doldur. */
  if (
    payload &&
    (!Array.isArray(payload.items) || payload.items.length === 0) &&
    !newsDb.isDbDisabled()
  ) {
    try {
      const lim = Math.min(1000, Math.max(NEWS_SITEMAP_ARTICLE_LIMIT, 120));
      const dbRes = await newsDb.listArticles({
        page: 1,
        pageSize: lim,
        requireNonEmptyImage: false,
        excludePromoTitles: true,
      });
      if (dbRes && dbRes.items && dbRes.items.length) {
        payload = {
          ...payload,
          v: payload.v ?? CACHE_VERSION,
          items: dbRes.items,
          errors: payload.errors || [],
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch (_e) {
      /* yoksay */
    }
  }

  return payload;
}

/** Genel site haritası: ana sayfa + son haber URL’leri (news-sitemap’ten ayrı; keşif için). */
const GENERAL_SITEMAP_HABER_LIMIT = Math.min(
  5000,
  Math.max(0, Number(process.env.GENERAL_SITEMAP_HABER_LIMIT) || 300)
);

function buildGeneralSitemapXml(origin, items) {
  const base = String(origin || "").replace(/\/$/, "");
  const esc = escapeXmlText;
  const nowIso = new Date().toISOString();
  const urls = [];
  urls.push(`  <url>
    <loc>${esc(`${base}/`)}</loc>
    <lastmod>${esc(nowIso)}</lastmod>
  </url>`);
  if (GENERAL_SITEMAP_HABER_LIMIT > 0 && items && items.length) {
    const sorted = [...items].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    let n = 0;
    for (const it of sorted) {
      if (!it || !it.id) continue;
      const loc = `${base}/haber/${encodeURIComponent(it.id)}`;
      const ts = Number(it.ts) || (it.pubDate ? new Date(it.pubDate).getTime() : 0);
      const lastmod = ts && !Number.isNaN(ts) ? new Date(ts).toISOString() : nowIso;
      urls.push(`  <url>
    <loc>${esc(loc)}</loc>
    <lastmod>${esc(lastmod)}</lastmod>
  </url>`);
      n++;
      if (n >= GENERAL_SITEMAP_HABER_LIMIT) break;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;
}

function rssPubDateRfc822(item) {
  const raw = item.pubDate ? new Date(item.pubDate) : item.ts ? new Date(item.ts) : null;
  if (!raw || Number.isNaN(raw.getTime())) return new Date().toUTCString();
  return raw.toUTCString();
}

function rssPlainDescription(excerpt, title, maxLen) {
  let t = String(excerpt || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) t = String(title || "").trim();
  if (t.length > maxLen) return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  return t;
}

function rssEnclosureMimeFromUrl(u) {
  const s = String(u || "")
    .split("?")[0]
    .toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  if (s.endsWith(".svg")) return "image/svg+xml";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

/** RSS &lt;enclosure&gt;: Telegram vb. botlar için kanonik görsel URL’si (görsel vekili). */
function rssItemEnclosureXml(base, item) {
  const imgUrl = safeHttpUrl(item.image);
  if (!imgUrl) return "";
  const safeLink =
    item.link && isSafeArticleOutboundUrl(item.link) ? String(item.link).trim() : "";
  const rel = safeLink
    ? `/api/image?u=${encodeURIComponent(imgUrl)}&r=${encodeURIComponent(safeLink)}`
    : `/api/image?u=${encodeURIComponent(imgUrl)}`;
  const fullUrl = `${String(base || "").replace(/\/$/, "")}${rel}`;
  const mime = rssEnclosureMimeFromUrl(imgUrl);
  return `\n      <enclosure url="${escapeXmlText(fullUrl)}" length="0" type="${escapeXmlText(mime)}" />`;
}

function buildSiteFeedRssXml(origin, items) {
  const base = String(origin || "").replace(/\/$/, "");
  const siteUrl = `${base}/`;
  const feedUrl = `${base}/rss.xml`;
  const esc = escapeXmlText;
  const channelTitle = esc(NEWS_PUBLICATION_NAME);
  const channelDesc = esc(
    "Türkiye ve dünyadan güncel haber özetleri; tam metin için sitedeki haber sayfasına yönlendirme."
  );
  const lastBuild = new Date().toUTCString();
  const sorted = [...items].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const itemBlocks = [];
  const seen = new Set();
  for (const it of sorted) {
    if (!it || !it.id || !it.title) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const link = `${base}/haber/${encodeURIComponent(it.id)}`;
    const descRaw = rssPlainDescription(it.excerpt, it.title, RSS_FEED_DESCRIPTION_MAX);
    const desc = esc(descRaw);
    const title = esc(truncateNewsTitle(it.title, 200));
    const pub = esc(rssPubDateRfc822(it));
    const enclosure = rssItemEnclosureXml(base, it);
    itemBlocks.push(`    <item>
      <title>${title}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${pub}</pubDate>
      <description>${desc}</description>${enclosure}
    </item>`);
    if (itemBlocks.length >= RSS_FEED_ITEM_LIMIT) break;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${channelTitle}</title>
    <link>${esc(siteUrl)}</link>
    <description>${channelDesc}</description>
    <language>tr</language>
    <ttl>15</ttl>
    <lastBuildDate>${esc(lastBuild)}</lastBuildDate>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml" />
${itemBlocks.join("\n")}
  </channel>
</rss>`;
}

function safeHttpUrl(u) {
  return normalizeMediaUrl(u);
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** RSS/HTML içinden çıkan görsel adresini güvenli mutlak https URL yapar. */
function normalizeMediaUrl(u) {
  let s = decodeHtmlEntities(String(u || "").trim());
  if (!s) return "";
  if (s.startsWith("//")) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

/** Göreli yolları haber bağlantısına göre mutlak URL yapar. */
function resolveMediaUrl(u, baseLink) {
  let s = decodeHtmlEntities(String(u || "").trim());
  if (!s) return "";
  if (s.startsWith("//")) s = "https:" + s;
  if (/^https?:\/\//i.test(s)) return normalizeMediaUrl(s);
  const base = String(baseLink || "").trim();
  if (!base) return "";
  try {
    return normalizeMediaUrl(new URL(s, base).href);
  } catch {
    return "";
  }
}

function itemLink(item) {
  const L = item && item.link;
  if (!L) return "";
  if (typeof L === "string") return L;
  if (typeof L === "object") {
    if (L.href) return String(L.href);
    if (L.$ && L.$.href) return String(L.$.href);
  }
  return String(L);
}

function plainGuid(guid) {
  if (!guid) return "";
  if (typeof guid === "string") return guid;
  if (typeof guid === "object" && guid._ != null) return String(guid._);
  return "";
}

/** Özel ağ / loopback dışındaki kamusal http(s) ana makineleri (görsel vekil + dış haber linki). */
function isSafeExternalHttpHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return false;
  if (h === "0.0.0.0" || h === "::1") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(h)) return false;
  if (h.endsWith(".onion")) return false;
  return true;
}

function isSafeImageProxyHost(hostname) {
  return isSafeExternalHttpHostname(hostname);
}

/** Haber sayfası URL’si; bazı CDN’ler görsel için bu Referer ister. */
function safeRefererForImageFetch(refParam, imageParsed) {
  const fallback = `${imageParsed.protocol}//${imageParsed.host}/`;
  const raw = String(refParam || "").trim();
  if (!raw || raw.length > 4000) return fallback;
  try {
    const refU = new URL(decodeHtmlEntities(raw));
    if (refU.protocol !== "http:" && refU.protocol !== "https:") return fallback;
    if (!isSafeImageProxyHost(refU.hostname)) return fallback;
    return refU.href;
  } catch {
    return fallback;
  }
}

function isSafeArticleOutboundUrl(href) {
  try {
    const u = new URL(String(href || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isSafeExternalHttpHostname(u.hostname);
  } catch {
    return false;
  }
}

let haberIndexEmbedCache = null;
let indexHtmlWithGoogleNewsMemo = null;

function applyGoogleNewsPublicationToIndexHtml(html) {
  let out = String(html || "");
  if (GOOGLE_NEWS_PUBLICATION_URL) {
    const escHref = escapeHtml(GOOGLE_NEWS_PUBLICATION_URL);
    const sameAsLd = safeJsonLd({
      "@context": "https://schema.org",
      "@id": PUBLISHER_JSONLD_ID,
      "@type": "NewsMediaOrganization",
      sameAs: [GOOGLE_NEWS_PUBLICATION_URL],
    });
    out = out.replace("<!--gnews:sameas-->", `<script type="application/ld+json">${sameAsLd}</script>`);
    out = out.replace(
      "<!--gnews:footer-block-->",
      `<li><a href="${escHref}" target="_blank" rel="noopener noreferrer">Google News'te takip edin</a></li>`
    );
  } else {
    out = out.replace("<!--gnews:sameas-->", "");
    out = out.replace("<!--gnews:footer-block-->", "");
  }
  return out;
}

/** index.html + isteğe bağlı Google News yayın URL’si (GOOGLE_NEWS_PUBLICATION_URL). */
function getIndexHtmlWithGoogleNewsPublication() {
  if (indexHtmlWithGoogleNewsMemo) return indexHtmlWithGoogleNewsMemo;
  const raw = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  indexHtmlWithGoogleNewsMemo = applyGoogleNewsPublicationToIndexHtml(raw);
  return indexHtmlWithGoogleNewsMemo;
}

/** Ana sayfa index.html ile aynı üst şerit, header, stiller ve footer (haber sayfası kabuğu). */
function getHaberPageEmbedFromIndex() {
  if (haberIndexEmbedCache) return haberIndexEmbedCache;
  const empty = { styles: "", topInner: "", footer: "" };
  try {
    const raw = getIndexHtmlWithGoogleNewsPublication();
    const mStyle = raw.match(/<style>\s*([\s\S]*?)\s*<\/style>/);
    const styles = mStyle ? mStyle[1].trim() : "";
    const iBody = raw.indexOf("<body");
    const iBodyTagEnd = iBody >= 0 ? raw.indexOf(">", iBody) + 1 : -1;
    const iHeadEnd = iBodyTagEnd >= 0 ? raw.indexOf("</header>", iBodyTagEnd) : -1;
    let topInner =
      iBodyTagEnd >= 0 && iHeadEnd >= iBodyTagEnd ? raw.slice(iBodyTagEnd, iHeadEnd + 9).trim() : "";
    topInner = topInner.replace(/href="#\//g, 'href="/#/');
    topInner = topInner.replace(/class="nav-cat is-active"/g, 'class="nav-cat"');
    const iFoot = raw.indexOf("<footer");
    const iFootEnd = raw.indexOf("</footer>", iFoot);
    const footer = iFoot >= 0 && iFootEnd >= iFoot ? raw.slice(iFoot, iFootEnd + 10).trim() : "";
    haberIndexEmbedCache = { styles, topInner, footer };
  } catch (e) {
    console.warn("Haber kabuğu index.html:", e.message || String(e));
    haberIndexEmbedCache = empty;
  }
  return haberIndexEmbedCache;
}

const HABER_EXTRA_STYLES = `
    .haber-reading { padding-top: 0.25rem; }
    .haber-reading h1 {
      font-family: "Instrument Serif", Georgia, serif;
      font-size: clamp(1.75rem, 4vw, 2.35rem);
      font-weight: 400;
      line-height: 1.2;
      margin: 0.35rem 0 1.25rem;
    }
    .haber-reading .haber-meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 1rem; }
    .haber-reading .lead {
      font-size: 1.08rem;
      color: var(--muted);
      line-height: 1.65;
      margin-bottom: 1.75rem;
      white-space: pre-line;
    }
    .haber-reading .haber-hero-fig {
      margin: 0 0 1.5rem;
      border-radius: var(--radius);
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--elevated);
    }
    .haber-reading .haber-hero-fig img { width: 100%; height: auto; display: block; vertical-align: middle; }
    .haber-reading .haber-external {
      margin-top: 2.25rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border-soft);
    }
    .haber-reading .haber-source-meta {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
      margin: 0 0 0.65rem;
    }
    .haber-reading .haber-source-meta strong { color: var(--text); font-weight: 600; }
    .haber-reading .haber-external-link { margin: 0; }
    .haber-reading .haber-external-link a { font-weight: 600; }
`;

const HABER_THEME_BOOT_SNIPPET = `<script>
    (function () {
      try {
        var k = "gundem365-theme";
        var v = localStorage.getItem(k) || localStorage.getItem("gundem360-theme");
        if (v === "dark") document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", "light");
      } catch (_e) {}
    })();
  </script>`;

const HABER_PAGE_INLINE_SCRIPT = `<script>
    (function () {
      var el = document.getElementById("topbar-date");
      if (el) {
        el.textContent =
          new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" }) +
          " — Ankara";
      }
      var inp = document.getElementById("search-input");
      if (inp) {
        inp.setAttribute("title", "Enter: ana sayfaya dönün; aramayı ana sayfada kullanın");
        inp.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            window.location.href = "/";
          }
        });
      }
      var THEME_KEY = "gundem365-theme";
      function applyThemeToggleUi() {
        var light = document.documentElement.getAttribute("data-theme") === "light";
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", light ? "#eef1f7" : "#0a0d12");
        var btn = document.getElementById("theme-toggle");
        if (!btn) return;
        btn.setAttribute("aria-pressed", light ? "true" : "false");
        btn.setAttribute("title", light ? "Koyu temaya geç" : "Açık temaya geç");
        var lab = btn.querySelector(".theme-toggle__label");
        if (lab) lab.textContent = light ? "Koyu tema" : "Açık tema";
        var ic = btn.querySelector(".theme-toggle__icon");
        if (ic) ic.textContent = light ? "☾" : "☀";
      }
      function setTheme(mode) {
        if (mode === "light") document.documentElement.setAttribute("data-theme", "light");
        else document.documentElement.removeAttribute("data-theme");
        try {
          localStorage.setItem(THEME_KEY, mode === "light" ? "light" : "dark");
          localStorage.removeItem("gundem360-theme");
        } catch (_e) {}
        applyThemeToggleUi();
      }
      var toggle = document.getElementById("theme-toggle");
      if (toggle) {
        toggle.addEventListener("click", function () {
          setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
        });
      }
      applyThemeToggleUi();
    })();
  </script>`;

function articleHostnameFromLink(link) {
  try {
    return new URL(String(link).trim()).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** feeds.json’daki liste adı + haber URL’si; arşivden açılanlarda yalnızca site adı görünür. */
function haberSourceBlockHtml(item) {
  if (!item || !item.link) return "";
  if (!isSafeArticleOutboundUrl(item.link)) {
    const feed = item.sourceFeedName ? escapeHtml(String(item.sourceFeedName).trim()) : "";
    const host = articleHostnameFromLink(item.link);
    const hostEsc = host ? escapeHtml(host) : "";
    let meta = "";
    if (feed && hostEsc) {
      meta = `<p class="haber-source-meta">Haber akışı: <strong>${feed}</strong> · Site: <strong>${hostEsc}</strong></p>`;
    } else if (feed) {
      meta = `<p class="haber-source-meta">Haber akışı: <strong>${feed}</strong></p>`;
    } else if (hostEsc) {
      meta = `<p class="haber-source-meta">Site: <strong>${hostEsc}</strong></p>`;
    }
    return `${meta}<p class="haber-external-link">Kaynak bağlantısı güvenlik politikası nedeniyle gösterilemiyor.</p>`;
  }
  const href = escapeHtml(String(item.link).trim());
  const host = articleHostnameFromLink(item.link);
  const hostEsc = host ? escapeHtml(host) : "";
  const feed = item.sourceFeedName ? escapeHtml(String(item.sourceFeedName).trim()) : "";
  let meta = "";
  if (feed && hostEsc) {
    meta = `<p class="haber-source-meta">Haber akışı: <strong>${feed}</strong> · Site: <strong>${hostEsc}</strong></p>`;
  } else if (feed) {
    meta = `<p class="haber-source-meta">Haber akışı: <strong>${feed}</strong></p>`;
  } else if (hostEsc) {
    meta = `<p class="haber-source-meta">Site: <strong>${hostEsc}</strong></p>`;
  }
  const linkText = hostEsc ? `Orijinal metin: ${hostEsc}` : "Kaynak sayfasını aç";
  return `<div class="haber-external">${meta}<p class="haber-external-link"><a href="${href}" target="_blank" rel="noopener noreferrer">${linkText}</a></p></div>`;
}

function renderHaberPage(item, req) {
  const brandEsc = escapeHtml(NEWS_PUBLICATION_NAME);
  const title = escapeHtml(item.title);
  const excerpt = escapeHtml(item.excerpt);
  const when = item.pubDate
    ? escapeHtml(new Date(item.pubDate).toLocaleString("tr-TR", { dateStyle: "long", timeStyle: "short" }))
    : "";
  const siteBase = canonicalSiteBase(req ? getPublicSiteOrigin(req) : "");
  const pageId = String(item.id || "").trim();
  const canonicalUrl = `${siteBase}/haber/${encodeURIComponent(pageId)}`;
  const imgUrl = safeHttpUrl(item.image);
  const safeLink = item.link && isSafeArticleOutboundUrl(item.link) ? String(item.link).trim() : "";
  const heroSrc = imgUrl && safeLink
    ? `/api/image?u=${encodeURIComponent(imgUrl)}&r=${encodeURIComponent(safeLink)}`
    : imgUrl
      ? `/api/image?u=${encodeURIComponent(imgUrl)}`
      : "";
  let ogImageAbs = "";
  if (imgUrl) {
    const q =
      `/api/image?u=${encodeURIComponent(imgUrl)}` +
      (safeLink ? `&r=${encodeURIComponent(safeLink)}` : "");
    ogImageAbs = `${siteBase}${q}`;
  }
  const heroImg = heroSrc
    ? `<figure class="haber-hero-fig"><img src="${escapeHtml(heroSrc)}" alt="${title}" width="1100" height="619" loading="lazy" /></figure>`
    : "";
  const srcLink = haberSourceBlockHtml(item);
  const seoHead = buildHaberHeadSeo(item, canonicalUrl, ogImageAbs, siteBase);

  const embed = getHaberPageEmbedFromIndex();
  if (!embed.styles || !embed.topInner) {
    return `<!DOCTYPE html>
<html lang="tr">
<head>
  ${GTM_HEAD_SNIPPET}
  <meta charset="UTF-8" />
  ${ADSENSE_HEAD_SNIPPET}
  ${ADSENSE_ACCOUNT_META}
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${seoHead}
  <title>${title} — ${brandEsc}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    :root { --bg:#0a0d12;--text:#e8ecf4;--muted:#8b96ab;--gold:#d4a853;--max:720px; }
    body{font-family:"Source Sans 3",system-ui,sans-serif;color:var(--text);background:var(--bg);padding:2rem}
    a{color:var(--gold)}
    .wrap{max-width:var(--max);margin:0 auto}
  </style>
</head>
<body>
${GTM_BODY_NOSCRIPT}
  <p><a href="/">← Ana sayfa</a></p>
  <article class="wrap">
    <h1>${title}</h1>
    ${heroImg}
    <p>${excerpt}</p>
    ${srcLink}
  </article>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  ${GTM_HEAD_SNIPPET}
  <meta charset="UTF-8" />
  ${HABER_THEME_BOOT_SNIPPET}
  ${ADSENSE_HEAD_SNIPPET}
  ${ADSENSE_ACCOUNT_META}
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#eef1f7" />
  ${seoHead}
  <title>${title} — ${brandEsc}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />
  <link rel="apple-touch-icon" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
${embed.styles}

${HABER_EXTRA_STYLES}
  </style>
</head>
<body>
${GTM_BODY_NOSCRIPT}
${embed.topInner}
  <main id="main-content">
    <article class="wrap haber-reading">
      ${when ? `<p class="haber-meta">${when}</p>` : ""}
      <h1>${title}</h1>
      ${heroImg}
      <p class="lead">${excerpt}</p>
      ${srcLink}
    </article>
  </main>
${embed.footer}
<script src="https://images.dmca.com/Badges/DMCABadgeHelper.min.js"></script>
<script async type="application/javascript" src="https://news.google.com/swg/js/v1/swg-basic.js"></script>
<script>
  (self.SWG_BASIC = self.SWG_BASIC || []).push((basicSubscriptions) => {
    basicSubscriptions.init({
      type: "NewsArticle",
      isPartOfType: ["Product"],
      isPartOfProductId: "CAowj4rLDA:openaccess",
      clientOptions: { theme: "light", lang: "tr" },
    });
  });
</script>
${HABER_PAGE_INLINE_SCRIPT}
</body>
</html>`;
}

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaDescriptionFromItem(item) {
  const raw = stripHtml(String((item && item.excerpt) || ""));
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "Haber özeti ve kaynak bağlantısı.";
  if (t.length <= 158) return t;
  return t.slice(0, 157) + "…";
}

function iso8601FromItemPub(item) {
  if (!item) return "";
  const d = new Date(item.pubDate || item.ts || 0);
  if (!d || Number.isNaN(d.getTime())) return "";
  const cap = new Date();
  if (d.getTime() > cap.getTime()) return cap.toISOString();
  return d.toISOString();
}

function safeJsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function canonicalSiteBase(reqOrigin) {
  const o = String(reqOrigin || "").replace(/\/$/, "");
  if (o) return o;
  return OFFICIAL_SITE_URL.replace(/\/$/, "");
}

function buildHaberHeadSeo(item, canonicalUrl, ogImageAbs, siteBase) {
  const brand = NEWS_PUBLICATION_NAME;
  const origin = String(siteBase || "").replace(/\/$/, "") || OFFICIAL_SITE_URL.replace(/\/$/, "");
  const publisherId = `${origin}/#publisher`;
  const title = escapeHtml(String(item.title || "").trim() || "Haber");
  const desc = escapeHtml(metaDescriptionFromItem(item));
  const ogImgBlock = ogImageAbs
    ? `<meta property="og:image" content="${escapeHtml(ogImageAbs)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageAbs)}" />`
    : "";
  const pub = iso8601FromItemPub(item);
  const pubTag = pub ? `<meta property="article:published_time" content="${escapeHtml(pub)}" />` : "";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: String(item.title || "").trim().slice(0, 200),
    inLanguage: "tr",
    url: canonicalUrl,
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
    description: metaDescriptionFromItem(item).slice(0, 320),
    publisher: {
      "@type": "NewsMediaOrganization",
      "@id": publisherId,
      name: brand,
      logo: { "@type": "ImageObject", url: `${origin}/favicon.svg` },
    },
  };
  if (GOOGLE_NEWS_PUBLICATION_URL) {
    jsonLd.publisher.sameAs = [GOOGLE_NEWS_PUBLICATION_URL];
  }
  if (ogImageAbs) jsonLd.image = [ogImageAbs];
  if (pub) jsonLd.datePublished = pub;
  return `<meta name="description" content="${desc}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${escapeHtml(brand)}" />
  <meta property="og:title" content="${title} — ${escapeHtml(brand)}" />
  <meta property="og:description" content="${desc}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:locale" content="tr_TR" />
  ${ogImgBlock}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${desc}" />
  ${pubTag}
  <script type="application/ld+json">${safeJsonLd(jsonLd)}</script>`;
}

function isLikelyDecorativeImageUrl(url) {
  return /favicon|\/icons?\/|logo[_-]?small|1x1|pixel\.gif|spacer|blank\.gif|gravatar\.com\/avatar|quantserve|\/ad[s/]/i.test(
    url
  );
}

function isLikelySmallUiThumb(url, imgTag) {
  if (isLikelyDecorativeImageUrl(url)) return true;
  if (/\/\d{1,3}px-[^/]+\.(png|svg|webp|gif)(\?|$)/i.test(url)) {
    if (/\/(1[0-9]px|20px|2[0-9]px|30px|40px|50px)-/i.test(url)) return true;
  }
  if (imgTag) {
    const w = imgTag.match(/\bwidth=["']?(\d+)/i);
    const h = imgTag.match(/\bheight=["']?(\d+)/i);
    if (w && Number(w[1]) > 0 && Number(w[1]) < 72) return true;
    if (h && Number(h[1]) > 0 && Number(h[1]) < 72) return true;
  }
  return false;
}

function firstSrcFromSrcset(value) {
  if (!value) return "";
  const part = String(value).split(",")[0].trim();
  return part.split(/\s+/)[0] || "";
}

function srcFromImgTag(tag) {
  const lazy =
    tag.match(/\sdata-src=["']([^"']+)["']/i) ||
    tag.match(/\sdata-lazy-src=["']([^"']+)["']/i) ||
    tag.match(/\sdata-original=["']([^"']+)["']/i);
  if (lazy) return lazy[1];
  const srcsetM = tag.match(/\ssrcset=["']([^"']+)["']/i);
  if (srcsetM) return firstSrcFromSrcset(srcsetM[1]);
  const srcM =
    tag.match(/\ssrc=["']([^"']+)["']/i) ||
    tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i) ||
    tag.match(/\ssrc=([^\s>]+)/i);
  return srcM ? srcM[1] : "";
}

function firstImageUrl(item, baseLink) {
  const base = baseLink || itemLink(item);

  if (typeof item.image === "string" && item.image.trim()) {
    const u = resolveMediaUrl(item.image, base);
    if (u) return u;
  }
  if (item.image && typeof item.image === "object" && item.image.url) {
    const u = resolveMediaUrl(item.image.url, base);
    if (u) return u;
  }

  if (item.itunes && item.itunes.image) {
    const u = resolveMediaUrl(String(item.itunes.image), base);
    if (u) return u;
  }

  const itunes = item["itunes:image"];
  if (itunes && itunes.$ && itunes.$.href) {
    const u = resolveMediaUrl(itunes.$.href, base);
    if (u) return u;
  }

  const enc = item.enclosure;
  if (enc && enc.url) {
    const type = String(enc.type || "").toLowerCase();
    const extOk = /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(enc.url);
    if (type.startsWith("image/") || extOk) {
      const u = resolveMediaUrl(enc.url, base);
      if (u) return u;
    }
  }

  const mcRaw = item.mediaContent || item["media:content"];
  const mcList = Array.isArray(mcRaw) ? mcRaw : mcRaw ? [mcRaw] : [];
  for (const mc of mcList) {
    const url = mc && mc.$ && mc.$.url;
    const medium = mc && mc.$ && mc.$.medium;
    const type = mc && mc.$ && mc.$.type;
    if (!url) continue;
    if (medium && medium !== "image") {
      if (!String(type || "").toLowerCase().startsWith("image/")) continue;
    }
    const u = resolveMediaUrl(url, base);
    if (u) return u;
  }

  const mtRaw = item.mediaThumbnail || item["media:thumbnail"];
  const mtList = Array.isArray(mtRaw) ? mtRaw : mtRaw ? [mtRaw] : [];
  const thumbCandidates = [];
  for (const th of mtList) {
    if (!th) continue;
    const url = th.$ && th.$.url ? th.$.url : typeof th.url === "string" ? th.url : "";
    if (!url) continue;
    const w = th.$ && th.$.width ? parseInt(th.$.width, 10) : 0;
    thumbCandidates.push({ url, w: Number.isFinite(w) ? w : 0 });
  }
  thumbCandidates.sort((a, b) => b.w - a.w);
  for (const c of thumbCandidates) {
    const u = resolveMediaUrl(c.url, base);
    if (u) return u;
  }

  const thumb = !Array.isArray(item["media:thumbnail"]) ? item["media:thumbnail"] : null;
  if (thumb && thumb.$ && thumb.$.url) {
    const u = resolveMediaUrl(thumb.$.url, base);
    if (u) return u;
  }
  if (thumb && typeof thumb === "object" && thumb.url) {
    const u = resolveMediaUrl(thumb.url, base);
    if (u) return u;
  }

  const chunks = [
    item["content:encoded"],
    item.content,
    item.summary,
    item.description,
  ].filter(Boolean);
  const blob = chunks.join("\n");
  if (!blob) return "";

  let m =
    blob.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    blob.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i) ||
    blob.match(/name=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']/i);
  if (m) {
    const u = resolveMediaUrl(m[1], base);
    if (u) return u;
  }

  const imgTagRe = /<img\b[^>]*>/gi;
  let tagMatch;
  let fallback = "";
  while ((tagMatch = imgTagRe.exec(blob))) {
    const tag = tagMatch[0];
    const cand = srcFromImgTag(tag);
    if (!cand) continue;
    const u = resolveMediaUrl(cand, base);
    if (!u || isLikelyDecorativeImageUrl(u)) continue;
    if (!isLikelySmallUiThumb(u, tag)) return u;
    if (!fallback) fallback = u;
  }
  if (fallback) return fallback;

  const linkImg = blob.match(/<a[^>]+href=["']([^"']+\.(?:jpe?g|png|webp|gif))(?:\?[^"']*)?["']/i);
  if (linkImg) {
    const u = resolveMediaUrl(linkImg[1], base);
    if (u && !isLikelyDecorativeImageUrl(u)) return u;
  }

  return "";
}

/**
 * RSS/xml2js alanından ham HTML çıkar (dizi, CDATA nesnesi, iç içe content).
 * rss-parser içindeki getContent, karmaşık düğümleri serileştirir.
 */
function itemFieldToHtml(val) {
  if (val == null || val === "") return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((x) => itemFieldToHtml(x))
      .filter((s) => s && String(s).trim())
      .join("\n");
  }
  if (typeof val === "object") {
    if (typeof val._ === "string") return val._;
    if (typeof val.content === "string") return val.content;
    if (val.content && typeof val.content === "object" && typeof val.content._ === "string") return val.content._;
    if (typeof val["#text"] === "string") return val["#text"];
    try {
      return rssGetContent(val);
    } catch (_e) {
      return "";
    }
  }
  return "";
}

function plainTextFromItemField(val) {
  const html = itemFieldToHtml(val);
  if (!html.trim()) return "";
  const stripped = rssStripHtml(html);
  let text;
  try {
    text = decodeHTML(stripped);
  } catch (_e) {
    text = stripped;
  }
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Veritabanı excerpt üst sınırı (news-db.js ile uyumlu) */
const MAX_EXCERPT_FROM_FEED = 250000;

function excerptFromFeedItem(raw) {
  if (!raw || typeof raw !== "object") return "";
  const keys = [
    "content:encoded",
    "content",
    "summary",
    "description",
    "dcDescription",
    "contentSnippet",
    "content:encodedSnippet",
  ];
  let best = "";
  for (const k of keys) {
    if (raw[k] == null || raw[k] === "") continue;
    const t = plainTextFromItemField(raw[k]);
    if (t.length > best.length) best = t;
  }
  const itunes = raw.itunes;
  if (itunes && typeof itunes === "object") {
    const t = plainTextFromItemField(itunes.summary);
    if (t.length > best.length) best = t;
  }
  if (!best) return "";
  if (best.length <= MAX_EXCERPT_FROM_FEED) return best;
  return `${best.slice(0, MAX_EXCERPT_FROM_FEED - 1)}…`;
}

function normalizeItem(raw) {
  const link = itemLink(raw) || plainGuid(raw.guid) || "";
  const title = stripHtml(raw.title) || "Başlıksız";
  const excerpt = excerptFromFeedItem(raw);
  const pub = raw.pubDate || raw.isoDate || "";
  const t = pub ? new Date(pub).getTime() : 0;
  const image = firstImageUrl(raw, link);
  return {
    title,
    link,
    excerpt,
    pubDate: pub,
    ts: t || 0,
    image: image || "",
  };
}

async function fetchFeed(cfg) {
  const primaryTR = feedPrimaryTR(cfg);
  const category = feedCategorySlug(cfg);
  const feed = await parser.parseURL(cfg.url);
  let items = (feed.items || []).map((it) => ({
    ...normalizeItem(it),
    primaryTR,
    category,
    sourceFeedName: String(cfg.name || "").trim(),
    sourceRssUrl: String(cfg.url || "").trim(),
  }));
  const cap = cfg.maxItems != null ? Number(cfg.maxItems) : NaN;
  if (Number.isFinite(cap) && cap > 0) {
    items.sort((a, b) => b.ts - a.ts);
    items = items.slice(0, cap);
  }
  return { ok: true, url: cfg.url, name: cfg.name, items };
}

const TITLE_DEDUPE_STOPWORDS = new Set([
  "ve",
  "veya",
  "bir",
  "için",
  "ile",
  "olan",
  "bu",
  "şu",
  "o",
  "de",
  "da",
  "daha",
  "bile",
  "mi",
  "mı",
  "mu",
  "mü",
  "en",
  "ki",
  "gibi",
  "son",
  "dakika",
  "haber",
  "haberi",
  "bildirdi",
  "dedi",
  "oldu",
  "etti",
  "açıkladı",
  "söyledi",
  "kadar",
  "var",
  "yok",
  "sonra",
  "önce",
  "karşı",
  "içinde",
  "üzerine",
  "konu",
  "edildi",
  "edilen",
  "turkiye",
  "türkiye",
  "dünya",
]);

function stripBreakingTitleDecorations(title) {
  let s = String(title || "").trim();
  s = s.replace(/^\s*(son\s*dakika|flaş|flash|breaking|son\s*gelişme)\s*[:\-|·]\s*/i, "");
  s = s.replace(/^[\s"'“”‘’«»\-—]+/, "").trim();
  return s;
}

function normalizeTitleForDedupe(title) {
  const base = stripBreakingTitleDecorations(stripHtml(title))
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base;
}

function titleDedupeTokens(norm) {
  if (!norm) return [];
  return norm.split(" ").filter((w) => w.length > 2 && !TITLE_DEDUPE_STOPWORDS.has(w));
}

function titleJaccardFromNormalized(normA, normB) {
  const ta = titleDedupeTokens(normA);
  const tb = titleDedupeTokens(normB);
  if (ta.length < 3 || tb.length < 3) return normA && normA === normB ? 1 : 0;
  const A = new Set(ta);
  const B = new Set(tb);
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter++;
  }
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function titlesNearDuplicate(titleA, titleB) {
  const na = normalizeTitleForDedupe(titleA);
  const nb = normalizeTitleForDedupe(titleB);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 28 && nb.length >= 28 && (na.includes(nb) || nb.includes(na))) return true;
  const jac = titleJaccardFromNormalized(na, nb);
  if (jac >= 0.78) return true;
  const minLen = Math.min(na.length, nb.length);
  if (minLen >= 36 && jac >= 0.65) return true;
  return false;
}

/** Aynı/benzer başlık, farklı kaynak linki: zaman damgasına göre en günceli bırak */
function dedupeItemsBySimilarTitlePreferNewest(items) {
  const sorted = [...items].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const kept = [];
  for (const it of sorted) {
    let dup = false;
    for (const k of kept) {
      if (titlesNearDuplicate(it.title, k.title)) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(it);
  }
  return kept;
}

/** TR + uluslararası sırasını koruyarak yinelenen başlıkları at (önce görünen kalır) */
function dedupeOrderedBySimilarTitleStable(orderedList) {
  const kept = [];
  for (const it of orderedList) {
    let dup = false;
    for (const k of kept) {
      if (titlesNearDuplicate(it.title, k.title)) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(it);
  }
  return kept;
}

async function aggregate() {
  const results = await Promise.allSettled(
    feedsConfig.map((f) => fetchFeed(f))
  );

  const all = [];
  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value.ok) {
      all.push(...r.value.items);
    }
  });

  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    if (!it.link) continue;
    const key = it.link.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }

  const dedupedByTitle = dedupeItemsBySimilarTitlePreferNewest(deduped);

  await enrichDedupedFromArticlePages(dedupedByTitle);

  const trItems = dedupedByTitle.filter((it) => it.primaryTR);
  const intlItems = dedupedByTitle.filter((it) => !it.primaryTR);
  const trOrdered = sortGroupByImageThenTime(trItems);
  const intlSorted = sortGroupByImageThenTime(intlItems);

  const toTranslate = intlSorted.slice(0, TRANSLATE_MAX_ITEMS);
  const intlTail = intlSorted.slice(TRANSLATE_MAX_ITEMS);
  const translatedHead = await mapWithConcurrency(toTranslate, translateIntlItem, TRANSLATE_CONCURRENCY);
  const intlFinal = [...translatedHead, ...intlTail];

  /** Önce Türkçe kaynaklar (görselli öncelik), ardından yabancı (çeviri uygulanmış). */
  let ordered = [...trOrdered, ...intlFinal];
  ordered = dedupeOrderedBySimilarTitleStable(ordered);

  try {
    const archiveRows = ordered.map((it) => {
      const { primaryTR: _tr, ...rest } = it;
      const id = haberIdFromLink(rest.link);
      return {
        id,
        title: rest.title,
        excerpt: rest.excerpt,
        pubDate: rest.pubDate,
        ts: rest.ts,
        image: rest.image || "",
        link: rest.link,
        category: rest.category || "gundem",
      };
    });
    await newsDb.upsertArticles(archiveRows);
  } catch (e) {
    console.warn("Haber arşivi (SQLite):", e.message || String(e));
  }

  haberById.clear();
  const items = ordered.slice(0, MAX_ITEMS).map((it) => {
    const { primaryTR: _tr, ...rest } = it;
    const id = haberIdFromLink(rest.link);
    const row = {
      id,
      title: rest.title,
      excerpt: rest.excerpt,
      pubDate: rest.pubDate,
      ts: rest.ts,
      image: rest.image,
      link: rest.link,
      category: rest.category || "gundem",
      sourceFeedName: rest.sourceFeedName || "",
      sourceRssUrl: rest.sourceRssUrl || "",
    };
    haberById.set(id, row);
    return row;
  });

  try {
    await enrichPayloadItemsWithArticlePages(items);
  } catch (e) {
    console.warn("Payload kaynak sayfası (görsel/özet):", e.message || String(e));
  }

  try {
    await newsDb.upsertArticles(items);
  } catch (_e) {
    /* arşiv isteğe bağlı */
  }

  return {
    v: CACHE_VERSION,
    items,
    errors: [],
    fetchedAt: new Date().toISOString(),
  };
}

async function refreshNewsCache() {
  if (newsRefreshInFlight) {
    return newsRefreshInFlight;
  }
  newsRefreshInFlight = (async () => {
    try {
      const payload = await aggregate();
      cache = { at: Date.now(), payload };
      return payload;
    } finally {
      newsRefreshInFlight = null;
    }
  })();
  return newsRefreshInFlight;
}

function newsPayloadLooksUsable(p) {
  return (
    p &&
    p.v === CACHE_VERSION &&
    Array.isArray(p.items) &&
    p.items.length > 0 &&
    !!p.items[0].id
  );
}

function inTurkeyBounds(lat, lon) {
  return lat >= 35.5 && lat <= 42.5 && lon >= 25.5 && lon <= 45.5;
}

/** USGS place: "36 km SSE of Finike, Turkey" → Türkçe açıklama */
const USGS_WIND_EN_TR = {
  N: "kuzey",
  NNE: "kuzey-kuzeydoğu",
  NE: "kuzeydoğu",
  ENE: "doğu-kuzeydoğu",
  E: "doğu",
  ESE: "doğu-güneydoğu",
  SE: "güneydoğu",
  SSE: "güney-güneydoğu",
  S: "güney",
  SSW: "güney-güneybatı",
  SW: "güneybatı",
  WSW: "batı-güneybatı",
  W: "batı",
  WNW: "batı-kuzeybatı",
  NW: "kuzeybatı",
  NNW: "kuzey-kuzeybatı",
};

function localizeQuakePlace(place) {
  let s = String(place || "").trim();
  if (!s || s === "—") return s;

  const usgs = /^([\d.]+)\s*km\s+([A-Za-z]{1,3})\s+of\s+(.+)$/i.exec(s);
  if (usgs) {
    const km = usgs[1];
    const wind = usgs[2].toUpperCase();
    let loc = String(usgs[3]).trim();
    loc = loc.replace(/,\s*Turkey\s*$/i, "").trim();
    const dir = USGS_WIND_EN_TR[wind] || usgs[2].toLowerCase();
    return `${loc} merkezine yaklaşık ${km} km (${dir} yönünde)`;
  }

  s = s.replace(/,\s*Turkey\s*$/i, " (Türkiye)");
  s = s.replace(/\bTurkey\b/gi, "Türkiye");
  s = s.replace(/\bIran\b/gi, "İran");
  s = s.replace(/\bIraq\b/gi, "Irak");
  s = s.replace(/\bSyria\b/gi, "Suriye");
  s = s.replace(/\bGreece\b/gi, "Yunanistan");
  s = s.replace(/\bGeorgia\b/gi, "Gürcistan");
  s = s.replace(/\bBulgaria\b/gi, "Bulgaristan");
  s = s.replace(/\bArmenia\b/gi, "Ermenistan");
  s = s.replace(/\bCyprus\b/gi, "Kıbrıs");
  return s;
}

/**
 * AFAD olay zamanı çoğu kaynakta UTC; ofset yoksa yerel TR sanıp +03 eklemek 3 saat kaydırır.
 * Ofsetsiz ISO benzeri dizgileri UTC (Z) kabul edip ISO'ya çevirir.
 */
function normalizeAfadEventDateIso(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s);
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${m[3] || ""}Z`);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function mapAfadEvent(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mag = Number(
    r.magnitude ?? r.mag ?? r.ml ?? r.Ml ?? r.Mw ?? r.ML ?? r.Mb ?? 0
  );
  const lat = Number(r.latitude ?? r.lat ?? r.Latitude ?? r.enlem);
  const lon = Number(r.longitude ?? r.lon ?? r.Longitude ?? r.boylam);
  const depthRaw = r.depth ?? r.Depth ?? r.derinlik ?? null;
  const depth = depthRaw != null && depthRaw !== "" ? Number(depthRaw) : null;
  const place = String(
    r.location ?? r.Location ?? r.place ?? r.title ?? r.il ?? r.district ?? ""
  ).trim();
  const dateRaw = String(
    r.eventDate ?? r.event_date ?? r.date ?? r.time ?? r.Date ?? r.eventdate ?? ""
  ).trim();
  const id = String(r.eventID ?? r.eventId ?? r.id ?? r.eventid ?? "");
  return {
    id,
    mag,
    lat,
    lon,
    depth,
    place: localizeQuakePlace(place || "—"),
    date: normalizeAfadEventDateIso(dateRaw),
  };
}

const AFAD_JSON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
  "User-Agent": IMAGE_FETCH_UA,
  Referer: "https://deprem.afad.gov.tr/",
  Origin: "https://deprem.afad.gov.tr",
};

/** AFAD filtre parametreleri çoğu örnekte Türkiye duvar saati (takvim) ile veriliyor; UTC ile uçlar kayabiliyor. */
function afadIsoParamIstanbul(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

function buildAfadFilterUrl(daysBack) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, Number(daysBack) || 7) * 86400000);
  const qs = new URLSearchParams({
    start: afadIsoParamIstanbul(start),
    end: afadIsoParamIstanbul(end),
    limit: "500",
    orderby: "timedesc",
  });
  return `https://deprem.afad.gov.tr/apiv2/event/filter?${qs}`;
}

function parseAfadJsonToEventRows(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("AFAD geçerli JSON dönmedi");
  }
  const arr = Array.isArray(data)
    ? data
    : data?.events || data?.items || data?.data || data?.result || data?.Result || [];
  if (!Array.isArray(arr)) {
    throw new Error("AFAD veri biçimi beklenenden farklı");
  }
  return arr;
}

/** AFAD + KOERI aynı olayı farklı id ile gönderebilir; zaman + yaklaşık konum ile tekilleştirilir. */
function afadQuakeDedupKey(e) {
  const ta = Date.parse(String(e.date || "")) || 0;
  const lat = Number(e.lat);
  const lon = Number(e.lon);
  if (ta && Number.isFinite(lat) && Number.isFinite(lon)) {
    return `t:${ta}:g:${Math.round(lat * 500)}:${Math.round(lon * 500)}`;
  }
  const id = e && e.id != null ? String(e.id).trim() : "";
  if (id) return `id:${id}`;
  return `geo:${e.lat},${e.lon},${e.date}`;
}

function poolFromAfadRawRows(rows) {
  const mapped = rows.map(mapAfadEvent).filter((e) => Number.isFinite(e.mag) && e.mag > 0);
  const seen = new Set();
  const deduped = [];
  for (const e of mapped) {
    const k = afadQuakeDedupKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }
  deduped.sort((a, b) => {
    const ta = Date.parse(String(a.date || "")) || 0;
    const tb = Date.parse(String(b.date || "")) || 0;
    return tb - ta;
  });
  const withCoords = deduped.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  const tr = withCoords.filter((e) => inTurkeyBounds(e.lat, e.lon));
  const pool = tr.length ? tr : withCoords.length ? withCoords : deduped;
  return pool.slice(0, PULSE_QUAKE_LIMIT);
}

function earthquakesFromAfadJsonText(raw) {
  return poolFromAfadRawRows(parseAfadJsonToEventRows(raw));
}

const KOERI_LST1_URL = "http://www.koeri.boun.edu.tr/scripts/lst1.asp";

function koeriPickMag(mdRaw, mlRaw, mwRaw) {
  let best = 0;
  for (const raw of [mlRaw, mdRaw, mwRaw]) {
    const s = String(raw ?? "").trim();
    if (!s || s === "-.-" || s === "--" || s === "-") continue;
    const n = Number(s.replace(",", "."));
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/** lst1.asp satırını AFAD mapAfadEvent ile uyumlu ham nesneye çevirir (tarih: Türkiye +03). */
function koeriLineToAfadLikeRow(m) {
  const y = m[1];
  const mo = m[2];
  const d = m[3];
  const t = m[4];
  const lat = Number(m[5]);
  const lon = Number(m[6]);
  const depth = Number(m[7]);
  const mag = koeriPickMag(m[8], m[9], m[10]);
  let place = String(m[11] || "").replace(/\*+/g, "").trim();
  place = place.replace(/\s+(İlksel|ILKSEL|lksel|Ýlksel|ýlksel)\s*$/i, "").trim();
  const eventDate = `${y}-${mo}-${d}T${t}+03:00`;
  const id = `koeri:${y}${mo}${d}${t.replace(/:/g, "")}:${String(lat)}:${String(lon)}`;
  return {
    eventID: id,
    magnitude: mag,
    latitude: lat,
    longitude: lon,
    depth,
    location: place || "—",
    eventDate,
  };
}

function parseKoeriLst1AspText(html) {
  const rows = [];
  let body = String(html || "");
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(body);
  if (pre) body = pre[1];
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  /** Tarih saat enlem boylam derinlik MD ML Mw Yer (satır sonu: çözüm sütunu, latin1’de Ýlksel vb.) */
  const lineRe =
    /^\s*(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00a0/g, " ").trim();
    if (!line || line.length < 40) continue;
    if (!/^\d{4}\.\d{2}\.\d{2}\s/.test(line)) continue;
    const m = lineRe.exec(line);
    if (!m) continue;
    const mag = koeriPickMag(m[8], m[9], m[10]);
    if (!Number.isFinite(mag) || mag <= 0) continue;
    if (!Number.isFinite(Number(m[5])) || !Number.isFinite(Number(m[6]))) continue;
    rows.push(koeriLineToAfadLikeRow(m));
  }
  return rows;
}

async function fetchKoeriLst1RawRows() {
  const raw = await fetchUrlTextLatin1(`${KOERI_LST1_URL}?_=${Date.now()}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,text/plain,*/*",
      Referer: "http://www.koeri.boun.edu.tr/",
      "Cache-Control": "no-cache",
    },
    timeoutMs: 28000,
    maxRedirects: 5,
  });
  const rows = parseKoeriLst1AspText(raw);
  if (!rows.length) {
    throw new Error("KOERI lst1 satırı çözülemedi veya liste boş");
  }
  return rows;
}

async function fetchAfadMergedJsonRawRows() {
  const ts = Date.now();
  const urls = [
    `https://deprem.afad.gov.tr/apiv2/event/latest?_=${ts}`,
    `${buildAfadFilterUrl(7)}&_=${ts}`,
  ];
  const headers = {
    ...AFAD_JSON_HEADERS,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  const settled = await Promise.allSettled(
    urls.map((url) => fetchUrlText(url, { headers, timeoutMs: 25000, maxRedirects: 5 }))
  );
  const mergedRows = [];
  let firstErr = null;
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status !== "fulfilled") {
      const m = s.reason && s.reason.message ? String(s.reason.message) : String(s.reason);
      const wrapped = /^HTTP \d+/.test(m) ? new Error(`AFAD yanıtı ${m.replace(/^HTTP /, "")}`) : s.reason;
      if (!firstErr) firstErr = wrapped;
      continue;
    }
    try {
      mergedRows.push(...parseAfadJsonToEventRows(s.value));
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
  }
  if (!mergedRows.length) {
    throw firstErr || new Error("AFAD yanıt alınamadı");
  }
  return mergedRows;
}

/** AFAD bazı barındırma ortamlarından erişilemeyebilir; Türkiye kutusu için USGS yedeği. */
async function fetchUsgsAnatoliaFallback() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  const qs = new URLSearchParams({
    format: "geojson",
    starttime: start.toISOString().slice(0, 10),
    endtime: end.toISOString().slice(0, 10),
    minlatitude: "35",
    maxlatitude: "43",
    minlongitude: "25",
    maxlongitude: "46",
    minmagnitude: "2.5",
    orderby: "time",
    limit: "16",
  });
  let raw;
  try {
    raw = await fetchUrlText(`https://earthquake.usgs.gov/fdsnws/event/1/query?${qs}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json,application/json" },
      timeoutMs: 25000,
      maxRedirects: 5,
    });
  } catch (e) {
    const m = e && e.message ? String(e.message) : String(e);
    if (/^HTTP \d+/.test(m)) throw new Error(`USGS yanıtı ${m.replace(/^HTTP /, "")}`);
    throw e;
  }
  let gj;
  try {
    gj = JSON.parse(raw);
  } catch {
    throw new Error("USGS geçerli JSON dönmedi");
  }
  const feats = Array.isArray(gj?.features) ? gj.features : [];
  return feats.slice(0, PULSE_QUAKE_LIMIT).map((f) => {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    const lon = Array.isArray(c) ? Number(c[0]) : NaN;
    const lat = Array.isArray(c) ? Number(c[1]) : NaN;
    const mag = Number(p.mag);
    const t = p.time != null ? new Date(p.time).toISOString() : "";
    return {
      id: String(p.id || ""),
      mag: Number.isFinite(mag) ? mag : 0,
      lat,
      lon,
      depth: p.depth != null ? Number(p.depth) : null,
      place: localizeQuakePlace(String(p.place || "—")),
      date: t,
    };
  });
}

function parseFxNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/\s/g, "");
  if (!s) return NaN;
  s = s.replace(/%/g, "").replace(/−/g, "-").replace(/–/g, "-");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function fxCurrencyBlock(root, names) {
  if (!root || typeof root !== "object") return null;
  for (const name of names) {
    if (root[name] != null && typeof root[name] === "object") return root[name];
  }
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  for (const k of Object.keys(root)) {
    if (want.has(String(k).toLowerCase())) {
      const v = root[k];
      if (v != null && typeof v === "object") return v;
    }
  }
  return null;
}

function fxSellingFromBlock(block) {
  if (!block) return NaN;
  for (const k of ["Selling", "selling", "Satış", "Satis", "BanknoteSelling", "ForexSelling"]) {
    const n = parseFxNumber(block[k]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function fxChangeFromBlock(block) {
  if (!block) return NaN;
  for (const k of [
    "Change",
    "change",
    "Percent",
    "percent",
    "percentChange",
    "Degisim",
    "degisim",
    "Yuzde",
    "yuzde",
  ]) {
    const n = parseFxNumber(block[k]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/** Truncgil v3/v4 (ve benzeri) gövdesinden USD/EUR/GRA çıkarır. */
function extractFxFromTruncgilJson(j) {
  const root = j && typeof j === "object" ? j : {};
  const data =
    root.data && typeof root.data === "object"
      ? root.data
      : root.result && typeof root.result === "object"
        ? root.result
        : root;
  const usdB = fxCurrencyBlock(data, ["USD", "DOLAR", "Dolar", "usd"]);
  const eurB = fxCurrencyBlock(data, ["EUR", "EURO", "Euro", "eur"]);
  const goldB = fxCurrencyBlock(data, ["GRA", "GAU", "GRAM_ALTIN", "GRAMALTIN", "Altın", "Gram_Altın", "gram-altin"]);
  const usdSell = fxSellingFromBlock(usdB);
  const eurSell = fxSellingFromBlock(eurB);
  const goldSell = fxSellingFromBlock(goldB);
  const usdCh = fxChangeFromBlock(usdB);
  const eurCh = fxChangeFromBlock(eurB);
  const goldCh = fxChangeFromBlock(goldB);
  const updateDate =
    root.Update_Date != null
      ? String(root.Update_Date).trim()
      : root.update_date != null
        ? String(root.update_date).trim()
        : root["Güncelleme Tarihi"] != null
          ? String(root["Güncelleme Tarihi"]).trim()
          : "";
  return {
    usd: usdSell,
    eur: eurSell,
    gold: Number.isFinite(goldSell) ? goldSell : null,
    usdChange: Number.isFinite(usdCh) ? usdCh : null,
    eurChange: Number.isFinite(eurCh) ? eurCh : null,
    goldChange: Number.isFinite(goldCh) ? goldCh : null,
    date: updateDate,
  };
}

function tcmbForexSelling(xml, kod) {
  const re = new RegExp(`<Currency[^>]*Kod="${kod}"[^>]*>[\\s\\S]*?</Currency>`, "i");
  const m = xml.match(re);
  if (!m) return NaN;
  const block = m[0];
  let sub = block.match(/<ForexSelling>([^<]*)<\/ForexSelling>/i);
  if (!sub || !String(sub[1]).trim()) sub = block.match(/<BanknoteSelling>([^<]*)<\/BanknoteSelling>/i);
  if (!sub) return NaN;
  return parseFxNumber(sub[1]);
}

/** TCMB Tarih_Date: DD.MM.YYYY (ör. 18.04.2026). */
function parseTcmbDisplayDate(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

/** TCMB Tarih_Date Date="MM/DD/YYYY" (ABD sırası). */
function parseTcmbUsSlashDate(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

function tcmbRefDateFromTodayXml(xml) {
  const tTr = xml.match(/<Tarih_Date[^>]*\bTarih="([^"]+)"/i);
  if (tTr) {
    const dt = parseTcmbDisplayDate(String(tTr[1]).trim());
    if (dt) return dt;
  }
  const tUs = xml.match(/<Tarih_Date[^>]*\bDate="([^"]+)"/i);
  if (tUs) {
    const dt = parseTcmbUsSlashDate(String(tUs[1]).trim());
    if (dt) return dt;
  }
  const t1 = xml.match(/<Tarih_Date[^>]*>([^<]+)<\/Tarih_Date>/i);
  if (t1) {
    const dt = parseTcmbDisplayDate(String(t1[1]).trim());
    if (dt) return dt;
  }
  return null;
}

function tcmbHumanDateFromTodayXml(xml) {
  const tTr = xml.match(/<Tarih_Date[^>]*\bTarih="([^"]+)"/i);
  if (tTr) return String(tTr[1]).trim();
  const tUs = xml.match(/<Tarih_Date[^>]*\bDate="([^"]+)"/i);
  if (tUs) return String(tUs[1]).trim();
  const t1 = xml.match(/<Tarih_Date[^>]*>([^<]+)<\/Tarih_Date>/i);
  return t1 ? String(t1[1]).trim() : "";
}

/** TCMB arşiv: https://www.tcmb.gov.tr/kurlar/yyyyMM/ddMMyyyy.xml */
function tcmbArchiveUrlForDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const folder = `${y}${m}`;
  const file = `${day}${m}${y}.xml`;
  return `https://www.tcmb.gov.tr/kurlar/${folder}/${file}`;
}

function fxPctSincePrev(prev, curr) {
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) return null;
  const p = ((curr - prev) / prev) * 100;
  return Number.isFinite(p) ? p : null;
}

async function fetchTcmbUsdEurArchiveAtDate(d) {
  const url = tcmbArchiveUrlForDate(d);
  const raw = await fetchUrlText(url, {
    headers: {
      Accept: "application/xml,text/xml,*/*",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 20000,
    maxRedirects: 5,
  });
  const usd = tcmbForexSelling(raw, "USD");
  const eur = tcmbForexSelling(raw, "EUR");
  if (!Number.isFinite(usd) || !Number.isFinite(eur)) return null;
  return { usd, eur };
}

/** TCMB today.xml’deki kur tarihine göre önceki yayınlanmış günün USD/EUR satışını bulur. */
async function fetchTcmbPriorUsdEur(refDate) {
  const base =
    refDate instanceof Date && !Number.isNaN(refDate.getTime())
      ? new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate())
      : new Date();
  for (let back = 1; back <= 7; back++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setDate(d.getDate() - back);
    try {
      const rates = await fetchTcmbUsdEurArchiveAtDate(d);
      if (rates) return rates;
    } catch (_e) {
      /* hafta sonu / tatil: bir önceki dosyayı dene */
    }
  }
  return null;
}

/** TCMB günlük kurlar — Truncgil kapalı/bozuk olduğunda USD/EUR satış (ForexSelling) yedeği. */
async function fetchTcmbTodayFx() {
  const url = "https://www.tcmb.gov.tr/kurlar/today.xml";
  const raw = await fetchUrlText(url, {
    headers: {
      Accept: "application/xml,text/xml,*/*",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 20000,
    maxRedirects: 5,
  });
  const usd = tcmbForexSelling(raw, "USD");
  const eur = tcmbForexSelling(raw, "EUR");
  if (!Number.isFinite(usd) || !Number.isFinite(eur)) {
    throw new Error("TCMB XML içinde USD/EUR satış bulunamadı.");
  }
  const dateStr = tcmbHumanDateFromTodayXml(raw);
  const refDate = tcmbRefDateFromTodayXml(raw);
  let usdChange = null;
  let eurChange = null;
  try {
    const prev = await fetchTcmbPriorUsdEur(refDate || new Date());
    if (prev) {
      usdChange = fxPctSincePrev(prev.usd, usd);
      eurChange = fxPctSincePrev(prev.eur, eur);
    }
  } catch (_e) {
    /* değişim yok */
  }
  return {
    usd,
    eur,
    gold: null,
    usdChange,
    eurChange,
    goldChange: null,
    date: dateStr,
  };
}

/** USD/EUR (satış) + gram altın: önce Truncgil v4/v3, olmazsa TCMB. */
async function fetchPublicFxTruncgil() {
  const urls = [
    "https://finans.truncgil.com/v4/today.json",
    "https://finans.truncgil.com/v3/today.json",
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const raw = await fetchUrlText(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": USER_AGENT,
        },
        timeoutMs: 20000,
        maxRedirects: 5,
      });
      const head = raw.trimStart();
      if (!head || head.startsWith("<")) {
        throw new Error("Kur servisi JSON yerine HTML döndü.");
      }
      let j;
      try {
        j = JSON.parse(raw);
      } catch (_e) {
        throw new Error("Kur servisi geçerli JSON değil.");
      }
      const fx = extractFxFromTruncgilJson(j);
      if (fx && Number.isFinite(fx.usd) && Number.isFinite(fx.eur)) {
        return fx;
      }
      lastErr = new Error("USD/EUR satış verisi eksik.");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      lastErr = new Error(msg.includes("HTTP ") ? `Kur servisi yanıtı ${msg.replace(/^HTTP /, "")}` : msg);
    }
  }
  try {
    return await fetchTcmbTodayFx();
  } catch (e2) {
    const tcmbMsg = e2 && e2.message ? String(e2.message) : String(e2);
    if (lastErr) {
      throw new Error(`${lastErr.message} TCMB yedeği: ${tcmbMsg}`);
    }
    throw new Error(`USD/EUR satış verisi eksik. TCMB: ${tcmbMsg}`);
  }
}

async function fetchPulseEarthquakes() {
  const errors = [];
  const allRaw = [];
  const tasks = [fetchAfadMergedJsonRawRows()];
  if (PULSE_USE_KOERI) tasks.push(fetchKoeriLst1RawRows());
  const settled = await Promise.allSettled(tasks);
  const afadS = settled[0];
  if (afadS.status === "fulfilled") {
    allRaw.push(...afadS.value);
  } else {
    const msg = afadS.reason && afadS.reason.message ? String(afadS.reason.message) : String(afadS.reason);
    errors.push({ source: "afad", error: msg });
  }
  if (PULSE_USE_KOERI && settled[1]) {
    const kS = settled[1];
    if (kS.status === "fulfilled") {
      allRaw.push(...kS.value);
    } else {
      const msg = kS.reason && kS.reason.message ? String(kS.reason.message) : String(kS.reason);
      errors.push({ source: "koeri", error: msg });
    }
  }
  if (allRaw.length) {
    return { earthquakes: poolFromAfadRawRows(allRaw), errors };
  }
  let earthquakes = [];
  try {
    earthquakes = await fetchUsgsAnatoliaFallback();
    errors.push({
      source: "usgs-fallback",
      error:
        "AFAD/KOERI verisi alınamadı. Türkiye yakını için USGS yedeği gösteriliyor.",
    });
  } catch (_e2) {
    /* yoksay */
  }
  return { earthquakes, errors };
}

async function fetchPulseFxPart() {
  const errors = [];
  let fx = null;
  let fxNote = null;
  try {
    fx = await fetchPublicFxTruncgil();
    if (fxPayloadUsable(fx)) {
      fxLastGood = { at: Date.now(), fx };
    }
  } catch (e) {
    if (fxPayloadUsable(fxLastGood.fx)) {
      fx = fxLastGood.fx;
      fxNote = null;
      console.warn("[fx] truncgil:", e.message || String(e), "→ önbellekteki kur gösteriliyor.");
    } else {
      errors.push({ source: "fx", error: e.message || String(e) });
    }
  }
  return { fx, fxNote, errors };
}

/** Görsel vekil: IP başına pencere içi istek üst sınırı (DoS mitigation). */
const IMAGE_PROXY_RATE_WINDOW_MS = 60 * 1000;
const IMAGE_PROXY_RATE_MAX = Math.max(30, Number(process.env.IMAGE_PROXY_RATE_MAX) || 200);
const imageProxyHits = new Map();

function clientIpFromRequest(req) {
  const xff = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  if (xff) return xff.slice(0, 120);
  const raw = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "";
  return raw.replace(/^::ffff:/, "") || "unknown";
}

function pruneImageProxyBuckets(now) {
  if (imageProxyHits.size < 8000) return;
  for (const k of imageProxyHits.keys()) {
    const arr = imageProxyHits.get(k);
    const fresh = (arr || []).filter((t) => now - t < IMAGE_PROXY_RATE_WINDOW_MS);
    if (!fresh.length) imageProxyHits.delete(k);
    else imageProxyHits.set(k, fresh);
  }
}

function allowImageProxyRequest(req) {
  const now = Date.now();
  pruneImageProxyBuckets(now);
  const key = clientIpFromRequest(req);
  const arr = imageProxyHits.get(key) || [];
  const fresh = arr.filter((t) => now - t < IMAGE_PROXY_RATE_WINDOW_MS);
  fresh.push(now);
  imageProxyHits.set(key, fresh);
  return fresh.length <= IMAGE_PROXY_RATE_MAX;
}

/** @type {Map<string, { at: number, payload: object }>} */
const weatherCache = new Map();
const FALLBACK_WEATHER_LOC = {
  lat: 41.0082,
  lon: 28.9784,
  city: "İstanbul",
  region: "",
  country: "Türkiye",
  countryCode: "TR",
  approximate: true,
};

function isPrivateOrReservedIp(ip) {
  const s = String(ip || "").trim();
  if (!s || s === "unknown") return true;
  if (s === "::1" || s.startsWith("127.")) return true;
  if (s.startsWith("10.")) return true;
  if (s.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^[Ff][CcDd][0-9a-fA-F:]+$/.test(s)) return true;
  return false;
}

function pruneWeatherCache(now) {
  if (weatherCache.size < 4000) return;
  for (const [k, v] of weatherCache) {
    if (now - v.at > WEATHER_CACHE_MS * 3) weatherCache.delete(k);
  }
  if (weatherCache.size > 5000) weatherCache.clear();
}

/** Open-Meteo WMO weathercode → kısa Türkçe özet */
function wmoWeatherCodeTr(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return "—";
  if (c === 0) return "Açık";
  if (c >= 1 && c <= 3) return c === 3 ? "Kapalı" : "Parçalı bulutlu";
  if (c === 45 || c === 48) return "Sis";
  if (c >= 51 && c <= 57) return "Çisenti";
  if (c >= 61 && c <= 67) return "Yağmurlu";
  if (c >= 71 && c <= 77) return "Karlı";
  if (c >= 80 && c <= 82) return "Sağanak";
  if (c >= 95 && c <= 99) return "Gök gürültülü";
  return "Değişken";
}

async function fetchOpenMeteoCurrent(lat, lon) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(lat) +
    "&longitude=" +
    encodeURIComponent(lon) +
    "&current_weather=true&timezone=auto";
  const raw = await fetchUrlText(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    timeoutMs: 15000,
    maxRedirects: 3,
  });
  let j;
  try {
    j = JSON.parse(raw);
  } catch (_e) {
    throw new Error("Hava API geçersiz JSON.");
  }
  const cw = j.current_weather;
  if (!cw || !Number.isFinite(Number(cw.temperature))) {
    throw new Error("Hava verisi eksik.");
  }
  return {
    tempC: Number(cw.temperature),
    windKmh: Number.isFinite(Number(cw.windspeed)) ? Number(cw.windspeed) : null,
    code: Number(cw.weathercode),
    isDay: cw.is_day === 1,
    time: cw.time != null ? String(cw.time).trim() : "",
  };
}

async function fetchIpWhoLocation(ip) {
  const safe = String(ip || "").trim();
  const url =
    safe && !isPrivateOrReservedIp(safe)
      ? `https://ipwho.is/${encodeURIComponent(safe)}`
      : "https://ipwho.is/";
  const raw = await fetchUrlText(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    timeoutMs: 15000,
    maxRedirects: 3,
  });
  let j;
  try {
    j = JSON.parse(raw);
  } catch (_e) {
    throw new Error("Konum API geçersiz JSON.");
  }
  if (!j.success) {
    throw new Error(String(j.message || "Konum çözülemedi."));
  }
  const lat = Number(j.latitude);
  const lon = Number(j.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Koordinat yok.");
  }
  return {
    city: String(j.city || "").trim(),
    region: String(j.region || "").trim(),
    country: String(j.country || "").trim(),
    countryCode: String(j.country_code || "").trim(),
    lat,
    lon,
    approximate: false,
  };
}

async function buildWeatherPayloadForIp(req) {
  const ip = clientIpFromRequest(req);
  const now = Date.now();
  pruneWeatherCache(now);
  const hit = weatherCache.get(ip);
  if (hit && now - hit.at < WEATHER_CACHE_MS) {
    return { ...hit.payload, cached: true };
  }

  let loc;
  if (isPrivateOrReservedIp(ip)) {
    loc = { ...FALLBACK_WEATHER_LOC };
  } else {
    try {
      loc = await fetchIpWhoLocation(ip);
    } catch (_e) {
      loc = { ...FALLBACK_WEATHER_LOC };
    }
  }

  const current = await fetchOpenMeteoCurrent(loc.lat, loc.lon);
  const summaryTr = wmoWeatherCodeTr(current.code);
  const payload = {
    v: 1,
    ok: true,
    location: {
      city: loc.city,
      region: loc.region,
      country: loc.country,
      countryCode: loc.countryCode,
      lat: loc.lat,
      lon: loc.lon,
      approximate: !!loc.approximate,
    },
    current: {
      tempC: current.tempC,
      windKmh: current.windKmh,
      weatherCode: current.code,
      summaryTr,
      isDay: current.isDay,
      time: current.time,
    },
    sources: ["Open-Meteo", "ipwho.is"],
    fetchedAt: new Date().toISOString(),
  };
  weatherCache.set(ip, { at: now, payload });
  return { ...payload, cached: false };
}

const FUEL_API = "https://www.hasanadiguzel.com.tr/api/akaryakit/sehir=";
const FUEL_KEY_BENZIN = "Kursunsuz_95(Excellium95)_TL/lt";
const FUEL_KEY_MOTORIN = "Motorin(Eurodiesel)_TL/lt";

/** @type {{ at: number, list: string[] } | null} */
let fuelSehirListCache = null;
/** @type {Map<string, { at: number, payload: object }>} */
const fuelPayloadByCity = new Map();

function turkishAsciiUpper(input) {
  return String(input || "")
    .trim()
    .replace(/ğ/g, "g")
    .replace(/Ğ/g, "G")
    .replace(/ü/g, "u")
    .replace(/Ü/g, "U")
    .replace(/ş/g, "s")
    .replace(/Ş/g, "S")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .replace(/i̇/g, "i")
    .replace(/ö/g, "o")
    .replace(/Ö/g, "O")
    .replace(/ç/g, "c")
    .replace(/Ç/g, "C")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function fuelCityDisplayTr(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  const low = `${t.slice(0, 1)}${t.slice(1).toLocaleLowerCase("tr-TR")}`;
  return low;
}

function parseFuelLira(raw) {
  const n = parseFxNumber(raw);
  return Number.isFinite(n) ? n : NaN;
}

function matchFuelCityToken(hint, sehirler) {
  const set = new Set(sehirler);
  const n = turkishAsciiUpper(hint);
  if (n && set.has(n)) return n;
  if (!n) return null;
  for (const s of sehirler) {
    if (n.length >= 4 && s.includes(n)) return s;
  }
  return null;
}

async function getFuelSehirList() {
  const now = Date.now();
  if (
    fuelSehirListCache &&
    fuelSehirListCache.list &&
    fuelSehirListCache.list.length &&
    now - fuelSehirListCache.at < FUEL_SEHIR_LIST_CACHE_MS
  ) {
    return fuelSehirListCache.list;
  }
  const { statusCode, text } = await fetchUrlAnyStatus(
    `${FUEL_API}__invalid__`,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      timeoutMs: 20000,
      maxRedirects: 3,
    },
    3
  );
  let j;
  try {
    j = JSON.parse(text);
  } catch (_e) {
    j = null;
  }
  const list =
    j && Array.isArray(j.sehirler) && j.sehirler.length
      ? j.sehirler.map((s) => String(s).trim()).filter(Boolean)
      : fuelSehirListCache && fuelSehirListCache.list
        ? fuelSehirListCache.list
        : [];
  if (list.length) {
    fuelSehirListCache = { at: now, list };
  }
  return list;
}

async function defaultFuelCityTokenForRequest(req, sehirler) {
  if (!sehirler.length) return "ISTANBUL";
  const ip = clientIpFromRequest(req);
  if (isPrivateOrReservedIp(ip)) return sehirler.includes("ISTANBUL") ? "ISTANBUL" : sehirler[0];
  try {
    const loc = await fetchIpWhoLocation(ip);
    const hints = [loc.region, loc.city].filter(Boolean);
    for (const h of hints) {
      const m = matchFuelCityToken(h, sehirler);
      if (m) return m;
    }
  } catch (_e) {
    /* yedek şehir */
  }
  return sehirler.includes("ISTANBUL") ? "ISTANBUL" : sehirler[0];
}

function analyzeFuelDataBlocks(dataObj) {
  const motorinRows = [];
  for (const [districtKey, prices] of Object.entries(dataObj || {})) {
    if (!prices || typeof prices !== "object") continue;
    const motorin = parseFuelLira(prices[FUEL_KEY_MOTORIN]);
    const benzin = parseFuelLira(prices[FUEL_KEY_BENZIN]);
    if (Number.isFinite(motorin)) {
      motorinRows.push({
        districtKey: String(districtKey),
        motorin,
        benzin: Number.isFinite(benzin) ? benzin : null,
      });
    }
  }
  motorinRows.sort((a, b) => a.motorin - b.motorin || (a.districtKey > b.districtKey ? 1 : -1));
  const benzinRows = motorinRows
    .filter((r) => Number.isFinite(r.benzin))
    .sort((a, b) => (a.benzin || 0) - (b.benzin || 0) || (a.districtKey > b.districtKey ? 1 : -1));
  const minMotorin = motorinRows.length ? motorinRows[0].motorin : null;
  const minBenzin = benzinRows.length ? benzinRows[0].benzin : null;
  return {
    districtCount: motorinRows.length,
    minMotorin,
    minBenzin,
    topMotorin: motorinRows.slice(0, 6),
    topBenzin: benzinRows.slice(0, 6),
  };
}

async function fetchFuelRawForCity(cityToken) {
  const { statusCode, text } = await fetchUrlAnyStatus(
    `${FUEL_API}${encodeURIComponent(cityToken)}`,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      timeoutMs: 25000,
      maxRedirects: 3,
    },
    3
  );
  let j;
  try {
    j = JSON.parse(text);
  } catch (_e) {
    throw new Error("Akaryakıt API yanıtı çözülemedi.");
  }
  if (statusCode !== 200 || (j && j.error)) {
    const msg = j && j.error && j.error.text ? String(j.error.text) : `HTTP ${statusCode}`;
    throw new Error(msg);
  }
  if (!j.data || typeof j.data !== "object") {
    throw new Error("Akaryakıt veri alanı yok.");
  }
  return j;
}

async function buildFuelPricesPayload(req) {
  const sehirler = await getFuelSehirList();
  if (!sehirler.length) {
    throw new Error("İl listesi alınamadı.");
  }
  let cityToken = turkishAsciiUpper(String(req.query.city || "").trim());
  if (!cityToken || !sehirler.includes(cityToken)) {
    cityToken = await defaultFuelCityTokenForRequest(req, sehirler);
  }
  const now = Date.now();
  const hit = fuelPayloadByCity.get(cityToken);
  if (hit && now - hit.at < FUEL_CACHE_MS) {
    return {
      ...hit.payload,
      cities: sehirler,
      cached: true,
    };
  }
  const raw = await fetchFuelRawForCity(cityToken);
  const qual = raw.qualifications || {};
  const analysis = analyzeFuelDataBlocks(raw.data);
  const payload = {
    v: 1,
    ok: true,
    cityToken,
    cityLabel: fuelCityDisplayTr(qual.city || cityToken),
    summary: {
      minMotorinL: analysis.minMotorin,
      minBenzinL: analysis.minBenzin,
      districtGroups: analysis.districtCount,
    },
    tables: {
      motorin: analysis.topMotorin,
      benzin: analysis.topBenzin,
    },
    note:
      "Fiyatlar EPDK’ya bildirilen ilçe/alt bölüm gruplarına göredir; istasyon bazında farklılık gösterebilir. Kodlar resmi gruplamayı ifade eder.",
    source: "hasanadiguzel.com.tr (EPDK bildirimleri)",
    sourceUrl: "https://www.hasanadiguzel.com.tr/",
    fetchedAt: new Date().toISOString(),
  };
  fuelPayloadByCity.set(cityToken, { at: now, payload });
  return { ...payload, cities: sehirler, cached: false };
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  );
  const xfProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (xfProto === "https" || req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://pagead2.googlesyndication.com https://www.googletagservices.com https://www.googletagmanager.com https://images.dmca.com https://news.google.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self' https: http: ws: wss:",
    "frame-src 'self' https://www.googletagmanager.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://pagead2.googlesyndication.com https://www.google.com https://fundingchoicesmessages.google.com https://news.google.com https://pay.google.com",
    "worker-src 'self' blob: https://www.google.com https://pagead2.googlesyndication.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
  next();
}

const app = express();
app.disable("x-powered-by");
const trustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
if (trustProxy === "1" || trustProxy === "true") app.set("trust proxy", 1);
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || "").trim();
if (CORS_ORIGIN) {
  app.use(
    cors({
      origin: CORS_ORIGIN,
      methods: ["GET", "HEAD", "OPTIONS"],
      maxAge: 86400,
    })
  );
} else {
  app.use(cors({ origin: true, maxAge: 86400 }));
}
app.use(securityHeaders);

app.get("/api/image", async (req, res) => {
  if (!allowImageProxyRequest(req)) {
    res.status(429).set("Retry-After", "60").end();
    return;
  }
  const target = String(req.query.u || "").trim();
  const refParam = String(req.query.r || req.query.ref || "").trim();
  if (!target || target.length > 4000) {
    res.status(400).end();
    return;
  }
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      res.status(400).end();
      return;
    }
    if (!isSafeImageProxyHost(parsed.hostname)) {
      res.status(403).end();
      return;
    }
    const refererPrimary = safeRefererForImageFetch(refParam, parsed);
    const refererFallback = `${parsed.protocol}//${parsed.host}/`;

    async function tryFetch(referer) {
      return httpGetBufferFollow(
        parsed.href,
        {
          headers: {
            "User-Agent": IMAGE_FETCH_UA,
            Accept: "image/*,image/avif,image/webp,*/*;q=0.8",
            Referer: referer,
          },
          timeoutMs: 20000,
          maxBodyBytes: IMAGE_PROXY_MAX_BYTES,
        },
        6
      );
    }

    let r = await tryFetch(refererPrimary);
    if ((r.statusCode < 200 || r.statusCode >= 300) && refererPrimary !== refererFallback) {
      r = await tryFetch(refererFallback);
    }
    if (r.statusCode < 200 || r.statusCode >= 300) {
      res.status(404).end();
      return;
    }
    const rawCt = String(r.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const okType =
      rawCt.startsWith("image/") ||
      rawCt === "application/octet-stream" ||
      rawCt === "binary/octet-stream";
    if (!okType) {
      res.status(415).end();
      return;
    }
    if (rawCt === "image/svg+xml") {
      res.status(415).end();
      return;
    }
    const buf = r.body;
    if (buf.length > IMAGE_PROXY_MAX_BYTES) {
      res.status(413).end();
      return;
    }
    const sendCt =
      rawCt.startsWith("image/") && rawCt !== "image/svg+xml" ? rawCt : "image/jpeg";
    res.setHeader("Content-Type", sendCt);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (_e) {
    res.status(502).end();
  }
});

app.get("/haber", (_req, res) => {
  res.redirect(302, "/");
});

app.get("/haber/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (haberById.size === 0 && feedsConfig.length) {
      try {
        await refreshNewsCache();
      } catch (_e) {
        /* yoksay */
      }
    }
    let item = haberById.get(id);
    if (!item) {
      try {
        item = await newsDb.getArticleById(id);
      } catch (_e) {
        item = null;
      }
    }
    if (!item) {
      res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="tr"><head>${GTM_HEAD_SNIPPET}<meta charset="UTF-8"/>${ADSENSE_HEAD_SNIPPET}${ADSENSE_ACCOUNT_META}<meta name="robots" content="noindex, nofollow"/><title>Haber bulunamadı</title></head>
<body style="font-family:system-ui;background:#0c0f14;color:#e8ecf4;padding:2rem;text-align:center">
${GTM_BODY_NOSCRIPT}
<p>Haber bulunamadı veya listenin yenilenmesiyle kaldırılmış olabilir.</p>
<p><a style="color:#d4a853" href="/">Ana sayfa</a></p>
</body></html>`);
      return;
    }
    res.type("html").send(renderHaberPage(item, req));
  } catch (e) {
    next(e);
  }
});

app.get("/api/news", async (_req, res) => {
  try {
    const now = Date.now();
    const stale =
      !cache.payload ||
      cache.payload.v !== CACHE_VERSION ||
      !Array.isArray(cache.payload.items) ||
      (cache.payload.items.length > 0 && !cache.payload.items[0].id);
    if (!stale && now - cache.at < CACHE_MS) {
      return res.json({ ...cache.payload, cached: true });
    }
    if (!feedsConfig.length) {
      return res.status(500).json({
        v: CACHE_VERSION,
        items: [],
        errors: [{ error: "Haber akışı yapılandırması eksik." }],
        fetchedAt: new Date().toISOString(),
      });
    }
    if (
      RSS_STALE_SERVE &&
      newsPayloadLooksUsable(cache.payload) &&
      now - cache.at >= CACHE_MS
    ) {
      void refreshNewsCache().catch(() => {});
      return res.json({ ...cache.payload, cached: true, revalidating: true });
    }
    const payload = await refreshNewsCache();
    res.json({ ...payload, cached: false });
  } catch (e) {
    res.status(500).json({
      v: CACHE_VERSION,
      items: [],
      errors: [{ error: e.message || String(e) }],
      fetchedAt: new Date().toISOString(),
    });
  }
});

/** SQLite arşivi: zaman içinde biriken tüm haberler (sayfalı). RSS önbelleğinden bağımsız. */
const ARCHIVE_API_VERSION = 1;
const ARCHIVE_MAX_LIMIT = 60;
app.get("/api/news/archive", async (req, res) => {
  try {
    if (newsDb.isDbDisabled()) {
      return res.json({
        v: ARCHIVE_API_VERSION,
        items: [],
        total: 0,
        page: 1,
        pageSize: 24,
        totalPages: 0,
        dbDisabled: true,
        errors: [{ error: "Haber arşivi veritabanı kapalı (NEWS_DISABLE_DB)." }],
        fetchedAt: new Date().toISOString(),
      });
    }
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const rawLimit = parseInt(String(req.query.limit || "24"), 10);
    const pageSize = Math.min(
      ARCHIVE_MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 24)
    );
    let category = String(req.query.category || "")
      .toLowerCase()
      .trim();
    if (category && !FEED_CATEGORY_SLUGS.has(category)) {
      category = "";
    }
    const result = await newsDb.listArticles({
      page,
      pageSize,
      category: category || null,
      requireNonEmptyImage: true,
    });
    res.json({
      v: ARCHIVE_API_VERSION,
      ...result,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({
      v: ARCHIVE_API_VERSION,
      items: [],
      total: 0,
      page: 1,
      pageSize: 24,
      totalPages: 0,
      errors: [{ error: e.message || String(e) }],
      fetchedAt: new Date().toISOString(),
    });
  }
});

app.get("/api/tr-pulse", async (_req, res) => {
  try {
    const now = Date.now();
    res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");

    const quakesFresh =
      quakePulseCache.at && now - quakePulseCache.at < PULSE_QUAKES_CACHE_MS;
    const fxFresh = fxPulseCache.at && now - fxPulseCache.at < PULSE_FX_CACHE_MS;

    if (quakesFresh && fxFresh && pulseCache.payload && pulseCache.payload.v === 1) {
      return res.json({ ...pulseCache.payload, cached: true });
    }

    let earthquakes = quakePulseCache.earthquakes;
    let qErrors = quakePulseCache.errors || [];
    let quakeFetchedAt = pulseCache.payload?.quakeFetchedAt || null;
    if (!quakesFresh) {
      const q = await fetchPulseEarthquakes();
      earthquakes = q.earthquakes;
      qErrors = q.errors;
      quakePulseCache = { at: now, earthquakes, errors: qErrors };
      quakeFetchedAt = new Date().toISOString();
    }

    let fx = fxPulseCache.fx;
    let fxNote = fxPulseCache.fxNote;
    let fErrors = fxPulseCache.errors || [];
    if (!fxFresh) {
      const f = await fetchPulseFxPart();
      fx = f.fx;
      fxNote = f.fxNote;
      fErrors = f.errors;
      fxPulseCache = { at: now, fx, fxNote, errors: fErrors };
    }

    const payload = {
      v: 1,
      earthquakes,
      fx,
      fxNote,
      errors: [...qErrors, ...fErrors],
      fetchedAt: new Date().toISOString(),
      quakeFetchedAt,
    };
    pulseCache = { at: now, payload };
    res.json({ ...payload, cached: false });
  } catch (e) {
    res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
    res.status(500).json({
      v: 1,
      earthquakes: [],
      fx: null,
      fxNote: null,
      errors: [{ source: "pulse", error: e.message || String(e) }],
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  }
});

/**
 * Ziyaretçi IP’sine göre yaklaşık konum (ipwho.is) ve güncel hava (Open-Meteo, API anahtarı yok).
 * Yerel / özel IP’lerde varsayılan: İstanbul koordinatları.
 */
app.get("/api/weather", async (req, res) => {
  try {
    const payload = await buildWeatherPayloadForIp(req);
    res.setHeader("Cache-Control", "private, max-age=120");
    res.json(payload);
  } catch (e) {
    res.status(200).json({
      v: 1,
      ok: false,
      error: e.message || String(e),
      location: null,
      current: null,
      fetchedAt: new Date().toISOString(),
    });
  }
});

/**
 * İl seçimine göre EPDK bildirimlerinden (ilçe/alt bölüm grupları) en düşük motorin & benzin özeti.
 * Şehir verilmezse ziyaretçi IP’si (ipwho.is) ile tahmin; veri: hasanadiguzel.com.tr API.
 */
app.get("/api/fuel-prices", async (req, res) => {
  try {
    const payload = await buildFuelPricesPayload(req);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(payload);
  } catch (e) {
    res.status(200).json({
      v: 1,
      ok: false,
      error: e.message || String(e),
      cities: fuelSehirListCache && fuelSehirListCache.list ? fuelSehirListCache.list : [],
      fetchedAt: new Date().toISOString(),
    });
  }
});

app.get("/robots.txt", (req, res) => {
  const origin = getPublicSiteOrigin(req);
  res.type("text/plain; charset=utf-8");
  if (!origin) {
    res.send("User-agent: *\nAllow: /\n");
    return;
  }
  res.send(
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\nSitemap: ${origin}/news-sitemap.xml\n`
  );
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const origin = getPublicSiteOrigin(req);
    if (!origin) {
      res.status(503).type("text/plain; charset=utf-8").send(
        "sitemap.xml: Kanonik site adresi yok. Üretimde PUBLIC_SITE_ORIGIN veya SITE_URL ortam değişkenini ayarlayın " +
          "(örn. https://www.gundemturkiye365.com)."
      );
      return;
    }
    const payload = await loadNewsPayloadForSitemap();
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const xml = buildGeneralSitemapXml(origin, items);
    res
      .status(200)
      .type("application/xml; charset=utf-8")
      .set("Cache-Control", "public, max-age=300")
      .send(xml);
  } catch (e) {
    res.status(500).type("text/plain; charset=utf-8").send(e.message || "Sitemap error");
  }
});

app.get("/news-sitemap.xml", async (req, res) => {
  try {
    const origin = getPublicSiteOrigin(req);
    if (!origin) {
      res.status(503).type("text/plain; charset=utf-8").send(
        "news-sitemap.xml: Kanonik site adresi yok. Üretimde PUBLIC_SITE_ORIGIN veya SITE_URL ortam değişkenini ayarlayın " +
          "(örn. https://www.gundemturkiye365.com). Yerelde robots.txt site haritası satırı eklenmez."
      );
      return;
    }
    const payload = await loadNewsPayloadForSitemap();
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const xml = buildNewsSitemapXml(origin, items);
    res
      .status(200)
      .type("application/xml; charset=utf-8")
      .set("Cache-Control", "public, max-age=300")
      .send(xml);
  } catch (e) {
    res.status(500).type("text/plain; charset=utf-8").send(e.message || "Sitemap error");
  }
});

async function sendSiteRssFeed(req, res) {
  try {
    const origin = getPublicSiteOrigin(req);
    if (!origin) {
      res.status(503).type("text/plain; charset=utf-8").send(
        "rss.xml: Kanonik site adresi yok. Üretimde PUBLIC_SITE_ORIGIN veya SITE_URL ortam değişkenini ayarlayın " +
          "(örn. https://www.gundemturkiye365.com)."
      );
      return;
    }
    const payload = await loadNewsPayloadForSitemap();
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const xml = buildSiteFeedRssXml(origin, items);
    res
      .status(200)
      .type("application/rss+xml; charset=utf-8")
      .set("Cache-Control", "public, max-age=300")
      .send(xml);
  } catch (e) {
    res.status(500).type("text/plain; charset=utf-8").send(e.message || "RSS error");
  }
}

app.get("/rss.xml", sendSiteRssFeed);
app.get("/feed.xml", sendSiteRssFeed);
/** Kısa yol: /rss ve /feed → gerçek besleme (tarayıcı / Telegram bazı araçlar .xml sız kullanır) */
app.get("/rss", (_req, res) => res.redirect(301, "/rss.xml"));
app.get("/feed", (_req, res) => res.redirect(301, "/feed.xml"));

app.get(["/", "/index.html"], (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .set("Cache-Control", "public, max-age=0, must-revalidate")
    .send(getIndexHtmlWithGoogleNewsPublication());
});

app.use(
  express.static(__dirname, {
    setHeaders(res, filePath) {
      const fn = path.basename(filePath);
      /* Ana arayüz dosyaları: tarayıcı/CDN eski “yükleniyor” metinli app.js tutmasın */
      if (fn === "app.js" || fn === "index.html") {
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`GündemTürkiye365.com — http://localhost:${PORT}`);
  console.log(
    `RSS: ${feedsConfig.length} kaynak, önbellek ${CACHE_MS / 1000}s` +
      (RSS_STALE_SERVE ? ", stale-serve açık" : ", stale-serve kapalı") +
      ` | TR deprem: ${PULSE_QUAKES_CACHE_MS / 1000}s | TR kur: ${PULSE_FX_CACHE_MS / 1000}s`
  );
  if (feedsConfig.length) {
    setImmediate(() => {
      refreshNewsCache().catch((e) =>
        console.warn("İlk RSS önbelleği:", e && e.message ? e.message : String(e))
      );
    });
  }
  if (!PUBLIC_SITE_ORIGIN) {
    console.log(
      "SEO: news-sitemap.xml üretimi için PUBLIC_SITE_ORIGIN (veya SITE_URL) tanımlayın; robots.txt site haritası satırı yalnızca kök adres çözümlenince eklenir."
    );
  }
  scheduleNewsDbRetentionPurge();
});

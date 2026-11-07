/**
 * portfolio-notify: turns portfolio visits into Telegram alerts.
 *
 * The page (script.js) posts small JSON bodies as text/plain, so every request is a CORS
 * "simple request" (no preflight) and navigator.sendBeacon works while the tab is closing.
 * The Worker adds what only the network side knows (IP, city, region, country and ISP from
 * request.cf), names the browser, OS and device, works out where the visitor came from, and
 * sends the result through the Telegram Bot API. The bot token never reaches the browser.
 *
 *   POST /v        new visit      -> sendMessage, returns { ok, v, t }
 *   POST /e        CV download    -> a reply to the visit alert
 *   POST /s        visit summary  -> editMessageText on the visit alert (edits are silent)
 *   POST /contact  contact form   -> sendMessage, as a reply to the visit alert when possible
 *
 * `t` is the alert's HTML and `v` is "<message_id>.<HMAC of message_id|t>", so the Worker stays
 * stateless and a page can only follow up on the alert it was given.
 *
 * Deploy, from this folder:
 *   npx wrangler@4 login
 *   npx wrangler@4 deploy
 *   npx wrangler@4 secret put TELEGRAM_BOT_TOKEN
 *   npx wrangler@4 secret put TELEGRAM_CHAT_ID
 * Live logs: npx wrangler@4 tail
 */

const ROUTES = new Set(["/v", "/e", "/s", "/contact"]);
const MAX_BODY = 8192;
const MAX_TEXT = 4000;
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { v: 6, e: 10, s: 30, contact: 3 };

// Crawlers that run JavaScript, headless browsers and HTTP libraries. There is no bare "bot"
// match, so phones such as CUBOT models are not mistaken for bots.
const BOT_UA = new RegExp(
  [
    "[a-z]bot[/;_+-]", "\\bbot\\b", "crawl", "spider", "slurp", "scrap", "headless", "lighthouse",
    "pagespeed", "gtmetrix", "ptst/", "pingdom", "uptime", "statuscake", "externalhit", "facebot",
    "telegrambot", "twitterbot", "discordbot", "slackbot", "skypeuripreview", "embedly",
    "inspectiontool", "mediapartners", "adsbot", "feedfetcher", "bytespider", "python", "curl/",
    "wget/", "go-http", "axios/", "node-fetch", "undici", "okhttp", "java/", "libwww", "httpclient",
    "phantomjs", "selenium", "puppeteer", "playwright",
  ].join("|"),
  "i"
);

/* ----- Small helpers ----- */

const esc = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const clip = (value, max, keepNewlines = false) => {
  const controls = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g;
  const text = (typeof value === "string" ? value : "").replace(controls, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const show = (value, max = 80) => esc(clip(value, max));

const int = (value, min, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

const duration = (secs) => {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(secs / 3600)}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}m`;
};

const validZone = (zone) => typeof zone === "string" && /^[A-Za-z][A-Za-z0-9_+\-/]{1,40}$/.test(zone);

const zoned = (date, timeZone, options) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(date);
  } catch (error) {
    return "";
  }
};

let regionNames;
const countryName = (code) => {
  if (!code || code === "XX") return "";
  if (code === "T1") return "Tor network";
  try {
    regionNames ||= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) || code;
  } catch (error) {
    return code;
  }
};

const flag = (code) =>
  /^[A-Z]{2}$/.test(code || "") && code !== "XX" && code !== "T1"
    ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)))
    : "";

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
  });

/* ----- Per-IP rate limits ----- */

// Cloudflare's rate-limit bindings (wrangler.jsonc) cap each IP per minute per location. The
// in-memory window below adds a longer, best-effort cap; it is per isolate, so not exact.
const LIMITERS = { v: "LIMIT_VISIT", e: "LIMIT_EVENT", s: "LIMIT_EVENT", contact: "LIMIT_CONTACT" };

const overLimit = async (env, kind, ip) => {
  if (limited(kind, ip)) return true;
  const limiter = env[LIMITERS[kind]];
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key: `${kind}:${ip}` });
    return !success;
  } catch (error) {
    return false;
  }
};

const hits = new Map();

const limited = (kind, ip) => {
  const now = Date.now();
  const key = `${kind}|${ip}`;
  const recent = (hits.get(key) || []).filter((time) => now - time < WINDOW_MS);
  const over = recent.length >= LIMITS[kind];
  if (!over) recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, times] of hits) if (!times.length || now - times[times.length - 1] >= WINDOW_MS) hits.delete(k);
  }
  return over;
};

/* ----- Signed message references ----- */

const encoder = new TextEncoder();
let signingKey = { token: null, key: null };

const hmacKey = async (env) => {
  if (signingKey.token !== env.TELEGRAM_BOT_TOKEN) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(`portfolio-notify:${env.TELEGRAM_BOT_TOKEN}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    signingKey = { token: env.TELEGRAM_BOT_TOKEN, key };
  }
  return signingKey.key;
};

const toBase64Url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const sign = async (env, messageId, text) => {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(`${messageId}|${text}`));
  return `${messageId}.${toBase64Url(signature)}`;
};

// Returns the message id when `v` was issued by this Worker for exactly this text, else null.
const verify = async (env, v, text) => {
  const match = typeof v === "string" && typeof text === "string" && v.match(/^(\d{1,15})\.([\w-]{43})$/);
  if (!match) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    fromBase64Url(match[2]),
    encoder.encode(`${match[1]}|${text}`)
  );
  return valid ? Number(match[1]) : null;
};

/* ----- Browser, OS and device ----- */

const IN_APP = [
  [/FBAN\/Messenger|FB_IAB\/(?:Orca|MESSENGER)|MessengerForiOS|MessengerLite/i, "Messenger"],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/, "Facebook"],
  [/Instagram/i, "Instagram"],
  [/LinkedInApp/i, "LinkedIn"],
  [/Telegram/i, "Telegram"],
  [/musical_ly|BytedanceWebview|TikTok/i, "TikTok"],
  [/Twitter/i, "X (Twitter)"],
  [/Snapchat/i, "Snapchat"],
  [/\bLine\//, "LINE"],
  [/WhatsApp/i, "WhatsApp"],
  [/\bGSA\//, "Google app"],
];

const BROWSERS = [
  [/EdgA?\/([\d.]+)|EdgiOS\/([\d.]+)/, "Edge"],
  [/OPR\/([\d.]+)|OPiOS\/([\d.]+)|OPX\/([\d.]+)/, "Opera"],
  [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"],
  [/YaBrowser\/([\d.]+)|YaSearchBrowser\/([\d.]+)/, "Yandex"],
  [/UCBrowser\/([\d.]+)/, "UC Browser"],
  [/DuckDuckGo\/([\d.]+)/, "DuckDuckGo"],
  [/Firefox\/([\d.]+)|FxiOS\/([\d.]+)/, "Firefox"],
  [/CriOS\/([\d.]+)/, "Chrome"],
  [/Chrome\/([\d.]+)/, "Chrome"],
  [/Version\/([\d.]+).*Safari\//, "Safari"],
];

const shortVersion = (version) => {
  const parts = String(version || "").split(/[._]/).filter(Boolean);
  if (!parts.length) return "";
  return parts[1] && parts[1] !== "0" ? `${parts[0]}.${parts[1]}` : parts[0];
};

const majorVersion = (version) => String(version || "").split(".")[0];

const browserName = (ua, hints, brave) => {
  const brands = Array.isArray(hints.brands)
    ? hints.brands.filter((b) => b && typeof b.brand === "string" && typeof b.version === "string")
    : [];
  const named = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
  const chromium = brands.find((b) => /chromium/i.test(b.brand));
  if (brave) {
    const version = (named && /brave/i.test(named.brand) ? named : chromium)?.version || ua.match(/Chrome\/([\d.]+)/)?.[1];
    return `Brave ${majorVersion(version)}`.trim();
  }
  if (named) {
    const brand = clip(named.brand, 30).replace(/^(Google|Microsoft) /, "").replace(/^YaBrowser$/, "Yandex");
    return `${brand} ${majorVersion(named.version)}`.trim();
  }
  for (const [pattern, name] of BROWSERS) {
    const match = ua.match(pattern);
    if (!match) continue;
    const version = match.slice(1).find(Boolean);
    const webview = name === "Chrome" && /; wv\)/.test(ua) ? " WebView" : "";
    return `${name}${webview} ${name === "Safari" ? shortVersion(version) : majorVersion(version)}`.trim();
  }
  return chromium ? `Chromium ${majorVersion(chromium.version)}` : "";
};

const osName = (ua, hints, ipad) => {
  const pv = typeof hints.platformVersion === "string" ? hints.platformVersion : "";
  const platform = typeof hints.platform === "string" ? hints.platform : "";
  const iosVersion = ua.match(/OS (\d+[_\d]*) like Mac/)?.[1];
  if (/iPhone|iPod/.test(ua)) return `iOS ${shortVersion(iosVersion)}`.trim();
  if (ipad) return `iPadOS ${shortVersion(iosVersion || ua.match(/Version\/([\d.]+)/)?.[1])}`.trim();
  if (/Android/.test(ua) || platform === "Android") {
    // Chrome freezes the UA at "Android 10; K"; only the client hint knows the real version.
    const fromUa = /Android 10; K\)/.test(ua) ? "" : ua.match(/Android ([\d.]+)/)?.[1];
    return `Android ${shortVersion(pv || fromUa)}`.trim();
  }
  if (/Windows NT 10/.test(ua) || platform === "Windows") {
    if (!pv) return "Windows 10/11";
    const major = parseInt(pv, 10);
    return major >= 13 ? "Windows 11" : major >= 1 ? "Windows 10" : "Windows 7/8";
  }
  const nt = ua.match(/Windows NT (\d+\.\d+)/)?.[1];
  if (nt) return { "6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7" }[nt] || `Windows NT ${nt}`;
  if (/CrOS/.test(ua) || platform === "Chrome OS") return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(ua) || platform === "macOS") return `macOS ${shortVersion(pv)}`.trim();
  if (/Linux/.test(ua) || platform === "Linux") return "Linux";
  return clip(platform, 20) || "unknown OS";
};

const deviceInfo = (ua, hints, touch) => {
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  let type = "desktop";
  if (hints.mobile === true || /Mobi|iPhone|iPod/.test(ua)) type = "mobile";
  else if (ipad || /Tablet|Android/.test(ua)) type = "tablet";

  const samsung = (model) => model.replace(/^(?:SAMSUNG )?SM-/i, "Samsung SM-");
  const hinted = clip(hints.model, 40);
  const fromUa = ua.match(/Android [\d.]+;(?: [a-z]{2}[-_][a-z]{2};)? ([^;)]+?)(?: Build\/[^;)]*)?\)/i)?.[1];
  let name;
  if (/iPhone/.test(ua)) name = "iPhone";
  else if (/iPod/.test(ua)) name = "iPod";
  else if (ipad) name = "iPad";
  else if (hinted) name = samsung(hinted);
  else if (fromUa && fromUa !== "K") name = samsung(clip(fromUa, 40));
  else if (/Android/.test(ua)) name = type === "tablet" ? "Android tablet" : "Android phone";
  else if (/Macintosh/.test(ua)) name = "Mac";
  else if (/CrOS/.test(ua)) name = "Chromebook";
  else if (/Windows/.test(ua)) name = "Windows PC";
  else if (/Linux/.test(ua)) name = "Linux PC";
  else name = "unknown device";
  return { name, type, ipad };
};

const describeAgent = (ua, payload) => {
  const hints = payload.ch && typeof payload.ch === "object" ? payload.ch : {};
  const device = deviceInfo(ua, hints, int(payload.touch, 0, 20) || 0);
  const inApp = IN_APP.find(([pattern]) => pattern.test(ua))?.[1] || "";
  const base = browserName(ua, hints, payload.brave === true);
  const browser = inApp ? `${inApp} in-app browser${base ? ` (${base})` : ""}` : base || "unknown browser";
  return { device, inApp, browser, os: osName(ua, hints, device.ipad) };
};

/* ----- Where the visitor came from ----- */

const TAGS = {
  cv: "CV (PDF)", resume: "CV (PDF)", linkedin: "LinkedIn", li: "LinkedIn", github: "GitHub", gh: "GitHub",
  facebook: "Facebook", fb: "Facebook", messenger: "Messenger", instagram: "Instagram", ig: "Instagram",
  whatsapp: "WhatsApp", telegram: "Telegram", email: "Email", x: "X (Twitter)", twitter: "X (Twitter)", qr: "QR code",
};

const REFERRERS = [
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)messenger\.com$/, "Messenger"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/^t\.co$|(^|\.)(twitter\.com|x\.com)$/, "X (Twitter)"],
  [/^mail\.google\.com$/, "Gmail"],
  [/^scholar\.google\./, "Google Scholar"],
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.[a-z.]+$/, "Yahoo"],
  [/(^|\.)yandex\.[a-z.]+$/, "Yandex"],
  [/(^|\.)(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.com)$/, "Outlook"],
  [/(^|\.)teams\.(microsoft|live)\.com$/, "Microsoft Teams"],
  [/(^|\.)slack\.com$/, "Slack"],
  [/(^|\.)discord(app)?\.com$/, "Discord"],
  [/(^|\.)medium\.com$/, "Medium"],
  [/(^|\.)whatsapp\.com$|^wa\.me$/, "WhatsApp"],
  [/(^|\.)telegram\.org$|^t\.me$/, "Telegram"],
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, "ChatGPT"],
  [/(^|\.)claude\.ai$/, "Claude"],
  [/(^|\.)perplexity\.ai$/, "Perplexity"],
];

const APP_REFERRERS = {
  "com.linkedin.android": "LinkedIn app",
  "com.google.android.gm": "Gmail app",
  "com.facebook.katana": "Facebook app",
  "com.facebook.orca": "Messenger app",
  "com.instagram.android": "Instagram app",
  "org.telegram.messenger": "Telegram app",
  "com.whatsapp": "WhatsApp",
  "com.slack": "Slack app",
  "com.microsoft.teams": "Teams app",
  "com.microsoft.office.outlook": "Outlook app",
  "com.google.android.googlequicksearchbox": "Google app",
};

const detectSource = (payload, inApp, ownHosts) => {
  const evidence = [];
  let name = "";
  const pick = (label) => {
    if (!name) name = label;
  };

  const tag = clip(payload.src, 40);
  if (tag) {
    pick(TAGS[tag.toLowerCase()] || tag);
    evidence.push(`tagged ?src=${tag}`);
  }

  const ids = payload.ids && typeof payload.ids === "object" ? payload.ids : {};
  if (ids.fbclid) {
    pick(inApp === "Instagram" ? "Instagram" : "Facebook");
    evidence.push("Facebook click id");
  }
  if (ids.li_fat_id) {
    pick("LinkedIn");
    evidence.push("LinkedIn click id");
  }
  if (ids.gclid) {
    pick("Google Ads");
    evidence.push("Google Ads click id");
  }
  if (ids.msclkid) {
    pick("Bing Ads");
    evidence.push("Microsoft Ads click id");
  }

  if (inApp) {
    pick(`${inApp} app`);
    evidence.push(`${inApp} in-app browser`);
  }

  let referrer = null;
  try {
    referrer = new URL(clip(payload.ref, 500));
  } catch (error) {
    referrer = null;
  }
  if (referrer && referrer.protocol === "android-app:") {
    pick(APP_REFERRERS[referrer.host] || referrer.host);
    evidence.push(`Android app ${referrer.host}`);
  } else if (referrer && /^https?:$/.test(referrer.protocol)) {
    const host = referrer.hostname.replace(/^www\./, "");
    if (!ownHosts.includes(referrer.hostname)) {
      pick(REFERRERS.find(([pattern]) => pattern.test(host))?.[1] || host);
      evidence.push(`referrer ${host}`);
    }
  }

  if (!name) return { name: "Direct", evidence: ["no referrer: typed or bookmarked link, a PDF (CV), or a messaging app"] };
  return { name, evidence };
};

/* ----- Message text ----- */

const placeOf = (cf) => {
  const country = countryName(cf.country);
  const parts = [cf.city, cf.region && cf.region !== cf.city ? cf.region : "", country].filter(Boolean);
  return parts.map((part) => clip(String(part), 60)).join(", ");
};

const visitorLine = (ret, ownerZone) => {
  const r = ret && typeof ret === "object" ? ret : {};
  const n = int(r.n, 1, 99999) || 1;
  const id = String(r.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const day = (ms) => {
    const time = Number(ms);
    return time > 1.6e12 && time < Date.now() + 864e5 ? zoned(new Date(time), ownerZone, { day: "numeric", month: "short" }) : "";
  };
  const parts = [n === 1 ? "🆕 First visit" : `🔁 Visit #${n}`];
  if (n > 1 && day(r.first)) parts.push(`first seen ${day(r.first)}`);
  if (n > 1 && day(r.last)) parts.push(`last ${day(r.last)}`);
  if (id) parts.push(`visitor ${id}`);
  return parts.map(esc).join(" · ");
};

const visitText = (payload, { cf, ip, ua, ownHosts, ownerZone }) => {
  const agent = describeAgent(ua, payload);
  const source = detectSource(payload, agent.inApp, ownHosts);
  const now = new Date();
  const lines = [];

  const city = clip(cf.city || countryName(cf.country) || "", 40);
  const headline = [source.name, [city, flag(cf.country)].filter(Boolean).join(" "), agent.device.name].filter(Boolean);
  // `back`: the visitor returned to a tab they left open for 30+ minutes.
  const title = payload.back === true ? "🔄 <b>Back on the page</b>" : "👀 <b>New visit</b>";
  lines.push(`${title} · ${headline.map((part) => esc(part)).join(" · ")}`);

  const place = placeOf(cf) || "Unknown location";
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  const mapped = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
  let location = mapped ? `<a href="https://www.google.com/maps?q=${lat},${lon}">${esc(place)}</a>` : esc(place);
  const clock = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (validZone(payload.tz) && validZone(cf.timezone) && zoned(now, payload.tz, clock) !== zoned(now, cf.timezone, clock)) {
    location += ` <i>(device clock is set to ${esc(payload.tz)}: VPN or travel?)</i>`;
  }
  lines.push(`📍 ${location}`);

  lines.push(`🔗 Source: <b>${esc(source.name)}</b> · ${source.evidence.map((item) => esc(item)).join(" · ")}`);

  const screen = Array.isArray(payload.scr) ? payload.scr : [];
  const width = int(screen[0], 0, 20000);
  const height = int(screen[1], 0, 20000);
  const ratio = Number(screen[2]);
  let screenText = "";
  if (width && height) {
    screenText = ` · ${width}×${height}`;
    if (Number.isFinite(ratio) && ratio > 0 && ratio !== 1) screenText += ` @${Math.round(ratio * 100) / 100}x`;
  }
  lines.push(`📱 Device: ${esc(agent.device.name)} · ${agent.device.type}${screenText}`);
  lines.push(`🧭 Browser: ${esc(agent.browser)} on ${esc(agent.os)}`);

  const asn = int(cf.asn, 0, 1e10);
  lines.push(`🌐 Network: ${show(cf.asOrganization || "unknown network", 60)}${asn ? ` (AS${asn})` : ""} · <code>${esc(ip)}</code>`);

  const zone = validZone(cf.timezone) ? cf.timezone : validZone(payload.tz) ? payload.tz : "";
  if (zone) {
    const time = zoned(now, zone, { weekday: "short", day: "numeric", month: "short", ...clock });
    if (time) lines.push(`🕒 Their time: ${esc(time)} (${esc(zone)})`);
  }

  const languages = (Array.isArray(payload.lang) ? payload.lang : []).map((lang) => clip(lang, 15)).filter(Boolean).slice(0, 3);
  if (languages.length) lines.push(`🗣 Languages: ${languages.map((lang) => esc(lang)).join(", ")}`);

  lines.push(visitorLine(payload.ret, ownerZone));

  const hash = clip(payload.hash, 80);
  if (hash.startsWith("#") && hash.length > 1) lines.push(`📄 Opened a direct link to <code>${esc(hash)}</code>`);

  try {
    const referrer = new URL(clip(payload.ref, 500));
    if (/^https?:$/.test(referrer.protocol) && !ownHosts.includes(referrer.hostname) && (referrer.pathname.length > 1 || referrer.search)) {
      lines.push(`↪️ Referrer: ${show(referrer.href, 150)}`);
    }
  } catch (error) {
    // No referrer, or not a URL.
  }

  return lines.join("\n");
};

const summaryText = (sum, budget) => {
  const s = sum && typeof sum === "object" ? sum : {};
  const list = (items) =>
    Array.isArray(items) ? [...new Set(items.map((item) => clip(item, 50)).filter(Boolean))].slice(0, 12).map((item) => esc(item)) : [];

  const secs = int(s.secs, 0, 86400) || 0;
  const scroll = int(s.scroll, 0, 100);
  const lines = ["📊 <b>Visit summary</b> (updates when they leave the tab)"];
  lines.push(`⏱ Active for ${duration(secs)}${scroll ? ` · scrolled ${scroll}% of the page` : ""}`);
  const groups = [
    ["👁 Viewed", list(s.seen)],
    ["▶️ Opened", list(s.demos)],
    ["🔗 Clicked", list(s.links)],
    ["📋 Copied", list(s.copied)],
  ];
  for (const [label, items] of groups) if (items.length) lines.push(`${label}: ${items.join(", ")}`);
  if (s.cv === true) lines.push("⬇️ Downloaded the CV");
  if (s.msg === true) lines.push("✉️ Sent a message through the contact form");

  while (lines.length > 1 && lines.join("\n").length > budget) lines.pop();
  return lines.join("\n");
};

const contextLine = (cf, ip, ua, payload) => {
  const agent = describeAgent(ua, payload);
  const place = placeOf(cf) || "Unknown location";
  return `📍 ${esc(place)} ${flag(cf.country)} · ${esc(agent.browser)} on ${esc(agent.os)} · <code>${esc(ip)}</code>`;
};

/* ----- Telegram ----- */

const telegram = async (env, method, payload) => {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...payload,
      }),
    });
    const data = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
    if (!data.ok && !/not modified/i.test(data.description || "")) console.log(`telegram ${method} failed: ${data.description}`);
    return data;
  } catch (error) {
    console.log(`telegram ${method} error: ${error}`);
    return { ok: false };
  }
};

const replyTo = (messageId) => (messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {});

/* ----- Routes ----- */

const handle = async (kind, payload, request, env, cors) => {
  const cf = request.cf || {};
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "";
  const ownHosts = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => {
      try {
        return new URL(origin.trim()).hostname;
      } catch (error) {
        return "";
      }
    })
    .filter(Boolean);
  const ownerZone = validZone(env.OWNER_TZ) ? env.OWNER_TZ : "UTC";

  if (kind === "v") {
    const text = visitText(payload, { cf, ip, ua, ownHosts, ownerZone });
    const sent = await telegram(env, "sendMessage", { text });
    if (!sent.ok) return json({ ok: false }, 502, cors);
    return json({ ok: true, v: await sign(env, sent.result.message_id, text), t: text }, 200, cors);
  }

  if (kind === "contact") {
    const name = clip(payload.name, 100);
    const email = clip(payload.email, 200);
    const message = clip(payload.message, 3500, true);
    if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "invalid" }, 400, cors);
    const messageId = await verify(env, payload.v, payload.t);
    const text = [
      "✉️ <b>New message from the portfolio</b>",
      "",
      `<b>Name:</b> ${esc(name)}`,
      `<b>Email:</b> ${esc(email)}`,
      "",
      esc(message),
      "",
      contextLine(cf, ip, ua, payload),
    ].join("\n");
    const sent = await telegram(env, "sendMessage", { text, ...replyTo(messageId) });
    return json({ ok: Boolean(sent.ok) }, sent.ok ? 200 : 502, cors);
  }

  // /e and /s follow up on an existing alert.
  const messageId = await verify(env, payload.v, payload.t);
  if (!messageId) return json({ ok: false, error: "bad reference" }, 403, cors);

  if (kind === "e") {
    if (payload.type !== "cv") return json({ ok: false, error: "unknown event" }, 400, cors);
    const secs = int(payload.secs, 0, 86400);
    const text = `⬇️ <b>CV downloaded</b>${secs !== null ? ` · ${duration(secs)} into the visit` : ""}`;
    const sent = await telegram(env, "sendMessage", { text, ...replyTo(messageId) });
    return json({ ok: Boolean(sent.ok) }, sent.ok ? 200 : 502, cors);
  }

  const text = `${payload.t}\n\n${summaryText(payload.sum, MAX_TEXT - payload.t.length - 2)}`;
  const sent = await telegram(env, "editMessageText", { message_id: messageId, text });
  const ok = Boolean(sent.ok) || /not modified/i.test(sent.description || "");
  return json({ ok }, ok ? 200 : 502, cors);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : null;

    if (request.method === "OPTIONS") {
      if (!cors) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "POST" || !ROUTES.has(url.pathname)) return new Response("Not found", { status: 404 });
    if (!cors) return new Response("Forbidden", { status: 403 });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, error: "not configured" }, 503, cors);

    try {
      if (Number(request.headers.get("Content-Length")) > MAX_BODY) return json({ ok: false }, 413, cors);
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false }, 413, cors);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        return json({ ok: false, error: "bad json" }, 400, cors);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false }, 400, cors);

      const kind = url.pathname.slice(1);
      const ua = request.headers.get("User-Agent") || "";
      // Bots get a quiet "no content" so they don't retry. The contact form is exempt: a person
      // may write from an unusual client, and the rate limit still applies.
      if (kind !== "contact" && (!ua || payload.wd === true || BOT_UA.test(ua))) return new Response(null, { status: 204, headers: cors });
      if (await overLimit(env, kind, request.headers.get("CF-Connecting-IP") || "unknown")) {
        return json({ ok: false, error: "rate limited" }, 429, cors);
      }
      return await handle(kind, payload, request, env, cors);
    } catch (error) {
      console.log(`unhandled: ${error && error.stack ? error.stack : error}`);
      return json({ ok: false }, 500, cors);
    }
  },
};

"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
const saveData = Boolean(navigator.connection && navigator.connection.saveData);
const announcer = $("#announcer");

const announce = (message) => {
  announcer.textContent = "";
  window.setTimeout(() => (announcer.textContent = message), 50);
};

/* ----- Visit notifications ----- */
// Each visit sends one Telegram alert through the portfolio-notify Cloudflare Worker (worker/),
// which adds location and network details and keeps the bot token private. A CV download sends a
// reply, and leaving the tab edits the alert with a short summary. Open the site once with
// ?notrack to stop alerts from your own browser; ?track turns them back on.

const NOTIFY_URL = "https://portfolio-notify.rasul-ai.workers.dev";
const NOTIFY_HOSTS = ["rasul-ai.github.io"];

const visit = (() => {
  const IDLE_MS = 30 * 60 * 1000;
  const SECTIONS = {
    experience: "Experience",
    projects: "Projects",
    research: "Research",
    skills: "Skills",
    education: "Education",
    references: "References",
    contact: "Contact",
  };

  const storage = (name) => ({
    get(key) {
      try {
        return JSON.parse(window[name].getItem(key));
      } catch (error) {
        return null;
      }
    },
    set(key, value) {
      try {
        window[name].setItem(key, JSON.stringify(value));
      } catch (error) {
        // Storage can be unavailable (private mode); alerts still work for this page view.
      }
    },
    remove(key) {
      try {
        window[name].removeItem(key);
      } catch (error) {
        // As above.
      }
    },
  });
  const local = storage("localStorage");
  const session = storage("sessionStorage");

  // Read the source tag and ad click ids, then strip them from the address bar so a copied or
  // forwarded link isn't credited to the original source.
  const params = new URLSearchParams(location.search);
  if (params.has("notrack")) local.set("pv-off", true);
  if (params.has("track")) local.remove("pv-off");
  const tag = params.get("src") || params.get("ref") || params.get("utm_source") || "";
  const ids = {};
  ["fbclid", "gclid", "li_fat_id", "msclkid"].forEach((id) => {
    if (params.has(id)) ids[id] = 1;
  });
  const kept = new URLSearchParams(location.search);
  [...kept.keys()].forEach((key) => {
    if (/^(src|ref|track|notrack|fbclid|gclid|li_fat_id|msclkid|utm_\w+)$/.test(key)) kept.delete(key);
  });
  if (kept.toString() !== params.toString()) {
    const query = kept.toString();
    history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash);
  }

  const off = local.get("pv-off") === true;
  if (off) console.info("Visit alerts are off in this browser. Open the site with ?track to turn them back on.");
  const enabled = !off && "fetch" in window && (NOTIFY_HOSTS.includes(location.hostname) || params.has("track"));
  if (!enabled) return { note() {}, context: () => ({}) };

  // One alert per visit. A reload, or coming back to the tab within 30 minutes, continues the
  // visit; a new tab, or coming back after 30+ minutes away, starts a new one.
  const freshSummary = () => ({ secs: 0, scroll: 0, seen: [], demos: [], links: [], copied: [], cv: false, msg: false });
  const loadedAt = Date.now();
  let current = session.get("pv-s");
  const resumed = Boolean(
    current &&
      loadedAt - (Number(current.last) || 0) < IDLE_MS &&
      (current.v || loadedAt - (Number(current.start) || 0) < 15000)
  );
  if (!resumed) current = { start: loadedAt, last: loadedAt };

  const sum = freshSummary();
  if (resumed && current.sum) Object.assign(sum, current.sum);
  ["seen", "demos", "links", "copied"].forEach((list) => {
    if (!Array.isArray(sum[list])) sum[list] = [];
  });
  sum.secs = Number(sum.secs) || 0;

  let visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  const activeSecs = () => Math.round(sum.secs + (visibleSince === null ? 0 : (performance.now() - visibleSince) / 1000));
  const pause = () => {
    if (visibleSince === null) return;
    sum.secs += (performance.now() - visibleSince) / 1000;
    visibleSince = null;
  };

  const save = () => {
    current.last = Date.now();
    current.sum = { ...sum, secs: activeSecs() };
    session.set("pv-s", current);
  };

  // text/plain bodies keep these CORS "simple requests": no preflight, and beacons work on exit.
  const post = (path, data) => {
    const body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(NOTIFY_URL + path, body)) return;
    } catch (error) {
      // Fall back to fetch below.
    }
    fetch(NOTIFY_URL + path, { method: "POST", body, keepalive: true }).catch(() => {});
  };

  let markReady;
  let ready;
  const resetReady = () => {
    ready = new Promise((resolve) => (markReady = resolve));
  };
  resetReady();
  if (current.v) markReady();

  const clientHints = () => {
    const data = navigator.userAgentData;
    if (!data) return Promise.resolve(null);
    const base = { platform: data.platform, mobile: data.mobile, brands: data.brands };
    if (!data.getHighEntropyValues) return Promise.resolve(base);
    const detailed = data
      .getHighEntropyValues(["platformVersion", "model", "fullVersionList"])
      .then((values) => ({
        ...base,
        platformVersion: values.platformVersion,
        model: values.model,
        brands: values.fullVersionList || base.brands,
      }))
      .catch(() => base);
    return Promise.race([detailed, new Promise((resolve) => window.setTimeout(() => resolve(base), 400))]);
  };

  const start = async (back = false) => {
    const now = Date.now();
    const mine = (current = { start: now, last: now });
    Object.assign(sum, freshSummary());
    lastSent = "";
    visibleSince = document.visibilityState === "visible" ? performance.now() : null;
    resetReady();
    session.set("pv-s", current);

    const visitor = local.get("pv") || {};
    const id = typeof visitor.id === "string" ? visitor.id : Math.random().toString(36).slice(2, 8);
    const count = (Number(visitor.n) || 0) + 1;
    const first = Number(visitor.first) || now;
    local.set("pv", { id, n: count, first, last: now });

    let timeZone = "";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      timeZone = "";
    }
    const payload = {
      src: tag,
      ids,
      ref: document.referrer,
      hash: location.hash,
      lang: Array.from(navigator.languages || [navigator.language]).slice(0, 3),
      tz: timeZone,
      scr: [screen.width, screen.height, window.devicePixelRatio || 1],
      touch: navigator.maxTouchPoints || 0,
      brave: Boolean(navigator.brave),
      wd: navigator.webdriver === true,
      back,
      ch: await clientHints(),
      ret: { id, n: count, first, last: Number(visitor.last) || null },
    };
    const response = await fetch(`${NOTIFY_URL}/v`, { method: "POST", body: JSON.stringify(payload), keepalive: true });
    const data = await response.json();
    if (data.ok && data.v && current === mine) {
      current.v = data.v;
      current.t = data.t;
      save();
      markReady();
    }
  };

  /* Engagement for the summary: active time, scroll depth, sections, demos, links, copies. */

  const add = (list, label) => {
    if (label && !sum[list].includes(label) && sum[list].length < 12) sum[list].push(label);
  };

  let lastSent = "";
  const flush = () => {
    pause();
    save();
    if (!current.v) return;
    const body = JSON.stringify(current.sum);
    if (body === lastSent) return;
    lastSent = body;
    post("/s", { v: current.v, t: current.t, sum: current.sum });
  };

  const resume = () => {
    if (document.visibilityState !== "visible" || visibleSince !== null) return;
    if (Date.now() - (Number(current.last) || 0) >= IDLE_MS) {
      start(true).catch(() => {});
    } else {
      visibleSince = performance.now();
      save();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else resume();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });

  let scrollQueued = false;
  const measureScroll = () => {
    scrollQueued = false;
    const height = Math.max(document.documentElement.scrollHeight, 1);
    const depth = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / height) * 100));
    if (depth > sum.scroll) sum.scroll = depth;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      window.requestAnimationFrame(measureScroll);
    },
    { passive: true }
  );
  measureScroll();

  if ("IntersectionObserver" in window) {
    // A section counts as viewed after a second in the middle of the screen, so the sections a
    // smooth-scrolling nav jump passes over are left out.
    const dwell = new Map();
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          window.clearTimeout(dwell.get(entry.target));
          if (entry.isIntersecting) {
            dwell.set(entry.target, window.setTimeout(() => add("seen", SECTIONS[entry.target.id]), 1000));
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    Object.keys(SECTIONS).forEach((id) => {
      const section = document.getElementById(id);
      if (section) sectionObserver.observe(section);
    });
  }

  const linkLabel = (link) => {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("mailto:")) return "Email link";
    if (href.startsWith("tel:")) return "Phone link";
    let url;
    try {
      url = new URL(link.href);
    } catch (error) {
      return "";
    }
    if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) return "";
    const host = url.hostname.replace(/^www\./, "");
    const viewerTitle = link.closest("#viewer") && $(".viewer-title");
    const about = viewerTitle ? `: ${viewerTitle.textContent.replace(/\s+/g, " ").trim()}` : "";
    if (host === "github.com") {
      const repo = url.pathname.split("/").filter(Boolean)[1];
      return repo ? `GitHub: ${repo}` : "GitHub profile";
    }
    if (host.endsWith("linkedin.com")) return "LinkedIn";
    if (host === "scholar.google.com") return "Google Scholar";
    if (host.endsWith("medium.com")) return "Medium article";
    if (host === "doi.org" || host.endsWith("mdpi.com")) return "Paper (DOI)";
    if (host === "drive.google.com") return `Drive demo${about}`;
    if (host === "docs.google.com") return `Slides${about}`;
    return host + about;
  };

  document.addEventListener(
    "click",
    (event) => {
      const copy = event.target.closest("[data-copy], [data-copy-from]");
      if (copy) {
        const label = (copy.getAttribute("aria-label") || copy.textContent).replace(/\s+/g, " ").trim();
        if (label && !/^(copied|copy failed)$/i.test(label)) add("copied", label.replace(/^Copy\s+/i, ""));
      }
      const link = event.target.closest("a[href]");
      if (!link) return;
      // A plain click on a demo link opens the viewer instead (counted under demos).
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (!modified && link.closest("[data-open]") && link.closest("[data-dialog]")) return;
      if (link.matches('a[download][href$=".pdf"]')) {
        if (sum.cv) return;
        sum.cv = true;
        const secs = activeSecs();
        save();
        ready.then(() => post("/e", { v: current.v, t: current.t, type: "cv", secs }));
        return;
      }
      add("links", linkLabel(link));
    },
    true
  );

  if (!resumed) start().catch(() => {});

  return {
    note(kind, label) {
      if (kind === "msg") sum.msg = true;
      else add(kind, label);
      save();
    },
    context: () => (current.v ? { v: current.v, t: current.t } : {}),
  };
})();

/* ----- Theme ----- */

const themeToggle = $(".theme-toggle");
const themeColor = $('meta[name="theme-color"]');

const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");

const syncThemeControls = () => {
  const theme = currentTheme();
  themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  themeColor.setAttribute("content", theme === "dark" ? "#121211" : "#f5f4ef");
};

themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch (error) {
    // Storage can be unavailable (private mode); the toggle still works for this visit.
  }
  syncThemeControls();
});

systemDark.addEventListener("change", syncThemeControls);
syncThemeControls();

/* ----- Mobile menu ----- */

const nav = $("#site-nav");
const menuToggle = $(".menu-toggle");

const setMenu = (open) => {
  nav.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  $("use", menuToggle).setAttribute("href", open ? "#i-close" : "#i-menu");
};

menuToggle.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
nav.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("click", (event) => {
  if (nav.classList.contains("is-open") && !event.target.closest(".site-header")) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav.classList.contains("is-open")) {
    setMenu(false);
    menuToggle.focus();
  }
});

/* ----- Scroll-spy: primary nav and the Softworks area index ----- */

const spy = (links, targets, rootMargin) => {
  const linkFor = new Map(targets.map((target, i) => [target, links[i] || null]));
  const realLinks = links.filter(Boolean);
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const active = linkFor.get(entry.target);
        realLinks.forEach((link) => {
          if (link === active) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        });
      });
    },
    { rootMargin }
  );
  targets.filter(Boolean).forEach((target) => observer.observe(target));
};

const navLinks = $$('.site-nav a[href^="#"]');
const navTargets = navLinks.map((link) => $(link.getAttribute("href")));
// The intro and references have no nav entry; reaching them clears the highlight.
spy([...navLinks, null, null], [...navTargets, $("#top"), $("#references")], "-45% 0px -50% 0px");

const areaLinks = $$(".role-index a");
spy(areaLinks, areaLinks.map((link) => $(link.getAttribute("href"))), "-30% 0px -60% 0px");

/* ----- Role durations (inclusive months, LinkedIn-style) ----- */

const monthIndex = (value) => {
  const [year, month] = value.split("-").map(Number);
  return year * 12 + (month - 1);
};

const formatDuration = (months) => {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts = [];
  if (years) parts.push(`${years} yr${years > 1 ? "s" : ""}`);
  if (rest) parts.push(`${rest} mo${rest > 1 ? "s" : ""}`);
  return parts.join(" ");
};

$$(".role-duration").forEach((el) => {
  const now = new Date();
  const end = el.dataset.end ? monthIndex(el.dataset.end) : now.getFullYear() * 12 + now.getMonth();
  el.textContent = formatDuration(end - monthIndex(el.dataset.start) + 1);
});

/* ----- Demo previews ----- */

const previewCards = $$(".project").filter((card) => $("video.preview", card));
const previewsAllowed = () => !reduceMotion.matches && !saveData;

const startPreview = (card) => {
  if (!previewsAllowed()) return;
  const video = $("video.preview", card);
  if (!video.getAttribute("src")) video.src = video.dataset.src;
  const playing = video.play();
  if (playing) playing.then(() => card.classList.add("is-previewing")).catch(() => {});
};

const stopPreview = (card) => {
  card.classList.remove("is-previewing");
  $("video.preview", card).pause();
};

const stopAllPreviews = () => previewCards.forEach(stopPreview);

if (canHover.matches) {
  previewCards.forEach((card) => {
    const media = $(".project-media", card);
    media.addEventListener("pointerenter", () => startPreview(card));
    media.addEventListener("pointerleave", () => stopPreview(card));
    card.addEventListener("focusin", () => startPreview(card));
    card.addEventListener("focusout", (event) => {
      if (!card.contains(event.relatedTarget)) stopPreview(card);
    });
  });
} else {
  // Touch screens: play the card that is mostly in view, one at a time.
  let activeCard = null;
  const inView = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const card = entry.target.closest(".project");
        if (entry.intersectionRatio >= 0.6) {
          if (activeCard && activeCard !== card) stopPreview(activeCard);
          activeCard = card;
          startPreview(card);
        } else if (card === activeCard) {
          stopPreview(card);
          activeCard = null;
        }
      });
    },
    { threshold: [0, 0.6] }
  );
  previewCards.forEach((card) => inView.observe($(".project-media", card)));
}

/* ----- Viewer dialog (demos, slides, images) ----- */

const viewer = $("#viewer");
const viewerMedia = $(".viewer-media", viewer);
const viewerOutline = $(".viewer-outline", viewer);
const prevButton = $(".viewer-prev", viewer);
const nextButton = $(".viewer-next", viewer);

let currentItem = null;
let returnFocus = null;
let pushedHistory = false;

const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
const itemTitle = (item) => clean($(".project-title, .index-name", item).textContent);
const itemDescription = (item) => clean(($(".project-desc, .index-desc", item) || {}).textContent);
const collectionOf = (item) => $$("[data-dialog]", item.closest("[data-collection]") || document);
const findItem = (slug) => $$("[data-dialog]").find((item) => item.dataset.dialog === slug);

const externalLink = (href, label) => {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.innerHTML = `${label}<svg class="icon" aria-hidden="true"><use href="#i-external" /></svg>`;
  return a;
};

const buildMedia = (item, autoplay) => {
  const { kind, src, poster, aspect, caption } = item.dataset;
  viewerMedia.replaceChildren();
  viewerMedia.style.setProperty("--aspect", aspect || "16 / 10");

  if (kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (poster) video.poster = poster;
    video.src = src;
    viewerMedia.append(video);
    if (autoplay) video.play().catch(() => {});
  } else if (kind === "embed") {
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = `${itemTitle(item)} — demo`;
    frame.allow = "autoplay; fullscreen";
    viewerMedia.append(frame);
  } else if (kind === "image") {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = src;
    img.alt = caption || itemTitle(item);
    figure.append(img);
    if (caption) {
      const figcaption = document.createElement("figcaption");
      figcaption.textContent = caption;
      figure.append(figcaption);
    }
    viewerMedia.append(figure);
  }
};

const renderItem = (item, autoplay) => {
  const { context, outline, note, highlight, drive, slides, repo, live } = item.dataset;
  currentItem = item;

  $(".viewer-context", viewer).textContent = context || "";
  $(".viewer-title", viewer).textContent = itemTitle(item);
  $(".viewer-desc", viewer).textContent = itemDescription(item);

  const highlightEl = $(".viewer-highlight", viewer);
  highlightEl.textContent = highlight || "";
  highlightEl.hidden = !highlight;

  const steps = outline ? outline.split("|") : [];
  $("ol", viewerOutline).replaceChildren(
    ...steps.map((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      return li;
    })
  );
  const noteEl = $(".panel-note", viewerOutline);
  noteEl.textContent = note || "";
  noteEl.hidden = !note;
  viewerOutline.hidden = steps.length === 0;

  const links = [];
  if (drive) links.push(externalLink(drive, "Open on Google Drive"));
  if (slides) links.push(externalLink(slides, "Open in Google Slides"));
  if (live) links.push(externalLink(live, "Live demo"));
  if (repo) links.push(externalLink(repo, "Source on GitHub"));
  $(".viewer-links", viewer).replaceChildren(...links);

  const siblings = collectionOf(item);
  const index = siblings.indexOf(item);
  const prev = siblings[(index - 1 + siblings.length) % siblings.length];
  const next = siblings[(index + 1) % siblings.length];
  $(".viewer-nav-title", prevButton).textContent = itemTitle(prev);
  $(".viewer-nav-title", nextButton).textContent = itemTitle(next);
  prevButton.dataset.target = prev.dataset.dialog;
  nextButton.dataset.target = next.dataset.dialog;
  prevButton.hidden = nextButton.hidden = siblings.length < 2;
  $(".viewer-count", viewer).textContent = `${index + 1} / ${siblings.length}`;

  buildMedia(item, autoplay);
};

const openItem = (item, { autoplay = false, updateHistory = true } = {}) => {
  const wasOpen = viewer.open;
  stopAllPreviews();
  renderItem(item, autoplay);
  visit.note("demos", itemTitle(item));
  if (!wasOpen) {
    viewer.showModal();
    document.body.classList.add("has-dialog");
  }
  if (updateHistory) {
    // One history entry per visit to the viewer: Back closes it, prev/next only replace the URL.
    const hash = `#demo/${item.dataset.dialog}`;
    if (wasOpen) {
      history.replaceState({ demo: item.dataset.dialog }, "", hash);
    } else if (location.hash !== hash) {
      history.pushState({ demo: item.dataset.dialog }, "", hash);
      pushedHistory = true;
    }
  }
};

viewer.addEventListener("close", () => {
  viewerMedia.replaceChildren();
  document.body.classList.remove("has-dialog");
  if (pushedHistory) {
    pushedHistory = false;
    history.back();
  } else if (location.hash.startsWith("#demo/")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  currentItem = null;
});

// A click on the backdrop lands on the dialog element itself.
viewer.addEventListener("click", (event) => {
  if (event.target === viewer) viewer.close();
});

$(".viewer-close", viewer).addEventListener("click", () => viewer.close());
[prevButton, nextButton].forEach((button) =>
  button.addEventListener("click", () => openItem(findItem(button.dataset.target)))
);

viewer.addEventListener("keydown", (event) => {
  if (event.target.closest("video, iframe, input, textarea")) return;
  if (event.key === "ArrowLeft" && !prevButton.hidden) prevButton.click();
  if (event.key === "ArrowRight" && !nextButton.hidden) nextButton.click();
});

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-open]");
  const item = trigger && trigger.closest("[data-dialog]");
  if (!item || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  // The media link is hidden from assistive tech, so return focus to the visible text control.
  returnFocus = $("a.text-btn[data-open]", item) || trigger;
  openItem(item, { autoplay: true });
});

const openFromHash = () => {
  const match = location.hash.match(/^#demo\/([\w-]+)$/);
  const item = match && findItem(match[1]);
  if (item) {
    openItem(item, { updateHistory: false });
  } else if (viewer.open) {
    pushedHistory = false;
    viewer.close();
  } else if (match) {
    history.replaceState(null, "", location.pathname + location.search);
  }
};

window.addEventListener("popstate", openFromHash);
openFromHash();

/* ----- Independent projects: filter and search ----- */

const rows = $$(".index-row");
const chips = $$(".chip");
const search = $("#project-search");
const emptyState = $(".index-empty");
const indexStatus = $("#index-status");
let activeArea = "all";

const applyFilter = () => {
  const query = search.value.trim().toLowerCase();
  let shown = 0;
  rows.forEach((row) => {
    const visible =
      (activeArea === "all" || row.dataset.area === activeArea) && (!query || row.textContent.toLowerCase().includes(query));
    row.hidden = !visible;
    if (visible) shown += 1;
  });
  emptyState.hidden = shown > 0;
  emptyState.textContent = query ? `No projects match “${search.value.trim()}”.` : "No projects in this area.";
  indexStatus.textContent = `Showing ${shown} of ${rows.length} projects`;
};

chips.forEach((chip) =>
  chip.addEventListener("click", () => {
    activeArea = chip.dataset.filter;
    chips.forEach((other) => other.setAttribute("aria-pressed", String(other === chip)));
    applyFilter();
  })
);
search.addEventListener("input", applyFilter);

/* ----- Copy to clipboard ----- */

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (fallbackError) {
      copied = false;
    }
    area.remove();
    return copied;
  }
};

$$("[data-copy], [data-copy-from]").forEach((button) => {
  const label = $("span", button);
  const icon = $("use", button);
  const original = { label: label && label.textContent, icon: icon && icon.getAttribute("href") };
  let timer;

  button.addEventListener("click", async () => {
    const text = button.dataset.copyFrom ? $(button.dataset.copyFrom).textContent : button.dataset.copy;
    const copied = await copyText(text);
    announce(copied ? "Copied to clipboard" : "Copy failed");
    if (label) label.textContent = copied ? "Copied" : "Copy failed";
    if (icon && copied) icon.setAttribute("href", "#i-check");
    button.classList.toggle("is-done", copied);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (label) label.textContent = original.label;
      if (icon) icon.setAttribute("href", original.icon);
      button.classList.remove("is-done");
    }, 1800);
  });
});

/* ----- Contact form ----- */

const form = $("#contact-form");
const formStatus = $(".form-status", form);
const submitButton = $('button[type="submit"]', form);

const setStatus = (state, message, withEmail = false) => {
  formStatus.dataset.state = state;
  formStatus.textContent = message;
  if (withEmail) {
    const link = document.createElement("a");
    link.href = "mailto:ai.rasulbapary@gmail.com";
    link.textContent = "ai.rasulbapary@gmail.com";
    formStatus.append(link, ".");
  }
};

$$("input, textarea", form).forEach((field) =>
  field.addEventListener("input", () => field.removeAttribute("aria-invalid"))
);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = ["name", "email", "message"].map((name) => form.elements[name]);
  let firstInvalid = null;
  fields.forEach((field) => {
    const valid = field.value.trim() !== "" && field.checkValidity();
    field.setAttribute("aria-invalid", String(!valid));
    if (!valid && !firstInvalid) firstInvalid = field;
  });
  if (firstInvalid) {
    setStatus("error", "Please add your name, a valid email address and a message.");
    firstInvalid.focus();
    return;
  }

  const [name, email, message] = fields.map((field) => field.value.trim());
  submitButton.disabled = true;
  setStatus("sending", "Sending…");

  try {
    // Sent through the same Worker as the visit alerts, so the bot token stays private.
    const response = await fetch(`${NOTIFY_URL}/contact`, {
      method: "POST",
      body: JSON.stringify({ name, email, message, ...visit.context() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
    visit.note("msg");
    form.reset();
    fields.forEach((field) => field.removeAttribute("aria-invalid"));
    setStatus("sent", "Thanks, your message has been sent. I’ll reply by email.");
  } catch (error) {
    setStatus("error", "The message couldn’t be sent just now. Please email me at ", true);
  } finally {
    submitButton.disabled = false;
  }
});

/* ----- Footer year ----- */

$(".year").textContent = String(new Date().getFullYear());

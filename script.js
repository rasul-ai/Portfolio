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
const reverse = (value) => value.split("").reverse().join("");
const TELEGRAM_TOKEN = reverse("8ebiH1BAawsPkW8AAyDFP1nr5iRydiEYEAA:9591213108");
const TELEGRAM_CHAT = reverse("043774283");

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
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: `New message from the portfolio\n\nName: ${name}\nEmail: ${email}\n\n${message}`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.description || response.statusText);
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

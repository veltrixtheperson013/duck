const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
// Load language choices only when requested; no Google script runs on Duck.
function installLanguagePicker() {
  const host = document.querySelector("footer") || document.querySelector("main");
  if (!host) return;
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const button = element("button", "duck-language-button", "Language");
  button.type = "button"; button.setAttribute("aria-haspopup", "dialog");
  const icon = element("span", "duck-language-glyph"); icon.setAttribute("aria-hidden", "true"); button.prepend(icon);
  const dialog = element("dialog", "duck-language-dialog"); dialog.setAttribute("aria-labelledby", "duck-language-title");
  const header = element("div", "duck-language-heading");
  const heading = element("div"); heading.append(element("small", "duck-language-eyebrow", "MAKE YOURSELF AT HOME"));
  const title = element("h2", "", "Choose your language"); title.id = "duck-language-title"; heading.append(title);
  const close = element("button", "duck-language-close", "\u00d7"); close.type = "button"; close.setAttribute("aria-label", "Close language picker"); close.addEventListener("click", () => dialog.close()); header.append(heading, close);
  const status = element("p", "duck-language-status", "Loading languages..."); status.dataset.languageStatus = "";
  const search = element("input", "duck-language-search"); search.type = "search"; search.placeholder = "Search languages..."; search.setAttribute("aria-label", "Search languages");
  const list = element("div", "duck-language-list"); list.setAttribute("aria-label", "Languages");
  const footer = element("div", "duck-language-footer");
  const selectedLabel = element("span", "duck-language-selection"); selectedLabel.setAttribute("aria-live", "polite");
  const link = element("a", "duck-language-translate", "Translate with Google"); link.dataset.languageOpen = ""; link.target = "_blank"; link.rel = "noopener noreferrer"; link.hidden = true;
  footer.append(selectedLabel, link); dialog.append(header, status, search, list, footer); document.body.append(dialog); host.append(button);
  let loaded; let selected = "en";
  const privatePage = /\/(?:dashboard|billing|auth|admin|api)(?:[/.]|$)/i.test(location.pathname);
  const refresh = () => {
    if (!loaded) return;
    link.hidden = !loaded.enabled || privatePage;
    status.textContent = !loaded.enabled ? "Coming September 22. Explore the languages below." : privatePage ? "Use your browser's Translate page option for this signed-in page." : "Read this page in your language with Google Translate. Opens a translated copy in a new tab.";
    const language = loaded.languages.find((item) => item.code === selected);
    selectedLabel.textContent = language ? language.name + " selected" : "Choose a language";
    const target = new URL("https://translate.google.com/translate");
    target.search = new URLSearchParams({ sl: "en", tl: selected, u: new URL(location.pathname, "https://duck.wispbyte.app").href }); link.href = target.href;
    const query = search.value.trim().toLocaleLowerCase();
    const matches = loaded.languages.filter((item) => (item.name + " " + item.nativeName + " " + item.code).toLocaleLowerCase().includes(query));
    list.replaceChildren(...matches.map((item) => {
      const choice = element("button", "duck-language-option"); choice.type = "button"; choice.setAttribute("aria-pressed", String(item.code === selected));
      const text = element("span"); const native = element("strong", "", item.nativeName); native.dir = "auto"; native.lang = item.code;
      text.append(native, element("small", "", item.name));
      const check = element("span", "duck-language-check", item.code === selected ? "\u2713" : ""); check.setAttribute("aria-hidden", "true"); choice.append(text, check);
      choice.addEventListener("click", () => { selected = item.code; refresh(); list.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); });
      return choice;
    }));
    if (!matches.length) list.append(element("p", "duck-language-empty", "No languages found. Try another name or language code."));
  };
  search.addEventListener("input", refresh);
  dialog.addEventListener("close", () => button.focus());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  button.addEventListener("click", async () => {
    if (!dialog.open) dialog.showModal(); search.focus();
    try {
      const response = await fetch("/api/languages", { credentials: "omit" }); if (!response.ok) throw new Error("unavailable");
      loaded = await response.json();
      if (!list.childElementCount) selected = loaded.languages.find((item) => item.code.toLowerCase() === navigator.language.toLowerCase())?.code || loaded.languages.find((item) => item.code === navigator.language.split("-")[0])?.code || "en";
      refresh();
    } catch { status.textContent = "Language choices could not load. Close this window and try again."; link.hidden = true; }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installLanguagePicker, { once: true });
else installLanguagePicker();
const reducedMotion = motionPreference.matches;
const runWhenIdle = (task, timeout = 1_200) => "requestIdleCallback" in window ? window.requestIdleCallback(task, { timeout }) : window.setTimeout(task, 1);
const duckThemes = [
  { id: "classic", name: "Classic Duck", icon: "🦆", copy: "Warm paper and pond green." },
  { id: "dark", name: "Midnight", icon: "🌙", copy: "Low-glare charcoal and mint." },
  { id: "galaxy", name: "Milky Way", icon: "🌌", copy: "Vivid starlight, cosmic dust, and a living galactic band." },
  { id: "matrix", name: "Matrix Rain", icon: "⌨️", copy: "Terminal glass and falling code." },
  { id: "nebula", name: "Nebula", icon: "🔮", copy: "Slow violet and cyan gas clouds." },
  { id: "black-hole", name: "Black Hole", icon: "🕳️", copy: "A cinematic event horizon with a bright accretion disc." },
  { id: "gradient", name: "Aurora", icon: "🌈", copy: "A living, luminous gradient." },
  { id: "windows-xp", name: "Windows XP", icon: "🖥️", copy: "Blue chrome, green hills, pure nostalgia." },
];
const darkThemes = new Set(["dark", "galaxy", "matrix", "nebula", "black-hole", "gradient"]);

function currentTheme() { return duckThemes.some(({ id }) => id === document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : "classic"; }
function saveTheme(theme) { try { localStorage.setItem("duck-theme", theme); } catch { /* Cosmetic preference storage may be unavailable. */ } }
function buildAtmosphere(theme) {
  document.querySelector("[data-theme-atmosphere]")?.remove();
  if (reducedMotion) return;
  if (!["galaxy", "matrix", "nebula", "black-hole", "gradient", "windows-xp"].includes(theme)) return;
  const atmosphere = document.createElement("div"); atmosphere.className = `theme-atmosphere theme-${theme}`; atmosphere.dataset.themeAtmosphere = ""; atmosphere.setAttribute("aria-hidden", "true"); const fragment = document.createDocumentFragment();
  const appendParticles = (count, className, content = "") => { for (let index = 0; index < count; index += 1) { const particle = document.createElement("i"); particle.className = className; particle.textContent = content; fragment.append(particle); } };
  if (theme === "galaxy") appendParticles(28, "theme-star");
  if (theme === "matrix") { const glyphs = "01DUCKｱｲｳｴｵｶｷｸｹｺ"; for (let index = 0; index < 12; index += 1) { const column = document.createElement("i"); column.className = "matrix-column"; column.textContent = Array.from({ length: 14 }, (_, row) => glyphs[(index * 7 + row * 3) % glyphs.length]).join("\n"); fragment.append(column); } }
  if (theme === "nebula") appendParticles(5, "nebula-cloud");
  if (theme === "black-hole") { const core = document.createElement("i"); core.className = "black-hole-core"; fragment.append(core); appendParticles(14, "space-dust"); }
  if (theme === "gradient") appendParticles(4, "aurora-orb");
  if (theme === "windows-xp") appendParticles(6, "xp-cloud");
  atmosphere.append(fragment); document.body.prepend(atmosphere);
}

function installThemeControls() {
  const dock = document.createElement("div"); const mode = document.createElement("button"); const picker = document.createElement("button"); const panel = document.createElement("aside"); const heading = document.createElement("div"); const title = document.createElement("strong"); const copy = document.createElement("small"); const grid = document.createElement("div");
  dock.className = "theme-dock"; dock.dataset.themeDock = ""; mode.type = "button"; mode.className = "theme-mode-toggle"; mode.setAttribute("aria-label", "Toggle light or dark mode"); picker.type = "button"; picker.className = "theme-picker-toggle"; picker.setAttribute("aria-label", "Choose website theme"); picker.setAttribute("aria-expanded", "false"); picker.setAttribute("aria-controls", "duck-theme-panel"); picker.textContent = "✦ Themes"; panel.id = "duck-theme-panel"; panel.className = "theme-panel"; panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "false"); panel.setAttribute("aria-labelledby", "duck-theme-title"); title.id = "duck-theme-title"; title.textContent = "Choose your pond"; copy.textContent = "Theme changes stay on this device."; heading.append(title, copy); grid.className = "theme-grid";
  const buttons = new Map();
  for (const theme of duckThemes) { const button = document.createElement("button"); const preview = document.createElement("i"); const text = document.createElement("span"); const name = document.createElement("strong"); const description = document.createElement("small"); button.type = "button"; button.className = "theme-option"; button.dataset.themeChoice = theme.id; preview.className = `theme-swatch swatch-${theme.id}`; preview.textContent = theme.icon; preview.setAttribute("aria-hidden", "true"); name.textContent = theme.name; description.textContent = theme.copy; text.append(name, description); button.append(preview, text); grid.append(button); buttons.set(theme.id, button); }
  panel.append(heading, grid); dock.append(mode, picker, panel); document.body.append(dock);
  const refresh = () => { const theme = currentTheme(); const dark = darkThemes.has(theme); mode.textContent = dark ? "☀️" : "🌙"; mode.title = dark ? "Use light mode" : "Use dark mode"; mode.setAttribute("aria-label", mode.title); for (const [id, button] of buttons) { const active = id === theme; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); } };
  const apply = (theme) => { if (!buttons.has(theme)) return; document.documentElement.dataset.theme = theme; saveTheme(theme); buildAtmosphere(theme); refresh(); };
  let closeTimer;
  const close = (restoreFocus = false) => { if (panel.hidden) return; window.clearTimeout(closeTimer); panel.classList.add("is-closing"); picker.setAttribute("aria-expanded", "false"); closeTimer = window.setTimeout(() => { panel.hidden = true; panel.classList.remove("is-closing"); if (restoreFocus) picker.focus(); }, reducedMotion ? 0 : 160); };
  const open = () => { window.clearTimeout(closeTimer); panel.hidden = false; panel.classList.remove("is-closing"); picker.setAttribute("aria-expanded", "true"); (buttons.get(currentTheme()) || buttons.values().next().value)?.focus(); };
  mode.addEventListener("click", () => apply(darkThemes.has(currentTheme()) ? "classic" : "dark")); picker.addEventListener("click", (event) => { event.stopPropagation(); if (panel.hidden || panel.classList.contains("is-closing")) open(); else close(); }); panel.addEventListener("click", (event) => event.stopPropagation()); document.addEventListener("click", () => close()); document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(true); }); for (const [theme, button] of buttons) button.addEventListener("click", () => { apply(theme); close(true); });
  runWhenIdle(() => buildAtmosphere(currentTheme())); refresh();
}

installThemeControls();

// Header and announcement heights vary with viewport, theme, and translated text.
// Keep fixed dashboard panels below the actual visible chrome, not a 70px guess.
const chromeHeader = document.querySelector(".site-header");
let chromeFrame = 0;
const measureChrome = () => {
  chromeFrame = 0;
  const banner = document.querySelector(".website-banner");
  const bannerHeight = Math.ceil(banner?.getBoundingClientRect().height || 0);
  const headerHeight = Math.ceil(chromeHeader?.getBoundingClientRect().height || 0);
  document.documentElement.style.setProperty("--banner-height", `${bannerHeight}px`);
  document.documentElement.style.setProperty("--header-height", `${headerHeight}px`);
  document.documentElement.style.setProperty("--chrome-height", `${bannerHeight + headerHeight}px`);
};
const scheduleChromeMeasure = () => { if (!chromeFrame) chromeFrame = requestAnimationFrame(measureChrome); };
const chromeObserver = new ResizeObserver(scheduleChromeMeasure);
if (chromeHeader) chromeObserver.observe(chromeHeader);
new MutationObserver(() => {
  const banner = document.querySelector(".website-banner");
  if (banner) chromeObserver.observe(banner);
  scheduleChromeMeasure();
}).observe(document.body, { childList: true, attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", scheduleChromeMeasure);
scheduleChromeMeasure();

for (const footer of document.querySelectorAll(".footer-links")) {
  const vote = document.createElement("a");
  vote.href = "https://top.gg/bot/1507850959642955816/vote";
  vote.textContent = "Vote for Duck ↗";
  vote.target = "_blank";
  vote.rel = "noopener noreferrer";
  footer.append(vote);
}

runWhenIdle(() => {
  fetch("/api/site-config")
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Site configuration unavailable")))
    .then(({ banner }) => {
      if (!banner?.message) return;
      const dismissalKey = `duck-banner:${banner.message}`;
      try { if (sessionStorage.getItem(dismissalKey) === "dismissed") return; } catch { /* A banner may still display if storage is unavailable. */ }
      const bar = document.createElement("aside"); const message = document.createElement("span"); const close = document.createElement("button");
      bar.className = `website-banner is-${banner.tone || "info"}`; bar.setAttribute("role", "status"); message.textContent = banner.message; close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Dismiss announcement");
      bar.append(message);
      if (banner.linkUrl) { const link = document.createElement("a"); link.href = banner.linkUrl; link.textContent = banner.linkLabel || "Learn more"; link.rel = "noopener noreferrer"; bar.append(link); }
      bar.append(close); close.addEventListener("click", () => { try { sessionStorage.setItem(dismissalKey, "dismissed"); } catch { /* Dismissal still works for this page. */ } bar.remove(); }); document.body.prepend(bar);
    })
    .catch(() => {});
});

if (!reducedMotion) {
  requestAnimationFrame(() => document.documentElement.classList.add("motion-ready"));
}

const serverCount = document.querySelector("[data-server-count]");
if (serverCount) {
  const metric = serverCount.closest("[data-server-metric]");
  const separator = document.querySelector("[data-server-separator]");
  runWhenIdle(() => {
    fetch("/api/stats")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Stats unavailable")))
      .then(({ servers }) => {
        const count = Number(servers);
        if (!Number.isSafeInteger(count) || count <= 0) return;
        serverCount.textContent = new Intl.NumberFormat().format(count);
        metric.hidden = false;
        if (separator) separator.hidden = false;
      })
      .catch(() => {});
  }, 800);
}

const menuButton = document.querySelector(".menu-button");
const mainNavigation = document.querySelector(".main-nav");
if (menuButton && mainNavigation) {
  if (!mainNavigation.id) mainNavigation.id = "site-navigation";
  menuButton.setAttribute("aria-controls", mainNavigation.id);
  const closeMenu = (restoreFocus = false) => {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    mainNavigation.classList.remove("is-open");
    if (restoreFocus) menuButton.focus();
  };
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    mainNavigation.classList.toggle("is-open", open);
    if (open) mainNavigation.querySelector("a")?.focus();
  });
  mainNavigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mainNavigation.classList.contains("is-open")) closeMenu(true);
  });
  document.addEventListener("click", (event) => {
    if (!mainNavigation.classList.contains("is-open") || menuButton.contains(event.target) || mainNavigation.contains(event.target)) return;
    closeMenu();
  });
  window.matchMedia("(min-width: 761px)").addEventListener?.("change", (event) => { if (event.matches) closeMenu(); });
}

const revealItems = document.querySelectorAll(".feature-grid article, .trust-strip, .product-window, .approval-flow, .safety-proof, .catalog-section, .cta, .guide-step, .policy-document section");
if (!reducedMotion && "IntersectionObserver" in window) {
  document.documentElement.classList.add("has-reveal");
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -7%", threshold: 0.08 });
  revealItems.forEach((item, index) => {
    item.style.setProperty("--reveal-delay", `${Math.min(index % 3, 2) * 70}ms`);
    observer.observe(item);
  });
}

for (const card of document.querySelectorAll(".code-card")) {
  const code = card.querySelector("code");
  const title = card.querySelector(".code-title");
  if (!code || !title || !navigator.clipboard) continue;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy configuration example");
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      button.textContent = "Copied";
      button.classList.add("is-copied");
    } catch {
      button.textContent = "Copy failed";
    }
    window.setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("is-copied");
    }, 1600);
  });
  title.append(button);
}

function installLucideIcons() {
  const mapping = { features: "sparkles", guide: "book-open", updates: "history", clusters: "activity", status: "activity", pricing: "badge-dollar-sign", privacy: "shield-check", "privacy-policy": "shield-check", dashboard: "layout-dashboard", donate: "heart" };
  for (const anchor of document.querySelectorAll(".site-header nav a, a.button, footer a")) {
    if (anchor.querySelector("svg, img") || anchor.classList.contains("brand")) continue;
    const url = new URL(anchor.href, location.href);
    const route = url.pathname.split("/").filter(Boolean).pop()?.replace(/\.html$/, "");
    const icon = url.hostname === "top.gg" ? "thumbs-up" : url.hostname === "discord.com" && url.pathname.includes("oauth2") ? "plus" : url.pathname === "/auth/discord" ? "log-in" : mapping[route];
    if (!icon) continue;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "duck-ui-icon"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/icons.svg#" + icon); svg.append(use); anchor.prepend(svg);
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installLucideIcons, { once: true });
else installLucideIcons();

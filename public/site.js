const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const duckThemes = [
  { id: "classic", name: "Classic Duck", icon: "🦆", copy: "Warm paper and pond green." },
  { id: "light", name: "Daylight", icon: "☀️", copy: "Bright, crisp, and quiet." },
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
  if (!["galaxy", "matrix", "nebula", "black-hole", "gradient", "windows-xp"].includes(theme)) return;
  const atmosphere = document.createElement("div"); atmosphere.className = `theme-atmosphere theme-${theme}`; atmosphere.dataset.themeAtmosphere = ""; atmosphere.setAttribute("aria-hidden", "true"); const fragment = document.createDocumentFragment();
  const appendParticles = (count, className, content = "") => { for (let index = 0; index < count; index += 1) { const particle = document.createElement("i"); particle.className = className; particle.textContent = content; fragment.append(particle); } };
  if (theme === "galaxy") appendParticles(96, "theme-star");
  if (theme === "matrix") { const glyphs = "01DUCKｱｲｳｴｵｶｷｸｹｺ"; for (let index = 0; index < 18; index += 1) { const column = document.createElement("i"); column.className = "matrix-column"; column.textContent = Array.from({ length: 18 }, (_, row) => glyphs[(index * 7 + row * 3) % glyphs.length]).join("\n"); fragment.append(column); } }
  if (theme === "nebula") appendParticles(5, "nebula-cloud");
  if (theme === "black-hole") { const core = document.createElement("i"); core.className = "black-hole-core"; fragment.append(core); appendParticles(30, "space-dust"); }
  if (theme === "gradient") appendParticles(4, "aurora-orb");
  if (theme === "windows-xp") appendParticles(6, "xp-cloud");
  atmosphere.append(fragment); document.body.prepend(atmosphere);
}

function installThemeControls() {
  const dock = document.createElement("div"); const mode = document.createElement("button"); const picker = document.createElement("button"); const panel = document.createElement("aside"); const heading = document.createElement("div"); const title = document.createElement("strong"); const copy = document.createElement("small"); const grid = document.createElement("div");
  dock.className = "theme-dock"; dock.dataset.themeDock = ""; mode.type = "button"; mode.className = "theme-mode-toggle"; mode.setAttribute("aria-label", "Toggle light or dark mode"); picker.type = "button"; picker.className = "theme-picker-toggle"; picker.setAttribute("aria-label", "Choose website theme"); picker.setAttribute("aria-expanded", "false"); picker.setAttribute("aria-controls", "duck-theme-panel"); picker.textContent = "✦ Themes"; panel.id = "duck-theme-panel"; panel.className = "theme-panel"; panel.hidden = true; title.textContent = "Choose your pond"; copy.textContent = "Theme changes stay on this device."; heading.append(title, copy); grid.className = "theme-grid";
  const buttons = new Map();
  for (const theme of duckThemes) { const button = document.createElement("button"); const preview = document.createElement("i"); const text = document.createElement("span"); const name = document.createElement("strong"); const description = document.createElement("small"); button.type = "button"; button.className = "theme-option"; button.dataset.themeChoice = theme.id; preview.className = `theme-swatch swatch-${theme.id}`; preview.textContent = theme.icon; name.textContent = theme.name; description.textContent = theme.copy; text.append(name, description); button.append(preview, text); grid.append(button); buttons.set(theme.id, button); }
  panel.append(heading, grid); dock.append(mode, picker, panel); document.body.append(dock);
  const refresh = () => { const theme = currentTheme(); const dark = darkThemes.has(theme); mode.textContent = dark ? "☀️" : "🌙"; mode.title = dark ? "Use light mode" : "Use dark mode"; for (const [id, button] of buttons) { const active = id === theme; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); } };
  const apply = (theme) => { if (!buttons.has(theme)) return; document.documentElement.dataset.theme = theme; saveTheme(theme); buildAtmosphere(theme); refresh(); };
  let closeTimer;
  const close = () => { if (panel.hidden) return; window.clearTimeout(closeTimer); panel.classList.add("is-closing"); picker.setAttribute("aria-expanded", "false"); closeTimer = window.setTimeout(() => { panel.hidden = true; panel.classList.remove("is-closing"); }, reducedMotion ? 0 : 160); };
  mode.addEventListener("click", () => apply(darkThemes.has(currentTheme()) ? "light" : "dark")); picker.addEventListener("click", (event) => { event.stopPropagation(); const opening = panel.hidden || panel.classList.contains("is-closing"); if (opening) { window.clearTimeout(closeTimer); panel.hidden = false; panel.classList.remove("is-closing"); picker.setAttribute("aria-expanded", "true"); } else close(); }); panel.addEventListener("click", (event) => event.stopPropagation()); document.addEventListener("click", close); document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); }); for (const [theme, button] of buttons) button.addEventListener("click", () => { apply(theme); close(); });
  buildAtmosphere(currentTheme()); refresh();
}

installThemeControls();

fetch("/api/site-config")
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Site configuration unavailable")))
  .then(({ banner }) => {
    if (!banner?.message) return;
    const bar = document.createElement("aside"); const message = document.createElement("span"); const close = document.createElement("button");
    bar.className = `website-banner is-${banner.tone || "info"}`; bar.setAttribute("role", "status"); message.textContent = banner.message; close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Dismiss announcement");
    bar.append(message);
    if (banner.linkUrl) { const link = document.createElement("a"); link.href = banner.linkUrl; link.textContent = banner.linkLabel || "Learn more"; link.rel = "noopener noreferrer"; bar.append(link); }
    bar.append(close); close.addEventListener("click", () => bar.remove()); document.body.prepend(bar);
  })
  .catch(() => {});

if (!reducedMotion) {
  requestAnimationFrame(() => document.documentElement.classList.add("motion-ready"));
}

const serverCount = document.querySelector("[data-server-count]");
if (serverCount) {
  const metric = serverCount.closest("[data-server-metric]");
  const separator = document.querySelector("[data-server-separator]");
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
}

const menuButton = document.querySelector(".menu-button");
const mainNavigation = document.querySelector(".main-nav");
if (menuButton && mainNavigation) {
  const closeMenu = () => {
    menuButton.setAttribute("aria-expanded", "false");
    mainNavigation.classList.remove("is-open");
  };
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    menuButton.setAttribute("aria-expanded", String(open));
    mainNavigation.classList.toggle("is-open", open);
  });
  mainNavigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
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

const duckCard = document.querySelector(".duck-card");
if (duckCard && !reducedMotion && window.matchMedia("(pointer: fine)").matches) {
  duckCard.addEventListener("pointermove", (event) => {
    const bounds = duckCard.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    duckCard.style.setProperty("--tilt-x", `${(-y * 5).toFixed(2)}deg`);
    duckCard.style.setProperty("--tilt-y", `${(x * 6).toFixed(2)}deg`);
  });
  duckCard.addEventListener("pointerleave", () => {
    duckCard.style.removeProperty("--tilt-x");
    duckCard.style.removeProperty("--tilt-y");
  });
}

const commandDemo = document.querySelector("[data-command-demo]");
if (commandDemo && !reducedMotion) {
  const examples = [
    ["/quack", "Expertly calibrated."],
    ["/slowmode", "The pond is calmer."],
    ["/duckfact", "Peer-reviewed-ish."],
    ["/lock", "Hatch secured."],
  ];
  let current = 0;
  window.setInterval(() => {
    current = (current + 1) % examples.length;
    commandDemo.classList.add("is-changing");
    window.setTimeout(() => {
      commandDemo.querySelector("code").textContent = examples[current][0];
      commandDemo.querySelector("strong").textContent = examples[current][1];
      commandDemo.classList.remove("is-changing");
    }, 180);
  }, 3200);
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
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(code.textContent.trim());
    button.textContent = "Copied";
    button.classList.add("is-copied");
    window.setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("is-copied");
    }, 1600);
  });
  title.append(button);
}

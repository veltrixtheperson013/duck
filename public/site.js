const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

const revealItems = document.querySelectorAll(".feature-grid article, .trust-strip, .cta, .guide-step, .policy-document section");
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

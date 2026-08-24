(() => {
  const themes = new Set(["classic", "light", "dark", "galaxy", "matrix", "nebula", "black-hole", "gradient", "windows-xp"]);
  try {
    const saved = localStorage.getItem("duck-theme");
    document.documentElement.dataset.theme = themes.has(saved) ? saved : "classic";
  } catch {
    document.documentElement.dataset.theme = "classic";
  }
})();

(() => {
  const themes = new Set(["classic", "dark", "galaxy", "matrix", "nebula", "black-hole", "gradient", "windows-xp"]);
  try {
    const saved = localStorage.getItem("duck-theme");
    const theme = themes.has(saved) ? saved : "classic";
    document.documentElement.dataset.theme = theme;
    if (saved === "light") localStorage.setItem("duck-theme", "classic");
  } catch {
    document.documentElement.dataset.theme = "classic";
  }
})();

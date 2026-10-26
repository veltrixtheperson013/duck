(() => {
  const themes = new Set(["classic", "windows-xp"]);
  try {
    const saved = localStorage.getItem("duck-theme");
    const theme = themes.has(saved) ? saved : "classic";
    document.documentElement.dataset.theme = theme;
    if (saved === "light" || !themes.has(saved)) localStorage.setItem("duck-theme", theme);
  } catch {
    document.documentElement.dataset.theme = "classic";
  }
})();

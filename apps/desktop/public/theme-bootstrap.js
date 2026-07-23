try {
  const theme = localStorage.getItem("mdbase:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // The system preference remains available when local storage is unavailable.
}

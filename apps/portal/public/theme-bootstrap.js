try {
  const theme = localStorage.getItem("mdbase:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1c1e24" : "#fcfcfd");
} catch {
  // The system preference remains available when local storage is unavailable.
}

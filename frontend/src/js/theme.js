/** Applies Twitch theme (onContext → context.theme: "light" | "dark") to <html data-theme>. */
export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
}

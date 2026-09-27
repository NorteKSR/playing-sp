/**
 * Thin wrapper around the Twitch Extension Helper (window.Twitch.ext), loaded from
 * https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js as the first script in every HTML file.
 */
export function getExt() {
  return (typeof window !== 'undefined' && window.Twitch && window.Twitch.ext) || null;
}

/** Tracks the latest JWT (onAuthorized fires again on every refresh). */
export function createAuthStore() {
  let auth = null;
  const waiters = [];
  return {
    set(a) {
      auth = a;
      while (waiters.length) waiters.shift()(a);
    },
    get: () => auth,
    token: () => (auth ? auth.token : null),
    /** Resolves with the next onAuthorized payload (used to retry after token_expired). */
    next: () => new Promise((r) => waiters.push(r)),
  };
}

export function queryParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

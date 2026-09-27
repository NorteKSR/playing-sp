/**
 * Broadcaster views: config.html (Extensions manager) and live_config.html (dashboard Live module).
 * Link flow (API_CONTRACT.md §3): POST /api/config/link/start → open authorizeUrl in a NEW window
 * (the extension iframe cannot navigate top-level and Spotify can't be framed) → poll
 * GET /api/config/status every 2 s for up to 2 min (and on window focus) until linked.
 * No alert()/confirm(): the extension sandbox has no allow-modals, so confirmation is inline.
 */
import { EBS_BASE_URL, ALLOWED_IMAGE_HOSTS, ALLOWED_LINK_HOSTS, REQUEST_TIMEOUT_MS, DEV_BUILD } from './config.js';
import { parseBroadcastMessage, subtitleFor, STATE } from './model.js';
import { createEbsClient } from './api.js';
import { getExt, createAuthStore } from './twitch.js';
import { applyTheme } from './theme.js';
import { h, setText } from './dom.js';
import { spotifyLogo, spotifyLink } from './brand.js';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 120_000;
// v1.2 requiredConfigSet === false while linked: each status call makes the EBS retry, so poll a bit.
const FINISH_POLL_FAST_MS = 3000;
const FINISH_POLL_SLOW_MS = 15_000;
const FINISH_FAST_WINDOW_MS = 120_000;
const PARSE_OPTS = { imageHosts: ALLOWED_IMAGE_HOSTS, linkHosts: ALLOWED_LINK_HOSTS };

export function startConfig(variant) {
  const root = document.getElementById('app');
  root.classList.add('cfg', `cfg--${variant}`);

  // ----- static UI -----
  const pill = h('span', { class: 'cfg-pill', role: 'status' });
  const heading = h('h1', { class: 'cfg-title', text: 'Now Playing' });
  const lead = h('p', { class: 'cfg-lead' });
  const account = h('div', { class: 'cfg-account', hidden: true });
  const nowText = h('span', { class: 'cfg-now-text' });
  const nowLink = spotifyLink('cfg-now-link');
  const nowLine = h('div', { class: 'cfg-now', hidden: true }, [nowText, nowLink]);
  const nowBrand = h('div', { class: 'cfg-brand', hidden: true }, [spotifyLogo()]);
  const errorBox = h('p', { class: 'cfg-error', role: 'alert', hidden: true });
  const linkNoteEl = h('p', { class: 'cfg-note', role: 'status', hidden: true });
  const finishingEl = h('p', { class: 'cfg-finishing', role: 'status', hidden: true }, [h('span', { class: 'cfg-spinner', 'aria-hidden': 'true' }), 'Finishing setup with Twitch…']);
  const connectBtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'Connect Spotify' });
  const cancelBtn = h('button', { class: 'btn', type: 'button', text: 'Cancel', hidden: true });
  const refreshBtn = h('button', { class: 'btn btn-ghost', type: 'button', text: 'Refresh status' });
  const disconnectBtn = h('button', { class: 'btn btn-danger-ghost', type: 'button', text: 'Disconnect', hidden: true });
  const fallbackLink = h('a', { class: 'cfg-fallback', target: '_blank', rel: 'noopener noreferrer', hidden: true }, ['Popup blocked? Open the Spotify authorization page ', h('span', { 'aria-hidden': 'true', text: '↗' })]);
  const confirmYes = h('button', { class: 'btn btn-danger', type: 'button', text: 'Yes, disconnect' });
  const confirmNo = h('button', { class: 'btn', type: 'button', text: 'Keep connected' });
  const confirmRow = h('div', { class: 'cfg-confirm', hidden: true }, [h('span', { text: 'Disconnect Spotify? Viewers will stop seeing your songs.' }), h('div', { class: 'cfg-actions' }, [confirmYes, confirmNo])]);
  const help = h('p', { class: 'cfg-help', text: 'Only the song currently playing on your Spotify account is shown to viewers (title, artists, album art, progress). You can disconnect at any time.' });

  root.append(
    h('header', { class: 'cfg-header' }, [heading, pill]),
    h('div', { class: 'cfg-body' }, [lead, finishingEl, account, nowBrand, nowLine, linkNoteEl, errorBox, h('div', { class: 'cfg-actions' }, [connectBtn, cancelBtn, disconnectBtn, refreshBtn]), fallbackLink, confirmRow]),
    help,
  );

  // ----- state -----
  let state = 'loading'; // loading | unlinked | revoked | linking | linked | error | forbidden
  let status = null;
  let pollTimer = null;
  let pollUntil = 0;
  let busy = false;
  let lastError = null;
  let nowPlaying = null;

  const ext = getExt();
  const auth = createAuthStore();
  const api = createEbsClient({ baseUrl: EBS_BASE_URL, getToken: auth.token, timeoutMs: REQUEST_TIMEOUT_MS, parseOpts: PARSE_OPTS, allowHttpAuthorizeUrl: DEV_BUILD });

  function render() {
    root.dataset.state = state;
    const finishing = isFinishing();
    root.dataset.finishing = finishing ? 'true' : 'false';
    const pillText = finishing ? 'Finishing setup…' : { loading: 'Checking…', unlinked: 'Not connected', revoked: 'Connection lost', linking: 'Waiting for Spotify…', linked: 'Connected', error: 'Error', forbidden: 'No access' }[state];
    setText(pill, pillText);
    pill.dataset.tone = finishing ? 'neutral' : state === 'linked' ? 'ok' : state === 'revoked' || state === 'error' || state === 'forbidden' ? 'bad' : 'neutral';
    finishingEl.hidden = !finishing;

    const leads = {
      loading: 'Checking your Spotify connection…',
      unlinked: 'Connect your Spotify account so viewers can see what song is playing.',
      revoked: 'Spotify access was revoked or expired. Reconnect to keep showing your songs.',
      linking: 'Finish signing in to Spotify in the window that just opened. This page updates automatically.',
      linked: 'Viewers can now see the song you are playing on Spotify.',
      error: "Couldn't reach the extension server. Check your connection and try again.",
      forbidden: 'Only the channel owner can manage the Spotify connection.',
    };
    setText(lead, finishing ? 'Spotify is connected.' : leads[state]);

    const linked = state === 'linked';
    account.hidden = !linked || !status || !status.spotify;
    if (!account.hidden) {
      account.replaceChildren(
        h('span', { class: 'cfg-account-label', text: 'Spotify account' }),
        h('strong', { text: status.spotify.displayName || status.spotify.userId || 'Unknown' }),
      );
    }
    nowLine.hidden = !linked || !nowPlaying;
    const hasItem = !nowLine.hidden && nowPlaying.item;
    nowBrand.hidden = !hasItem; // Spotify metadata shown → attribute with the logo
    if (!nowLine.hidden) {
      setText(nowText, describeNowPlaying(nowPlaying));
      nowText.title = nowText.textContent;
      if (hasItem && nowPlaying.item.url) {
        nowLink.href = nowPlaying.item.url;
        nowLink.hidden = false;
      } else {
        nowLink.hidden = true;
      }
    }

    setText(connectBtn, state === 'revoked' ? 'Reconnect Spotify' : state === 'linking' ? 'Open Spotify again' : 'Connect Spotify');
    connectBtn.hidden = !(state === 'unlinked' || state === 'revoked' || state === 'linking' || (state === 'error' && !status));
    connectBtn.disabled = busy;
    cancelBtn.hidden = state !== 'linking';
    disconnectBtn.hidden = !linked || !confirmRow.hidden;
    disconnectBtn.disabled = busy;
    refreshBtn.hidden = state === 'loading' || state === 'forbidden';
    refreshBtn.disabled = busy;
    if (state !== 'linking') fallbackLink.hidden = true;
    if (!linked) confirmRow.hidden = true;
    const note = linked && status ? linkNote(status.lastError) : null;
    linkNoteEl.hidden = !note;
    if (note) setText(linkNoteEl, note);
    errorBox.hidden = !lastError;
    if (lastError) setText(errorBox, lastError);
    updateFinishPolling();
  }

  // API_CONTRACT §3 lastError values (shown while linked; "revoked" comes with linked:false).
  function linkNote(code) {
    if (!code) return null;
    if (code === 'spotify_forbidden') return 'Spotify refused access for this account. Ask the extension developer to add your Spotify account to the app.';
    if (code === 'rate_limited' || code === 'quota_exceeded') return 'Spotify is temporarily limiting requests. Updates resume automatically.';
    return 'Temporary problem talking to Spotify. Retrying automatically.';
  }

  function describeNowPlaying(np) {
    if (np.state === STATE.PLAYING || np.state === STATE.PAUSED) {
      const sub = subtitleFor(np.item);
      return `${np.state === STATE.PAUSED ? 'Paused' : 'Now playing'}: ${np.item.name}${sub ? ' — ' + sub : ''}`;
    }
    if (np.state === STATE.AD) return 'Spotify is playing an ad.';
    return 'Nothing is playing on Spotify right now.';
  }

  /** linked but Twitch required configuration not set yet (missing/null requiredConfigSet counts as done). */
  function isFinishing() {
    return state === 'linked' && !!status && status.linked && status.requiredConfigSet === false;
  }

  let finishTimer = null;
  let finishSince = 0;
  function updateFinishPolling() {
    if (!isFinishing()) {
      clearTimeout(finishTimer);
      finishTimer = null;
      finishSince = 0;
      return;
    }
    if (finishTimer) return;
    if (!finishSince) finishSince = Date.now();
    const wait = Date.now() - finishSince < FINISH_FAST_WINDOW_MS ? FINISH_POLL_FAST_MS : FINISH_POLL_SLOW_MS;
    finishTimer = setTimeout(async () => {
      finishTimer = null;
      await refreshStatus({ quiet: true });
    }, wait);
  }

  function applyStatus(s) {
    status = s;
    if (s.linked) {
      const wasLinked = state === 'linked';
      state = 'linked';
      stopPolling();
      if (!wasLinked) refreshNowPlaying();
    } else if (state === 'linking' && Date.now() < pollUntil) {
      // keep waiting
    } else {
      state = s.lastError === 'revoked' ? 'revoked' : 'unlinked';
    }
  }

  function friendly(err) {
    if (!err) return null;
    if (err.status === 403) return null;
    if (err.status === 429) return 'Too many requests — please wait a moment.';
    if (err.status === 0) return 'Could not reach the extension server.';
    return err.message || 'Something went wrong.';
  }

  async function withToken(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.isAuth && err.code === 'token_expired') {
        await auth.next();
        return fn();
      }
      throw err;
    }
  }

  async function refreshStatus({ quiet = false } = {}) {
    try {
      const s = await withToken(() => api.getLinkStatus());
      lastError = null;
      applyStatus(s);
    } catch (err) {
      if (err.status === 403) state = 'forbidden';
      else if (!quiet) {
        lastError = friendly(err);
        if (!status) state = 'error';
      }
    }
    render();
  }

  async function refreshNowPlaying() {
    try {
      nowPlaying = await withToken(() => api.getNowPlaying());
    } catch {
      nowPlaying = null;
    }
    render();
  }

  function startPolling() {
    stopPolling();
    pollUntil = Date.now() + POLL_MAX_MS;
    const tick = async () => {
      await refreshStatus({ quiet: true });
      if (state === 'linked') return;
      if (Date.now() >= pollUntil) {
        state = status && status.lastError === 'revoked' ? 'revoked' : 'unlinked';
        lastError = 'Timed out waiting for Spotify. Try connecting again.';
        render();
        return;
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function connect() {
    if (busy) return;
    busy = true;
    lastError = null;
    // Open the window synchronously in the click handler so popup blockers allow it,
    // then point it at the authorize URL once the EBS returns it.
    let popup = null;
    try {
      popup = window.open('', 'spotify-link', 'popup=yes,width=520,height=760');
    } catch {
      popup = null;
    }
    if (popup) {
      try {
        popup.document.title = 'Connecting to Spotify…';
        popup.document.body.textContent = 'Connecting to Spotify…';
      } catch {
        /* cross-origin window reused: ignore */
      }
    }
    render();
    try {
      const { authorizeUrl } = await withToken(() => api.startLink());
      fallbackLink.href = authorizeUrl;
      fallbackLink.hidden = false;
      if (popup && !popup.closed) {
        try {
          popup.opener = null;
        } catch {
          /* ignore */
        }
        popup.location.href = authorizeUrl;
      }
      state = 'linking';
      startPolling();
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      lastError = err.status === 403 ? 'Only the channel owner can connect Spotify.' : friendly(err) || 'Could not start the Spotify connection.';
    } finally {
      busy = false;
      render();
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    confirmRow.hidden = true;
    render();
    try {
      await withToken(() => api.unlink());
      status = { linked: false, spotify: null, lastError: null };
      nowPlaying = null;
      state = 'unlinked';
      lastError = null;
    } catch (err) {
      lastError = friendly(err) || 'Could not disconnect.';
    } finally {
      busy = false;
      render();
    }
  }

  connectBtn.addEventListener('click', connect);
  cancelBtn.addEventListener('click', () => {
    stopPolling();
    state = status && status.lastError === 'revoked' ? 'revoked' : 'unlinked';
    render();
  });
  refreshBtn.addEventListener('click', () => refreshStatus());
  disconnectBtn.addEventListener('click', () => {
    confirmRow.hidden = false;
    render();
    confirmNo.focus();
  });
  confirmNo.addEventListener('click', () => {
    confirmRow.hidden = true;
    render();
  });
  confirmYes.addEventListener('click', disconnect);
  window.addEventListener('focus', () => {
    if (state === 'linking') refreshStatus({ quiet: true });
  });

  render();
  if (!ext) {
    state = 'error';
    lastError = 'The Twitch extension helper failed to load. Please refresh.';
    render();
    return;
  }
  ext.onContext((ctx) => ctx && applyTheme(ctx.theme));
  let started = false;
  ext.onAuthorized((a) => {
    if (!a || !a.token) return;
    auth.set(a);
    if (!started) {
      started = true;
      refreshStatus();
      ext.listen('broadcast', (t, ct, msg) => {
        const p = parseBroadcastMessage(ct, msg, PARSE_OPTS);
        if (!p.ok) return;
        if (p.value.state === STATE.NOT_LINKED) {
          if (state === 'linked') refreshStatus({ quiet: true });
          return;
        }
        nowPlaying = p.value;
        if (state !== 'linked') refreshStatus({ quiet: true });
        render();
      });
    }
  });
}

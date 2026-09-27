/**
 * Viewer views: panel, video overlay, video component.
 * Flow: onAuthorized → GET /api/now-playing → listen('broadcast') for live updates (API_CONTRACT.md §3, §5).
 */
import {
  EBS_BASE_URL, ALLOWED_IMAGE_HOSTS, ALLOWED_LINK_HOSTS,
  SYNC_TO_STREAM_DELAY, MAX_STREAM_DELAY_MS, MAX_SAMPLE_AGE_MS, REQUEST_TIMEOUT_MS,
  KEEPALIVE_MS, KEEPALIVE_JITTER_MS,
} from './config.js';
import { STATE, parseBroadcastMessage, isNewer, subtitleFor } from './model.js';
import { makeAnchor, positionAt, fraction, overrunMs, formatTime } from './progress.js';
import { createEbsClient } from './api.js';
import { getExt, createAuthStore, queryParam } from './twitch.js';
import { applyTheme } from './theme.js';
import { initBits } from './bits.js';
import { h, setText } from './dom.js';
import { spotifyLogo, spotifyLink } from './brand.js';

const PARSE_OPTS = { imageHosts: ALLOWED_IMAGE_HOSTS, linkHosts: ALLOWED_LINK_HOSTS };

const MESSAGES = {
  loading: ['Loading…', ''],
  [STATE.NOTHING_PLAYING]: ['Nothing playing right now', 'Music will show up here when it starts.'],
  [STATE.AD]: ['Short break', 'Music will be right back.'],
  [STATE.NOT_LINKED]: ['Not connected yet', "The streamer hasn't connected Spotify yet."],
  [STATE.UNKNOWN]: ['Nothing to show', 'Music will show up here when it starts.'],
  error: ["Couldn't load the current song", 'Retrying automatically…'],
  no_helper: ['Extension failed to load', 'Please refresh the page.'],
};

function buildUi(root, variant) {
  const art = h('img', { class: 'np-art', alt: '', hidden: true, decoding: 'async', referrerpolicy: 'no-referrer' });
  const artFallback = h('div', { class: 'np-art-fallback', 'aria-hidden': 'true' }, [h('span', { class: 'np-note' })]);
  const eyebrow = h('div', { class: 'np-eyebrow' }, [h('span', { class: 'np-eq', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]), h('span', { class: 'np-eyebrow-text', text: 'Now playing' })]);
  const title = h('div', { class: 'np-title', id: 'np-title' });
  const explicit = h('span', { class: 'np-explicit', title: 'Explicit', text: 'E', hidden: true });
  const subtitle = h('div', { class: 'np-subtitle', id: 'np-subtitle' });
  const bar = h('div', { class: 'np-bar-fill' });
  const barTrack = h('div', { class: 'np-bar', role: 'progressbar', 'aria-label': 'Song progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [bar]);
  const elapsed = h('span', { class: 'np-elapsed', text: '0:00' });
  const duration = h('span', { class: 'np-duration', text: '0:00' });
  const link = spotifyLink('np-link');
  const msgTitle = h('div', { class: 'np-msg-title' });
  const msgDetail = h('div', { class: 'np-msg-detail' });
  const bitsSlot = h('section', { id: 'bits-slot', class: 'np-bits-slot', hidden: true, 'aria-label': 'Extras' });

  const card = h('div', { class: 'np-card' }, [
    h('div', { class: 'np-art-wrap' }, [artFallback, art]),
    h('div', { class: 'np-body' }, [
      eyebrow,
      h('div', { class: 'np-title-row' }, [title, explicit]),
      subtitle,
      h('div', { class: 'np-progress' }, [barTrack, h('div', { class: 'np-times' }, [elapsed, duration])]),
    ]),
  ]);
  const message = h('div', { class: 'np-message', role: 'status' }, [h('div', { class: 'np-msg-icon', 'aria-hidden': 'true' }), msgTitle, msgDetail]);
  const footer = h('footer', { class: 'np-footer' }, [spotifyLogo(), link]);

  root.classList.add('np', `np--${variant}`);
  root.append(card, message, footer, bitsSlot);

  art.addEventListener('error', () => { art.hidden = true; artFallback.hidden = false; });
  art.addEventListener('load', () => { art.hidden = false; artFallback.hidden = true; });

  return { root, card, art, artFallback, eyebrowText: eyebrow.lastChild, title, explicit, subtitle, bar, barTrack, elapsed, duration, link, msgTitle, msgDetail, bitsSlot };
}

export function startViewer(variant) {
  const root = document.getElementById('app');
  const ui = buildUi(root, variant);
  const ext = getExt();

  let uiState = 'loading';
  let current = null; // normalised NowPlaying
  let anchor = null;
  let latencyMs = 0;
  let mode = queryParam('mode') || 'viewer';
  let listening = false;
  let bitsStarted = false;
  let retryTimer = null;
  let retryAttempt = 0;
  let fetchSeq = 0;
  let tickTimer = null;
  let twitchVisible = true; // Twitch.ext.onVisibilityChanged
  let docVisible = typeof document.hidden === 'boolean' ? !document.hidden : true; // Page Visibility API
  let visible = twitchVisible && docVisible;
  let keepAliveTimer = null;
  let overrunRefetchFor = null;
  let highlighted = false;
  const pendingLive = new Set();

  const auth = createAuthStore();
  const api = createEbsClient({ baseUrl: EBS_BASE_URL, getToken: auth.token, parseOpts: PARSE_OPTS, timeoutMs: REQUEST_TIMEOUT_MS });

  function streamDelayMs() {
    if (!SYNC_TO_STREAM_DELAY || mode !== 'viewer') return 0;
    return Math.min(Math.max(latencyMs, 0), MAX_STREAM_DELAY_MS);
  }

  // ---------- rendering ----------
  function render() {
    root.dataset.state = uiState;
    root.classList.toggle('is-highlighted', highlighted);
    const hasItem = (uiState === STATE.PLAYING || uiState === STATE.PAUSED) && current && current.item;
    if (hasItem) {
      const it = current.item;
      setText(ui.eyebrowText, uiState === STATE.PAUSED ? 'Paused' : it.kind === 'episode' ? 'Now playing · Podcast' : 'Now playing');
      setText(ui.title, it.name);
      ui.title.title = it.name;
      const sub = subtitleFor(it);
      setText(ui.subtitle, sub);
      ui.subtitle.title = it.album && it.kind === 'track' ? `${sub} — ${it.album}` : sub;
      ui.explicit.hidden = !it.explicit;
      if (it.imageUrl) {
        if (ui.art.getAttribute('src') !== it.imageUrl) {
          ui.art.hidden = true;
          ui.artFallback.hidden = false;
          ui.art.src = it.imageUrl;
        }
        ui.art.alt = it.album ? `Cover art: ${it.album}` : it.show ? `Cover art: ${it.show}` : 'Cover art';
      } else {
        ui.art.removeAttribute('src');
        ui.art.hidden = true;
        ui.artFallback.hidden = false;
      }
      if (it.url) {
        ui.link.href = it.url;
        ui.link.hidden = false;
      } else {
        ui.link.removeAttribute('href');
        ui.link.hidden = true;
      }
      setText(ui.duration, it.durationMs != null ? formatTime(it.durationMs) : '');
      renderProgress();
    } else {
      ui.link.hidden = true;
      const [t, d] = MESSAGES[uiState] || MESSAGES[STATE.UNKNOWN];
      setText(ui.msgTitle, t);
      setText(ui.msgDetail, d);
    }
    updateTicker();
  }

  function renderProgress() {
    if (!anchor) return;
    const now = Date.now();
    const f = fraction(anchor, now);
    ui.bar.style.transform = `scaleX(${f.toFixed(4)})`;
    ui.barTrack.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    setText(ui.elapsed, formatTime(positionAt(anchor, now)));
    // Track should have ended but no update arrived (missed PubSub): refetch once, with jitter.
    if (overrunMs(anchor, now) > 8000 && overrunRefetchFor !== anchor) {
      overrunRefetchFor = anchor;
      setTimeout(() => fetchNowPlaying('overrun'), Math.random() * 5000);
    }
  }

  function updateTicker() {
    const shouldTick = visible && uiState === STATE.PLAYING && anchor && anchor.isPlaying;
    if (shouldTick && !tickTimer) tickTimer = setInterval(renderProgress, 500);
    if (!shouldTick && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  // ---------- state updates ----------
  // receivedAt = local Date.now() when the HTTP response / PubSub message arrived (API_CONTRACT v1.2 §4).
  // The stream delay is always subtracted: even when an update is applied late (to line up with the stream),
  // the viewer hears the broadcaster's audio latency-ms behind the EBS position.
  function applyNowPlaying(np, { receivedAt }) {
    if (!isNewer(np, current)) return false;
    current = np;
    anchor = np.item ? makeAnchor(np, { now: Date.now(), receivedAt, maxSampleAgeMs: MAX_SAMPLE_AGE_MS, delayMs: streamDelayMs() }) : null;
    uiState = np.state;
    render();
    return true;
  }

  function scheduleRetry(err) {
    clearTimeout(retryTimer);
    retryAttempt += 1;
    const base = err && err.retryAfterSec ? err.retryAfterSec * 1000 : Math.min(5000 * 2 ** (retryAttempt - 1), 60_000);
    retryTimer = setTimeout(() => fetchNowPlaying('retry'), base + Math.random() * 2000);
  }

  // Keep-alive: refetch every ~5 min while visible; paused while hidden (API_CONTRACT v1.1).
  function scheduleKeepAlive() {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
    if (!visible || !auth.get()) return;
    keepAliveTimer = setTimeout(() => fetchNowPlaying('keepalive'), KEEPALIVE_MS + Math.random() * KEEPALIVE_JITTER_MS);
  }

  function setVisibility(nextTwitch, nextDoc) {
    const was = visible;
    twitchVisible = nextTwitch;
    docVisible = nextDoc;
    visible = twitchVisible && docVisible;
    if (visible && !was) {
      if (auth.get()) fetchNowPlaying('visible'); // also re-arms keep-alive
      else renderProgress();
    } else if (!visible && was) {
      clearTimeout(keepAliveTimer);
      keepAliveTimer = null;
    }
    updateTicker();
  }

  async function fetchNowPlaying(reason) {
    clearTimeout(retryTimer);
    scheduleKeepAlive();
    const seq = ++fetchSeq;
    try {
      const np = await api.getNowPlaying();
      const receivedAt = Date.now();
      if (seq !== fetchSeq) return;
      retryAttempt = 0;
      // If the fetch reveals a change we haven't shown yet, respect the viewer's stream delay like PubSub does.
      const delay = streamDelayMs();
      const changed = current && (np.state !== current.state || (np.item && np.item.id) !== (current.item && current.item.id));
      if (delay > 0 && changed && uiState !== 'loading' && uiState !== 'error') {
        const t = setTimeout(() => {
          pendingLive.delete(t);
          applyNowPlaying(np, { receivedAt });
        }, delay);
        pendingLive.add(t);
      } else {
        applyNowPlaying(np, { receivedAt });
      }
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.warn('[now-playing] fetch failed', reason, err && err.code);
      if (err && err.isAuth && err.code === 'token_expired') {
        return; // the next onAuthorized (JWT refresh) triggers a fetch automatically
      }
      if (!current) {
        uiState = 'error';
        render();
      }
      scheduleRetry(err);
    }
  }

  function onBroadcast(target, contentType, message) {
    const receivedAt = Date.now();
    const parsed = parseBroadcastMessage(contentType, message, PARSE_OPTS);
    if (!parsed.ok) {
      console.warn('[now-playing] ignored PubSub message:', parsed.error);
      return;
    }
    const np = parsed.value;
    if (auth.get() && np.channelId && np.channelId !== auth.get().channelId) return;
    // Fresh data arrived: stop error retries.
    clearTimeout(retryTimer);
    retryAttempt = 0;
    const delay = uiState === 'loading' || uiState === 'error' ? 0 : streamDelayMs();
    if (delay > 0) {
      const t = setTimeout(() => {
        pendingLive.delete(t);
        applyNowPlaying(np, { receivedAt });
      }, delay);
      pendingLive.add(t);
    } else {
      applyNowPlaying(np, { receivedAt });
    }
  }

  // ---------- boot ----------
  render();
  if (!ext) {
    uiState = 'no_helper';
    render();
    return;
  }

  ext.onContext((ctx, changed) => {
    if (!ctx) return;
    if (!changed || changed.includes('theme')) applyTheme(ctx.theme);
    if (typeof ctx.hlsLatencyBroadcaster === 'number') latencyMs = ctx.hlsLatencyBroadcaster * 1000;
    if (ctx.mode) mode = ctx.mode;
    if (typeof ctx.arePlayerControlsVisible === 'boolean') root.classList.toggle('controls-visible', ctx.arePlayerControlsVisible);
  });

  ext.onAuthorized((a) => {
    if (!a || !a.token) return;
    const prev = auth.get();
    auth.set(a);
    if (prev && prev.channelId !== a.channelId) current = null;
    // Contract §3/§5: fetch on EVERY onAuthorized (initial load and each JWT refresh).
    fetchNowPlaying(prev ? 'reauthorized' : 'authorized');
    if (!listening) {
      ext.listen('broadcast', onBroadcast);
      listening = true;
    }
    if (!bitsStarted && variant === 'panel') {
      bitsStarted = true;
      initBits({ slot: ui.bitsSlot, ext, auth: a, getNowPlaying: () => current });
    }
  });

  if (typeof ext.onVisibilityChanged === 'function') {
    ext.onVisibilityChanged((isVisible) => setVisibility(!!isVisible, docVisible));
  }
  document.addEventListener('visibilitychange', () => setVisibility(twitchVisible, !document.hidden));
  if (typeof ext.onHighlightChanged === 'function') {
    ext.onHighlightChanged((isHighlighted) => {
      highlighted = !!isHighlighted;
      render();
    });
  }
  if (typeof ext.onError === 'function') ext.onError((e) => console.warn('[now-playing] helper error', e));
}

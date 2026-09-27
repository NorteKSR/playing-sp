/*
 * DEV ONLY — mock of window.Twitch.ext (https://dev.twitch.tv/docs/extensions/reference/).
 * The dev server swaps the real helper <script> for this file; it is never packaged.
 * Query params: role=viewer|broadcaster, channel=123456, theme=dark|light, latency=<sec>,
 *               mode=viewer|dashboard|config, autoauth=0 (wait for __mockTwitch.authorize()).
 * Control API for the harness (same-origin parent): window.__mockTwitch.{broadcast, setContext,
 *   setHighlighted, setVisible, authorize}.
 */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var role = qs.get('role') || (/config/.test(location.pathname) ? 'broadcaster' : 'viewer');
  var channel = qs.get('channel') || '123456';
  var cbs = { auth: [], ctx: [], vis: [], hl: [], err: [], listen: {} };
  var lastAuth = null;
  var context = {
    theme: qs.get('theme') || 'dark',
    mode: qs.get('mode') || (/config/.test(location.pathname) ? (location.pathname.indexOf('live_config') >= 0 ? 'dashboard' : 'config') : 'viewer'),
    hlsLatencyBroadcaster: Number(qs.get('latency') || 0),
    arePlayerControlsVisible: false, isFullScreen: false, isTheatreMode: false, isMuted: false, isPaused: false,
    language: 'en', game: 'Just Chatting', playbackMode: 'video', volume: 0.5,
    displayResolution: '1280x720', videoResolution: '1920x1080', bitrate: 6000, bufferSize: 2,
  };
  var later = function (fn) { setTimeout(fn, 0); };

  function authorize() {
    return fetch('/__dev/token?role=' + encodeURIComponent(role) + '&channel=' + encodeURIComponent(channel) + (qs.get('ttl') ? '&ttl=' + qs.get('ttl') : ''))
      .then(function (r) { return r.json(); })
      .then(function (t) {
        lastAuth = { channelId: t.channelId, clientId: t.clientId, token: t.token, helixToken: 'mock-helix-token', userId: t.userId };
        ext.viewer.opaqueId = t.userId; ext.viewer.role = role; ext.viewer.sessionToken = t.token;
        cbs.auth.forEach(function (cb) { cb(lastAuth); });
        return lastAuth;
      });
  }

  var ext = {
    version: '1.0.0-mock', environment: 'production',
    onAuthorized: function (cb) { cbs.auth.push(cb); if (lastAuth) later(function () { cb(lastAuth); }); },
    onContext: function (cb) { cbs.ctx.push(cb); later(function () { cb(Object.assign({}, context), Object.keys(context)); }); },
    onError: function (cb) { cbs.err.push(cb); },
    onVisibilityChanged: function (cb) { cbs.vis.push(cb); },
    onHighlightChanged: function (cb) { cbs.hl.push(cb); },
    onPositionChanged: function () {},
    listen: function (target, cb) { (cbs.listen[target] = cbs.listen[target] || []).push(cb); },
    unlisten: function (target, cb) { cbs.listen[target] = (cbs.listen[target] || []).filter(function (f) { return f !== cb; }); },
    send: function (target, contentType, message) { console.log('[mock ext] send', target, contentType, message); },
    rig: { log: function () { console.log.apply(console, arguments); } },
    actions: { followChannel: function () {}, minimize: function () {}, onFollow: function () {}, requestIdShare: function () {} },
    configuration: { broadcaster: undefined, developer: undefined, global: undefined, onChanged: function (cb) { later(cb); }, set: function () {} },
    features: { isBitsEnabled: false, isChatEnabled: false, isSubscriptionStatusAvailable: false, onChanged: function () {} },
    bits: {
      getProducts: function () { return Promise.reject(new Error('Bits not available in mock')); },
      onTransactionComplete: function () {}, onTransactionCancelled: function () {},
      setUseLoopback: function () {}, showBitsBalance: function () {}, useBits: function () {},
    },
    viewer: { opaqueId: null, id: null, role: role, isLinked: false, sessionToken: null, helixToken: null, subscriptionStatus: null, onChanged: function () {} },
  };
  window.Twitch = { ext: ext };

  window.__mockTwitch = {
    authorize: authorize,
    broadcast: function (message, target) {
      var msg = typeof message === 'string' ? message : JSON.stringify(message);
      (cbs.listen[target || 'broadcast'] || []).forEach(function (cb) { cb(target || 'broadcast', 'application/json', msg); });
    },
    setContext: function (partial) {
      Object.assign(context, partial);
      var changed = Object.keys(partial);
      cbs.ctx.forEach(function (cb) { cb(Object.assign({}, context), changed); });
    },
    setHighlighted: function (v) { cbs.hl.forEach(function (cb) { cb(!!v); }); },
    setVisible: function (v) { cbs.vis.forEach(function (cb) { cb(!!v, v ? Object.assign({}, context) : undefined); }); },
    get context() { return Object.assign({}, context); },
  };

  if (qs.get('autoauth') !== '0') setTimeout(authorize, Number(qs.get('authDelay') || 150));
})();

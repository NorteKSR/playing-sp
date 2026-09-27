// Mock NowPlaying fixtures shaped exactly like API_CONTRACT.md §4 (dev only).
const IMG = (h) => `https://i.scdn.co/image/${h}`;
export const TRACKS = {
  trackA: {
    kind: 'track', id: '1AbCdEfGhIjKlMnOpQrStU', name: 'Sunrise Parade', artists: ['The Sample Band'],
    album: 'Demo Sessions', show: null, imageUrl: IMG('feedface00000000000000000000000000000a01'),
    durationMs: 213573, url: 'https://open.spotify.com/track/1AbCdEfGhIjKlMnOpQrStU', explicit: false,
  },
  trackB: {
    kind: 'track', id: '2BcDeFgHiJkLmNoPqRsTuV', name: 'Midnight Placeholder (Extended Mix With A Very Long Title For Testing)', artists: ['Demo Artist', 'Another Featured Artist', 'Third Artist'],
    album: 'Test Pattern', show: null, imageUrl: IMG('feedface00000000000000000000000000000b02'),
    durationMs: 200040, url: 'https://open.spotify.com/track/2BcDeFgHiJkLmNoPqRsTuV', explicit: true,
  },
  trackC: {
    kind: 'track', id: '3CdEfGhIjKlMnOpQrStUvW', name: 'Paper Harbor', artists: ['The Sample Rate'],
    album: 'Loopback', show: null, imageUrl: IMG('feedface00000000000000000000000000000c03'),
    durationMs: 222973, url: 'https://open.spotify.com/track/3CdEfGhIjKlMnOpQrStUvW', explicit: false,
  },
  episode: {
    kind: 'episode', id: '4DeFgHiJkLmNoPqRsTuVwX', name: 'Episode 42: Building Twitch Extensions', artists: [],
    album: null, show: 'The Dev Podcast', imageUrl: null, durationMs: 3600000,
    url: 'https://open.spotify.com/episode/4DeFgHiJkLmNoPqRsTuVwX', explicit: false,
  },
};

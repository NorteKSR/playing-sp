/**
 * Spotify attribution (Spotify Design & Branding Guidelines, https://developer.spotify.com/documentation/design).
 * Official, unmodified full-logo SVGs from https://developer.spotify.com/images/guidelines/design/2024-spotify-full-logo.zip
 * are bundled in img/spotify/. Variant is chosen purely by CSS per background:
 *   - green logo: only on pure white (light theme) — "green logo should only be used on a black or white background"
 *   - white logo: dark theme (#191414) and the video overlay card — "white logo on dark colored backgrounds"
 * Size/clear space are enforced in CSS (.sp-logo): width >= 70px, exclusion zone = half the icon height.
 */
import { h } from './dom.js';

export const SPOTIFY_LOGO = {
  white: 'img/spotify/Full_Logo_White_RGB.svg',
  green: 'img/spotify/Full_Logo_Green_RGB.svg',
};

/** Text for the link back to Spotify (guidelines: OPEN SPOTIFY / PLAY ON SPOTIFY / LISTEN ON SPOTIFY). */
export const LINK_TEXT = 'LISTEN ON SPOTIFY';

export function spotifyLogo() {
  return h('span', { class: 'sp-logo' }, [
    h('img', { class: 'sp-logo-img sp-logo--white', src: SPOTIFY_LOGO.white, alt: 'Spotify', width: '84', height: '23', draggable: 'false' }),
    h('img', { class: 'sp-logo-img sp-logo--green', src: SPOTIFY_LOGO.green, alt: 'Spotify', width: '84', height: '23', draggable: 'false' }),
  ]);
}

/** Off-site link back to the Spotify item; visible "↗" indicator for Twitch guideline 4.6.2. */
export function spotifyLink(className) {
  return h('a', { class: className, target: '_blank', rel: 'noopener noreferrer', hidden: true }, [LINK_TEXT + ' ', h('span', { 'aria-hidden': 'true', text: '↗' })]);
}

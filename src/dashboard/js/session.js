/**
 * Where the officer token lives in the browser: sessionStorage (this tab only). A #token= fragment is read once and
 * removed from the address bar and the history entry; the token is never put in a URL by the dashboard.
 */
import { tokenFromFragment } from './state/route.js';

const TOKEN_KEY = 'mirsad.officerSession.v2';

// Before password sign-in, the tab could hold a long-lived demo credential. Upgrading requires a fresh sign-in.
try { window.sessionStorage.removeItem('mirsad.officerToken'); } catch { /* Storage may be disabled. */ }

/** The stored token, or null; storage can be unavailable (a privacy mode), which behaves like an empty store. */
export function readStoredToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Returns false when the token could not be stored; the session then lasts until this page is closed or reloaded. */
export function storeToken(token) {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: nothing was stored, so there is nothing to clear.
  }
}

export function takeTokenFromFragment() {
  const token = tokenFromFragment(window.location.hash);
  if (token === null) return null;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

/**
 * Entry point: sign-in with a pasted officer token, or a #token= fragment that is read once and removed, then the
 * dashboard. GET /v1/me says who is signed in. The token lives in sessionStorage for this tab and travels only in the
 * Authorization header.
 */
import { ApiError, createApi } from './api.js';
import { startDashboard } from './app.js';
import { describeError } from './format.js';
import { clearToken, readStoredToken, storeToken, takeTokenFromFragment } from './session.js';

const UNAUTHORIZED = 401;
const SESSION_ENDED = 'Your session has ended. Sign in again.';
const ELEMENT_IDS = {
  signin: 'signin', signinForm: 'signin-form', tokenInput: 'token-input', signinMessage: 'signin-message',
  workspace: 'workspace', viewNav: 'view-nav', navInbox: 'nav-inbox', navWatchlist: 'nav-watchlist',
  session: 'session', officerName: 'officer-name', connection: 'connection-status', signOut: 'sign-out',
  notice: 'notice', inboxView: 'inbox-view', inbox: 'inbox', dispatchButton: 'dispatch-button',
  selectionCount: 'selection-count', newInboundList: 'new-inbound-list', openList: 'open-list',
  chatHeader: 'chat-header', timeline: 'timeline', composer: 'composer', composerText: 'composer-text',
  insertAcknowledgement: 'insert-acknowledgement', sendButton: 'send-button', leaveUnansweredButton: 'leave-unanswered-button',
  replyTarget: 'reply-target', matches: 'matches', caseLog: 'case-log', watchlistView: 'watchlist-view',
  watchlist: 'watchlist', captureDialog: 'capture-dialog', captureDialogImage: 'capture-dialog-image',
};

function collectRefs() {
  const entries = Object.entries(ELEMENT_IDS).map(([name, id]) => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`The dashboard page is missing #${id}.`);
    return [name, element];
  });
  return Object.fromEntries(entries);
}

const refs = collectRefs();
let dashboard = null;

function showSignedIn(signedIn) {
  refs.signin.hidden = signedIn;
  refs.workspace.hidden = !signedIn;
  refs.viewNav.hidden = !signedIn;
  refs.session.hidden = !signedIn;
}

/** Shows the sign-in form with a message; `problem` marks it as an error rather than information. */
function showSignIn(message, problem = true) {
  if (dashboard !== null) dashboard.stop();
  dashboard = null;
  clearToken();
  showSignedIn(false);
  refs.signinMessage.textContent = message;
  refs.signinMessage.className = problem ? 'error' : 'hint';
  refs.tokenInput.value = '';
  refs.tokenInput.focus();
}

async function signIn(token) {
  const api = createApi(token, {
    onUnauthenticated: () => {
      if (dashboard !== null) showSignIn(SESSION_ENDED);
    },
  });
  let me;
  try {
    me = await api.me();
  } catch (error) {
    showSignIn(error instanceof ApiError && error.status === UNAUTHORIZED ? 'That token was not accepted.' : `Sign-in failed: ${describeError(error)}`);
    return;
  }
  if (me.kind !== 'officer') {
    showSignIn('That token is not an officer token.');
    return;
  }
  // When storage is unavailable the session lasts until this page is closed or reloaded.
  storeToken(token);
  refs.signinMessage.textContent = '';
  refs.officerName.textContent = me.displayName;
  showSignedIn(true);
  dashboard = startDashboard({ api, me, token, refs, onSessionEnded: () => showSignIn(SESSION_ENDED) });
}

refs.signinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = refs.tokenInput.value.trim();
  refs.tokenInput.value = '';
  if (token !== '') void signIn(token);
});
refs.signOut.addEventListener('click', () => showSignIn('You are signed out.', false));

/**
 * A #token= link pasted into this open tab: the token leaves the address bar and history at once, and the tab signs in
 * with it in place of the current session. Registered before any dashboard starts, so it runs before the dashboard's
 * own route listener, which stopping the dashboard removes.
 */
window.addEventListener('hashchange', () => {
  const token = takeTokenFromFragment();
  if (token === null) return;
  if (dashboard !== null) dashboard.stop();
  dashboard = null;
  void signIn(token);
});

const initialToken = takeTokenFromFragment() ?? readStoredToken();
if (initialToken === null) showSignIn('', false);
else void signIn(initialToken);

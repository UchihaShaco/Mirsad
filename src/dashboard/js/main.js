/**
 * Officers sign in with a username and password. Only the session bearer is kept in this tab. Existing provisioned
 * token links are still read once and removed from the address bar.
 */
import { ApiError, createApi, loginOfficer, logoutOfficer } from './api.js';
import { startDashboard } from './app.js';
import { describeError } from './format.js';
import { clearToken, readStoredToken, storeToken, takeTokenFromFragment } from './session.js';

const UNAUTHORIZED = 401;
const SESSION_ENDED = 'Your session has ended. Sign in again.';
const ELEMENT_IDS = {
  signin: 'signin', signinForm: 'signin-form', username: 'username-input', password: 'password-input',
  signinSubmit: 'signin-submit', signinMessage: 'signin-message',
  signinHeading: 'signin-heading', changeForm: 'password-change-form', changeSubmit: 'password-change-submit',
  newPassword: 'new-password-input', confirmPassword: 'confirm-password-input', cancelChange: 'cancel-password-change',
  workspace: 'workspace', viewNav: 'view-nav', navInbox: 'nav-inbox', navWatchlist: 'nav-watchlist', navPlaces: 'nav-places',
  session: 'session', officerName: 'officer-name', connection: 'connection-status', signOut: 'sign-out',
  notice: 'notice', inboxView: 'inbox-view', inbox: 'inbox', dispatchButton: 'dispatch-button',
  inboxFilterAll: 'inbox-filter-all', inboxFilterNew: 'inbox-filter-new', inboxFilterSuspects: 'inbox-filter-suspects', suspectQueue: 'suspect-queue', suspectList: 'suspect-list', inboxFilterReview: 'inbox-filter-review', selectAllChats: 'select-all-chats', queueScope: 'queue-scope',
  inboxFilterLowerConcern: 'inbox-filter-lower-concern', previousTestQueue: 'previous-test-queue', previousTestList: 'previous-test-list',
  archiveNotice: 'archive-notice', currentConversation: 'current-conversation', previousConversation: 'previous-conversation',
  previousConversationSection: 'previous-conversation-section', assessmentPanel: 'assessment-panel', meetingSources: 'meeting-sources',
  openSettings: 'open-settings', settingsDialog: 'settings-dialog', settingsUnavailable: 'settings-unavailable', settingsStatus: 'settings-status',
  chatTools: 'chat-tools', backToInbox: 'back-to-inbox', openEvidence: 'open-evidence', closeEvidence: 'close-evidence',
  sidePanel: 'side-panel', evidenceChatLabel: 'evidence-chat-label', addConfirmation: 'add-confirmation', openChatDispatch: 'open-chat-dispatch',
  chatDispatchConsequence: 'chat-dispatch-consequence', chatDispatchEffectTitle: 'chat-dispatch-effect-title', chatDispatchLatest: 'chat-dispatch-latest',
  chatDispatchDialog: 'chat-dispatch-dialog', chatDispatchForm: 'chat-dispatch-form', chatDispatchTarget: 'chat-dispatch-target',
  chatDispatchContext: 'chat-dispatch-context', chatDispatchClear: 'chat-dispatch-clear', chatDispatchStatus: 'chat-dispatch-status',
  chatDispatchBriefFields: 'chat-dispatch-brief-fields',
  chatDispatchPermissionSection: 'chat-dispatch-permission-section', chatDispatchMode: 'chat-dispatch-mode',
  chatDispatchRecord: 'chat-dispatch-record', chatDispatchEligibility: 'chat-dispatch-eligibility',
  confirmChatDispatch: 'confirm-chat-dispatch', cancelChatDispatch: 'cancel-chat-dispatch',
  dmReplies: 'dm-replies', dmRepliesSwitch: 'dm-replies-switch', dmRepliesHint: 'dm-replies-hint',
  testMode: 'test-mode', testModeSwitch: 'test-mode-switch', testModeHint: 'test-mode-hint',
  replyPrompt: 'reply-prompt', reloadReplyPrompt: 'reload-reply-prompt',
  selectionCount: 'selection-count', newInboundList: 'new-inbound-list', openList: 'open-list',
  dispatchBrief: 'dispatch-brief', dispatchBriefText: 'dispatch-brief-text', dispatchBriefClear: 'dispatch-brief-clear',
  openOpener: 'open-opener', openerDialog: 'opener-dialog', openerForm: 'opener-form', openerContext: 'opener-context',
  openerLanguage: 'opener-language', generateOpener: 'generate-opener', openerDraft: 'opener-draft',
  openerResult: 'opener-result', openerStatus: 'opener-status', copyOpener: 'copy-opener',
  chatHeader: 'chat-header', timeline: 'timeline', composer: 'composer', composerText: 'composer-text',
  insertAcknowledgement: 'insert-acknowledgement', sendButton: 'send-button', leaveUnansweredButton: 'leave-unanswered-button',
  replyTarget: 'reply-target', matches: 'matches', caseLog: 'case-log', watchlistView: 'watchlist-view',
  placesView: 'places-view', placesSearchForm: 'places-search-form', placesQuery: 'places-query',
  placesCategory: 'places-category', placesStatus: 'places-status', placesMap: 'places-map',
  placesDetails: 'places-details', placesDetailsBody: 'places-details-body', placesDetailsClose: 'places-details-close',
  caseReferences: 'case-references', caseReferenceForm: 'case-reference-form', caseReferenceHosts: 'case-reference-hosts',
  caseReferenceNote: 'case-reference-note', caseReferenceSubmit: 'case-reference-submit',
  watchlist: 'watchlist', captureDialog: 'capture-dialog', captureDialogImage: 'capture-dialog-image',
  openPhoneDispatch: 'open-phone-dispatch', phoneDialog: 'phone-dispatch-dialog', phoneForm: 'phone-dispatch-form',
  phoneNumber: 'phone-dispatch-number', phoneBrief: 'phone-dispatch-brief', phoneSubmit: 'phone-dispatch-submit',
  openFlagScammer: 'open-flag-scammer', flagDialog: 'flag-dialog', flagForm: 'flag-form', flagTarget: 'flag-target',
  flagNumber: 'flag-number', flagReason: 'flag-reason', flagStatus: 'flag-status', flagSubmit: 'flag-submit',
  phoneStatus: 'phone-dispatch-status', phoneChat: 'phone-dispatch-chat', phoneDraft: 'phone-dispatch-draft',
  openerRecipient: 'opener-recipient', openerRecipientNumber: 'opener-recipient-number',
  openTelegramDraft: 'open-telegram-draft', openerManualHint: 'opener-manual-hint',
  resetThisChat: 'reset-this-chat', eraseInbox: 'erase-entire-inbox', eraseDialog: 'erase-dialog', eraseHeading: 'erase-heading',
  eraseDescription: 'erase-description', eraseChatLine: 'erase-chat-line', eraseChatLabel: 'erase-chat-label', eraseForm: 'erase-form',
  eraseTypedField: 'erase-typed-field', eraseTyped: 'erase-typed', eraseStatus: 'erase-status',
  eraseCancel: 'erase-cancel', eraseConfirm: 'erase-confirm',
  eraseTelegram: 'erase-telegram', eraseTelegramResult: 'erase-telegram-result',
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
let activeToken = null;
let generation = 0;
let temporaryCredential = null;

function showPasswordChange(credential) {
  temporaryCredential = credential;
  const changing = credential !== null;
  refs.signinHeading.textContent = changing ? 'Set your password' : 'Sign in';
  refs.signinForm.hidden = changing;
  refs.changeForm.hidden = !changing;
  refs.changeForm.reset();
  refs.changeSubmit.disabled = false;
  refs.cancelChange.disabled = false;
  if (changing) refs.newPassword.focus();
}

function showSignedIn(signedIn) {
  refs.signin.hidden = signedIn;
  refs.workspace.hidden = !signedIn;
  refs.viewNav.hidden = !signedIn;
  refs.session.hidden = !signedIn;
}

/** Shows the sign-in form with a message; `problem` marks it as an error rather than information. */
function showSignIn(message, problem = true) {
  generation++;
  dashboard?.stop();
  dashboard = null;
  activeToken = null;
  clearToken();
  showPasswordChange(null);
  showSignedIn(false);
  refs.signinMessage.textContent = message;
  refs.signinMessage.className = problem ? 'error' : 'hint';
  refs.password.value = '';
  refs.signinSubmit.disabled = false;
  (refs.username.value ? refs.password : refs.username).focus();
}

async function signIn(credential) {
  const attempt = ++generation;
  refs.signinSubmit.disabled = true;
  refs.changeSubmit.disabled = true;
  refs.cancelChange.disabled = true;
  refs.signinMessage.textContent = '';
  const passwordLogin = typeof credential !== 'string';
  let token;
  try {
    if (passwordLogin) {
      const result = await loginOfficer(credential);
      if (result.passwordChangeRequired) {
        if (attempt === generation) showPasswordChange({ username: credential.username, password: credential.password });
        return;
      }
      token = result.token;
    } else token = credential;
    const onSessionEnded = () => {
      if (attempt === generation && dashboard !== null) showSignIn(SESSION_ENDED);
    };
    const api = createApi(token, { onUnauthenticated: onSessionEnded });
    const me = await api.me();
    if (attempt !== generation) {
      if (passwordLogin) await logoutOfficer(token);
      return;
    }
    if (me.kind !== 'officer') throw new Error('An officer account is required.');
    activeToken = token;
    storeToken(token);
    refs.officerName.textContent = me.displayName;
    refs.username.value = '';
    showSignedIn(true);
    showPasswordChange(null);
    dashboard = startDashboard({ api, me, token, refs, onSessionEnded });
  } catch (error) {
    if (passwordLogin && token) void logoutOfficer(token).catch(() => {});
    if (attempt !== generation) return;
    const invalid = error instanceof ApiError && error.status === UNAUTHORIZED;
    if (temporaryCredential && !token && !invalid) {
      refs.signinMessage.textContent = describeError(error);
      refs.signinMessage.className = 'error';
      refs.changeSubmit.disabled = false;
      refs.cancelChange.disabled = false;
      refs.newPassword.focus();
      return;
    }
    showSignIn(invalid ? (passwordLogin && !token ? 'Incorrect username or password.' : SESSION_ENDED) : describeError(error));
  }
}

refs.signinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (refs.signinSubmit.disabled) return;
  const username = refs.username.value.trim();
  const password = refs.password.value;
  refs.password.value = '';
  void signIn({ username, password });
});
refs.changeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (refs.changeSubmit.disabled || temporaryCredential === null) return;
  const newPassword = refs.newPassword.value;
  const length = [...newPassword].length;
  let problem;
  if (length < 12 || length > 128) problem = 'Use 12–128 characters for your new password.';
  else if (newPassword === temporaryCredential.password) problem = 'Choose a password different from your temporary password.';
  else if (newPassword !== refs.confirmPassword.value) problem = 'The new passwords do not match.';
  if (problem) {
    refs.signinMessage.textContent = problem;
    refs.signinMessage.className = 'error';
    return;
  }
  refs.changeForm.reset();
  void signIn({ ...temporaryCredential, newPassword });
});
refs.cancelChange.addEventListener('click', () => showSignIn('', false));
refs.signOut.addEventListener('click', () => {
  const token = activeToken;
  showSignIn('You are signed out.', false);
  const signedOut = generation;
  void logoutOfficer(token).catch((error) => {
    if (signedOut === generation && !(error instanceof ApiError && error.status === UNAUTHORIZED)) {
      showSignIn('Signed out of this tab. The service could not confirm session revocation.');
    }
  });
});

/**
 * A #token= link pasted into this open tab: the token leaves the address bar and history at once, and the tab signs in
 * with it in place of the current session. Registered before any dashboard starts, so it runs before the dashboard's
 * own route listener, which stopping the dashboard removes.
 */
window.addEventListener('hashchange', () => {
  const token = takeTokenFromFragment();
  if (token === null) return;
  const previousToken = activeToken;
  showSignIn('', false);
  if (previousToken !== token) void logoutOfficer(previousToken).catch(() => {});
  void signIn(token);
});

const initialToken = takeTokenFromFragment() ?? readStoredToken();
if (initialToken === null) showSignIn('', false);
else void signIn(initialToken);

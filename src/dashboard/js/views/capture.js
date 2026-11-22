/**
 * Capture thumbnails. The PNG is fetched with the token (an <img src> cannot send one), shown from an object URL and
 * enlarged on click. Object URLs are cached per artifact while the chat is open and revoked when it is left; a failed
 * fetch is not cached, so Retry fetches again. A failed render offers the service's capture retry.
 */
import { append, h } from '../dom.js';
import { describeError } from '../format.js';

const CAPTURE_LABEL = 'Mirsad-rendered capture';
const STATUS_TEXT = { pending: 'Capture pending.', rendering: 'Rendering the capture.' };

export function createCaptureCache(api) {
  const urls = new Map();

  function load(artifactId) {
    if (!urls.has(artifactId)) {
      const pending = api.artifactBlob(artifactId).then((blob) => URL.createObjectURL(blob));
      pending.catch(() => {
        if (urls.get(artifactId) === pending) urls.delete(artifactId);
      });
      urls.set(artifactId, pending);
    }
    return urls.get(artifactId);
  }

  function revoke(artifactId) {
    const pending = urls.get(artifactId);
    urls.delete(artifactId);
    // A fetch that failed never produced a URL, so there is nothing to revoke for it.
    if (pending) pending.then((url) => URL.revokeObjectURL(url), () => undefined);
  }

  return {
    load,
    retainOnly(artifactIds) {
      for (const artifactId of [...urls.keys()]) if (!artifactIds.has(artifactId)) revoke(artifactId);
    },
    revokeAll() {
      for (const artifactId of [...urls.keys()]) revoke(artifactId);
    },
  };
}

function retryButton(label, onClick) {
  const button = h('button', { type: 'button', text: label });
  button.addEventListener('click', onClick, { once: true });
  return button;
}

function showImage(figure, artifactId, subject, ctx) {
  const image = h('img', { className: 'capture-image', alt: `${CAPTURE_LABEL} of ${subject}` });
  const enlarge = h('button', { type: 'button', className: 'capture-thumb', 'aria-label': `Enlarge the ${CAPTURE_LABEL} of ${subject}` }, [image]);
  const status = h('p', { className: 'hint', text: 'Loading the capture.' });
  append(figure, [enlarge, h('figcaption', { text: CAPTURE_LABEL }), status]);
  enlarge.addEventListener('click', () => {
    if (figure.dataset.state === 'loaded') ctx.handlers.onEnlargeCapture(image.src, image.alt);
  });
  const failed = (text) => {
    figure.dataset.state = 'error';
    status.textContent = `Could not load the capture: ${text}`;
    status.after(retryButton('Retry loading', (event) => {
      event.currentTarget.remove();
      attempt();
    }));
  };
  image.addEventListener('load', () => {
    figure.dataset.state = 'loaded';
    status.textContent = '';
  });
  image.addEventListener('error', () => failed('the image could not be displayed.'));
  const attempt = () => {
    figure.dataset.state = 'loading';
    status.textContent = 'Loading the capture.';
    ctx.captures.load(artifactId).then((url) => {
      image.src = url;
    }, (error) => failed(describeError(error)));
  };
  attempt();
}

/** The capture block of one message or edit event; `subject` names it for the image's text alternative. */
export function renderCapture(capture, subject, ctx) {
  const figure = h('figure', { className: 'capture', dataset: { state: capture.status } });
  if (capture.status === 'ready' && capture.artifactId !== null) {
    showImage(figure, capture.artifactId, subject, ctx);
    return figure;
  }
  if (capture.status === 'failed') {
    const reason = capture.errorCode ?? 'unknown error';
    return append(figure, [
      h('figcaption', { text: CAPTURE_LABEL }),
      h('p', { className: 'error', text: `Capture failed (${reason}). The message itself is stored.` }),
      capture.retryable ? retryButton('Retry capture', () => ctx.handlers.onRetryCapture(capture.id)) : null,
    ]);
  }
  return append(figure, [
    h('figcaption', { text: CAPTURE_LABEL }),
    h('p', { className: 'hint', text: STATUS_TEXT[capture.status] ?? 'Capture pending.' }),
  ]);
}

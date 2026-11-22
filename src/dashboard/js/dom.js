/**
 * DOM building without ever parsing markup. Text is set with textContent, children must be nodes, attributes go through
 * setAttribute and a few form states through their properties. Names and labels from a source go in <bdi> (bdi()).
 */
import { formatTime } from './format.js';

const PROPERTIES = new Set(['checked', 'disabled', 'value', 'hidden', 'tabIndex', 'readOnly']);

function setProp(node, key, value) {
  if (value === null || value === undefined || value === false) return;
  if (key === 'text') node.textContent = String(value);
  else if (key === 'className') node.className = value;
  else if (key === 'dataset') Object.assign(node.dataset, value);
  else if (PROPERTIES.has(key)) node[key] = value;
  else node.setAttribute(key, value === true ? '' : String(value));
}

/**
 * Appends nodes, skipping null, undefined and false (Element.append would turn them into the text "null"). Anything
 * else that is not a node is refused, so text can only arrive through textContent.
 */
export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (!(child instanceof Node)) throw new TypeError('append(): children must be DOM nodes; text goes in the text property');
    parent.append(child);
  }
  return parent;
}

/** h('p', { className: 'x', text: 'plain text' }, [childNode, ...]) */
export function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) setProp(node, key, value);
  return append(node, children);
}

/** A name or label that came from a source, isolated for bidirectional text. */
export function bdi(value) {
  return h('bdi', { text: value });
}

export function timeEl(iso) {
  return h('time', { datetime: iso, text: formatTime(iso) });
}

export function clear(node) {
  node.replaceChildren();
}

/** Re-renders a region and returns focus to the element with the same data-focus-key when focus was inside it. */
export function withFocus(container, render) {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined;
  render();
  if (!key) return;
  const again = [...container.querySelectorAll('[data-focus-key]')].find((el) => el.dataset.focusKey === key);
  if (again instanceof HTMLElement) again.focus({ preventScroll: true });
}

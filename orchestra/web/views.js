// One panel, one task at a time: the hall stays on screen behind it. "home" closes the panel.
import './i18n.js';   // the bar below is measured once the page reads in the chosen language
const panel = document.getElementById('panel');
let opener = null;

export function show(name) {
  const open = name !== 'home';
  for (const element of panel.querySelectorAll('[data-view]')) element.hidden = element.dataset.view !== name;
  panel.hidden = !open;
  document.body.classList.toggle('panel-open', open);
  for (const menu of document.querySelectorAll('.topbar details[open]')) menu.open = false;
  if (open) { panel.scrollTop = 0; panel.querySelector(`[data-view="${name}"] :is(h1, h2)`)?.focus(); }
  else { opener?.focus(); opener = null; }
  dispatchEvent(new CustomEvent('view', { detail: name }));
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-open]');
  if (trigger) {
    event.preventDefault();
    if (!panel.contains(trigger) && trigger.dataset.open !== 'home') opener = trigger;
    show(trigger.dataset.open);
    return;
  }
  // A click outside an open menu closes it.
  for (const menu of document.querySelectorAll('.topbar details[open]')) if (!menu.contains(event.target)) menu.open = false;
});

// The bar folds its menu into the Menu button whenever the menu does not fit on one line: a longer
// language, capitals, a mid-size window. Measured unfolded each time, so it unfolds again when there is room.
const bar = document.querySelector('.topbar');
function fit() {
  if (!bar) return;
  bar.classList.remove('compact');
  // The bar widens with what it holds, so it is measured against the window, not against itself.
  if (bar.scrollWidth > document.documentElement.clientWidth + 1) bar.classList.add('compact');
}
addEventListener('resize', fit);
addEventListener('lang', fit);
document.fonts?.ready.then(fit);
fit();

addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = document.querySelector('.topbar details[open]');
  if (menu) { menu.open = false; menu.querySelector('summary').focus(); return; }
  if (!panel.hidden && !document.body.classList.contains('is-placing')) show('home');
});

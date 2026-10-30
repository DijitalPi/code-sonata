// One column, one task at a time: the hall stays on screen while you connect, create or invite.
const column = document.querySelector('.column');

function show(name) {
  for (const element of document.querySelectorAll('[data-view]')) element.hidden = element.dataset.view !== name;
  column.scrollTop = 0;
  document.querySelector(`[data-view="${name}"] :is(h1, h2)`)?.focus();
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-open]');
  if (!trigger) return;
  event.preventDefault();
  show(trigger.dataset.open);
});

addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('section[data-view="home"]').hidden) show('home');
});

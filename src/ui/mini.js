'use strict';
const $ = id => document.getElementById(id), api = window.favecusMini;
let state = { volume: 1 }, lastVolume = 1, collapseTimer, errorTimer;
function Icon(button, name) { $(button).querySelector('use').setAttribute('href', `icons.svg#${name}`); }
async function Run(fn) {
  try { return await fn(); } catch (error) {
    $('mini-error').textContent = error.message; document.body.classList.add('has-error');
    void api.expand(true); clearTimeout(errorTimer); errorTimer = setTimeout(() => { document.body.classList.remove('has-error'); if (!document.body.classList.contains('expanded')) void api.expand(false); }, 6000);
  }
}
function Render(value) {
  state = value; $('mini-title').textContent = value.title; $('mini-title').title = value.title;
  $('mini-artist').textContent = value.artist + (value.canStop && value.paused ? ' · 一時停止' : '');
  $('mini-toggle').disabled = !value.canToggle; $('mini-stop').disabled = !value.canStop;
  $('mini-previous').disabled = !value.canStep; $('mini-next').disabled = !value.canStep;
  const label = value.paused ? '再生' : '一時停止'; $('mini-toggle').title = label; $('mini-toggle').setAttribute('aria-label', label);
  Icon('mini-toggle', value.paused ? 'play' : 'pause'); Icon('mini-volume-button', value.volume === 0 ? 'muted' : 'volume');
  $('mini-volume').value = Math.round(value.volume * 100); $('mini-volume-value').textContent = `${$('mini-volume').value}%`;
  if (value.volume > 0) lastVolume = value.volume;
}
function Expand(value) {
  clearTimeout(collapseTimer); document.body.classList.toggle('expanded', value); $('mini-volume-button').setAttribute('aria-expanded', String(value));
  Run(() => api.expand(value || document.body.classList.contains('has-error')));
}
function CollapseSoon() { clearTimeout(collapseTimer); collapseTimer = setTimeout(() => { if (!$('mini-volume-area').matches(':hover') && !$('mini-volume-area').contains(document.activeElement)) Expand(false); }, 200); }
$('mini-toggle').onclick = () => Run(() => api.command('toggle'));
$('mini-stop').onclick = () => Run(() => api.command('stop'));
for (const command of ['previous', 'next']) $(`mini-${command}`).onclick = () => Run(() => api.command(command));
$('mini-restore').onclick = () => Run(() => api.restore());
$('mini-volume').oninput = () => { const volume = Number($('mini-volume').value) / 100; Render({ ...state, volume }); Run(() => api.volume(volume)); };
$('mini-volume-button').onclick = () => Run(() => api.volume(state.volume > 0 ? 0 : lastVolume));
$('mini-volume-area').addEventListener('mouseenter', () => Expand(true));
$('mini-volume-area').addEventListener('mouseleave', CollapseSoon);
$('mini-volume-area').addEventListener('focusin', () => Expand(true));
$('mini-volume-area').addEventListener('focusout', CollapseSoon);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); Expand(false); } });
api.onState(Render); api.onCollapse(() => { clearTimeout(collapseTimer); document.body.classList.remove('expanded', 'has-error'); $('mini-volume-button').setAttribute('aria-expanded', 'false'); });
Run(async () => Render(await api.state()));

'use strict';
const { CleanText } = require('./store.cjs');
function NormalizeMedia(input, source) {
  if (!input || typeof input !== 'object' || !['bilibili', 'local'].includes(source)) throw new Error('Invalid playback data');
  const finite = (value, max) => Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0;
  return { source, title: CleanText(input.title), artist: CleanText(input.artist),
    paused: input.paused !== false, ended: input.ended === true,
    position: finite(input.position, 604800), duration: finite(input.duration, 604800),
    playbackRate: finite(input.playbackRate, 16) || 1, receivedAt: Date.now() };
}
module.exports = { NormalizeMedia };

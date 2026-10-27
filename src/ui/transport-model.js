'use strict';
(function (root) {
  function HasPlayback(current) { return !!current?.playlistId && ['bilibili', 'local'].includes(current.source); }
  function TransportState({ current, playback, entries }) {
    const internal = HasPlayback(current), data = internal ? playback : null;
    return { internal, data, canStart: !internal && entries.length > 0,
      canSeek: internal && Number.isFinite(data?.duration) && data.duration > 0 };
  }
  const exports = { HasPlayback, TransportState };
  if (typeof module === 'object') module.exports = exports;
  else root.FavecusTransport = exports;
})(globalThis);

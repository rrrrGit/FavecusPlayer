'use strict';
// IPC：再生キューの並べ替え・追加・ジャンプ
// main.cjs から分けたもの（動作は同じ）。状態（store・current など）は、ctx 経由で、その都度読む（S.store など）。
module.exports = function RegisterQueue(ctx) {
  const S = ctx;
  const { Emit, Handle, LoadEntry, PlayableEntry, QueueState, ScopeEntries } = ctx;
  // 再生キュー：これから再生する曲の並べ替え・任意の曲へのジャンプ（共通の Queue.Reorder / Queue.JumpTo）
  Handle('queue:reorder', (from, to) => {
    if (!S.current?.playlistId) return { ok: false };
    const next = S.queue.Clone(), ok = next.Reorder(Number(from), Number(to));
    if (ok) { S.queue = next; Emit('queue', QueueState()); }
    return { ok };
  });
  // 「次に再生」「最後に追加」：再生中のキューへ、この曲を足す（再生していないときは、何もしない）
  Handle('queue:insert', (playlistId, entryId, where) => {
    if (!S.current?.playlistId) return { ok: false, idle: true };
    const entry = PlayableEntry(String(playlistId), String(entryId)), next = S.queue.Clone();
    const ok = where === 'end' ? next.AddToEnd({ ...entry, playlistId: String(playlistId) }) : next.PlayNext({ ...entry, playlistId: String(playlistId) });
    if (ok) { S.queue = next; Emit('queue', QueueState()); }
    return { ok };
  });
  Handle('queue:jump', async id => {
    if (!S.current?.playlistId) return { ok: false };
    const prev = S.queue.Clone(), next = S.queue.Clone(), target = next.JumpTo(String(id));
    if (!target) return { ok: false };
    const entry = ScopeEntries(next.playlistId).find(e => e.id === target) || next.catalog.get(target);
    if (!entry) return { ok: false };
    PlayableEntry(entry.playlistId, target); S.queue = next;
    try { await LoadEntry(entry.playlistId, target); }
    catch (error) { S.queue = prev; Emit('queue', QueueState()); throw error; }
    return { ok: true };
  });
};

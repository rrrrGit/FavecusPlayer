'use strict';
// iPhone版（JavaScriptCore）が使うライブラリの入口。保存ファイルの読み込み判定と編集操作を、Swiftへ規則を持たせずに共通JSで行う。
// 端末APIなし。ID・時刻は呼び出し側が渡す（ids：新しいIDの予備、now：ISO文字列）。入出力はJSON文字列で扱いやすいよう、結果は { text } または { error } にそろえる。
const Actions = require('./library-actions.cjs');
const Tree = require('../ui/library-tree.js');
const { ValidateLibrary, CleanText } = require('./library-data.cjs');
const { ValidateIdentityVersion } = require('./library-identity.cjs');

const ID = /^[a-f0-9-]{36}$/;
function Context(options) {
  const pool = Array.isArray(options?.ids) ? [...options.ids] : [];
  return {
    createId: () => { const id = pool.shift(); if (!ID.test(id || '')) throw new Error('新しい識別番号を用意できません。'); return id; },
    now: () => (typeof options?.now === 'string' && Number.isFinite(Date.parse(options.now)) ? new Date(options.now).toISOString() : '1970-01-01T00:00:00.000Z'),
    cleanTitle: value => CleanText(value)
  };
}
function EmptyLibrary(ctx) {
  const first = Actions.NewPlaylist(ctx);
  return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: first.id, rootPlaylistIds: [first.id], playlists: [first] };
}
const Pretty = value => JSON.stringify(value, null, 2);

// 保存ファイルの内容（なければnull）を読む。status：
//   'new'         ファイルがない → 既定のライブラリ（まだ保存していない）
//   'ok'          読み込めた（全体を検証済み）
//   'unsupported' この版では扱えない形式（上書きしないこと）
//   'invalid'     壊れている・検証に失敗（上書きしないこと）
function Open(options) {
  const ctx = Context(options), text = options?.text;
  if (text === null || text === undefined || text === '') return { status: 'new', text: Pretty(EmptyLibrary(ctx)) };
  let value;
  try { value = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return { status: 'invalid', message: '保存データを読み取れません。' }; }
  if (!value || typeof value !== 'object' || value.version !== 3) return { status: 'unsupported', message: 'この版では扱えない形式の保存データです。保存データは変更していません。' };
  try { ValidateIdentityVersion(value); } catch (error) { return { status: 'unsupported', message: error.message }; }
  try {
    const playlists = ValidateLibrary(value, false, ctx.createId);
    const active = playlists.some(p => p.id === value.activePlaylistId) ? value.activePlaylistId : (value.rootPlaylistIds[0] || playlists[0].id);
    return { status: 'ok', text: Pretty({ ...value, version: 3, playlists, activePlaylistId: active }) };
  } catch (error) { return { status: 'invalid', message: `保存データを検証できません：${error.message}` }; }
}
// 編集操作を1つ適用する。失敗したときは { error } を返し、元のライブラリは変えない（呼び出し側は保存しない）。
function Apply(options) {
  try {
    const library = JSON.parse(options.text), ctx = Context(options);
    if (!Actions.Apply(library, options.action, ctx)) throw new Error('対応していない操作です。');
    Tree.ValidateGraph(library.playlists, library.rootPlaylistIds);
    if (!library.playlists.some(p => p.id === library.activePlaylistId)) library.activePlaylistId = library.rootPlaylistIds[0] || library.playlists[0].id;
    return { text: Pretty(library) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
module.exports = { Open, Apply };

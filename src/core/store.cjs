'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Tree = require('../ui/library-tree.js');
const Keys = require('../ui/keybindings.js');
const { ValidateIcon } = require('./playlist-icon.cjs');
const { randomUUID } = require('node:crypto');
const { ParseBilibili, ParseVideo, ShareTitle, MEDIA_EXTENSIONS } = require('./urls.cjs');
const { ReadJSON, ExportJSON } = require('./library-json.cjs');
const { ValidateTitleWords, TitleCleaner } = require('./title-cleanup.cjs');
const { Repository, DriveURL } = require('./releases.cjs');
const { VideoIdentity } = require('./media-identity.cjs');
const { IDENTITY_SCHEMA_VERSION, MEDIA_ID, IdentityError, ValidateIdentityVersion, PlanMediaIds, VideoAliases, LibraryMediaKey } = require('./library-identity.cjs');
const LibraryData = require('./library-data.cjs');
const Actions = require('./library-actions.cjs');
const { MAX_PLAYLISTS, MAX_ENTRIES, MEDIA_NAME, CleanText, ValidatePlaylistCount } = LibraryData;
const MAX_JSON = 32 * 1024 * 1024;
const DEFAULT_SETTINGS = { releaseRepository: '', discordThumbnailSize: 'small', weightedShuffle: true, discordThumbnail: true, discordVideoLink: true, discordEnabled: false, discordClientId: '', discordImageKey: 'favecus_player_music', hideWhenPaused: true, thumbnailMode: false, autoThumbnailEnabled: true, autoThumbnailMinutes: 5, taskbarEmbed: true, taskbarWidth: 500, taskbarOffset: 0, repeat: 'off', shuffle: false, volume: 1, sidebarWidth: 218 };

function NewPlaylist(name = 'お気に入り') { return { id: randomUUID(), name: CleanText(name, 60) || '無題のリスト', icon: '', entries: [], childIds: [], createdAt: new Date().toISOString(), lastAddedAt: '', includeInAll: true }; }
function Defaults() {
  const first = NewPlaylist();
  return { version: 3, activePlaylistId: first.id, rootPlaylistIds: [first.id], playlists: [first], settings: ValidateSettings({}) };
}
function ValidateSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  s.releaseRepository = Repository(input?.releaseRepository);
  s.releaseDriveURL = DriveURL(input?.releaseDriveURL);
  s.discordThumbnailSize = input?.discordThumbnailSize === 'large' ? 'large' : 'small';
  s.titleCleanupWords = ValidateTitleWords(input?.titleCleanupWords);
  s.keybindings = Keys.Validate(input?.keybindings);
  s.playlistSort = Tree.SortModes.includes(input?.playlistSort) ? input.playlistSort : 'manual';
  for (const key of ['weightedShuffle', 'discordThumbnail', 'discordVideoLink', 'discordEnabled', 'hideWhenPaused', 'shuffle', 'thumbnailMode', 'autoThumbnailEnabled', 'taskbarEmbed']) if (typeof input?.[key] === 'boolean') s[key] = input[key];
  if (Number.isFinite(input?.autoThumbnailMinutes)) s.autoThumbnailMinutes = Math.round(Math.max(1, Math.min(120, input.autoThumbnailMinutes)));
  if (Number.isFinite(input?.sidebarWidth)) s.sidebarWidth = Math.round(Math.max(170, Math.min(400, input.sidebarWidth)));
  if (Number.isFinite(input?.taskbarWidth)) s.taskbarWidth = Math.round(Math.max(260, Math.min(520, input.taskbarWidth)));
  if (Number.isFinite(input?.taskbarOffset)) s.taskbarOffset = Math.round(Math.max(0, Math.min(1200, input.taskbarOffset)));
  if (['off', 'all', 'one'].includes(input?.repeat)) s.repeat = input.repeat;
  if (Number.isFinite(input?.volume)) s.volume = Math.max(0, Math.min(1, input.volume));
  s.discordClientId = CleanText(input?.discordClientId, 30);
  s.discordImageKey = String(input?.discordImageKey ?? s.discordImageKey).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(s.discordImageKey)) throw new Error('Discordの画像名は半角英小文字・数字・_・-で1〜64文字にしてください。');
  if (s.discordClientId && !/^\d{17,22}$/.test(s.discordClientId)) throw new Error('DiscordのApplication IDは17〜22桁の数字を入力してください。');
  if (s.discordEnabled && !s.discordClientId) throw new Error('DiscordのApplication IDを入力してください。');
  return s;
}
function ValidateLibrary(input, freshIds = false) { return LibraryData.ValidateLibrary(input, freshIds, randomUUID); }

class Store {
  constructor(directory, options = {}) {
    this.options = options;
    this.directory = directory;
    this.file = path.join(directory, 'library.json');
    this.media = path.join(directory, 'media');
    fs.mkdirSync(this.media, { recursive: true });
    this.warning = '';
    this.data = this.Read();
    this.Save();
    this.recovered = !!this.warning;
  }
  Read() {
    for (const candidate of [this.file, `${this.file}.bak`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        if (fs.statSync(candidate).size > MAX_JSON) throw new Error('size');
        const value = ReadJSON(fs.readFileSync(candidate));
        ValidateIdentityVersion(value);
        const playlists = ValidateLibrary(value);
        const activePlaylistId = playlists.some(p => p.id === value.activePlaylistId) ? value.activePlaylistId : playlists[0].id;
        const settings = ValidateSettings(value.settings);
        if (settings.discordImageKey === 'focus_player_music') settings.discordImageKey = 'favecus_player_music';
        const cleanTitle = TitleCleaner(settings.titleCleanupWords);
        for (const p of playlists) for (const entry of p.entries) entry.title = cleanTitle(entry.title);
        if (candidate.endsWith('.bak')) this.warning = '前回の保存を読み込めなかったため、バックアップを復元しました。';
        if (value.version < 3) {
          // 旧形式を丸ごと残してから移行する。古い動画URLや設定も復元可能。
          const backup = path.join(this.directory, `library.pre-0.5.0-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          try { fs.copyFileSync(candidate, backup, fs.constants.COPYFILE_EXCL); }
          catch (error) { error.migrationBackupFailed = true; throw error; }
          if (value.playlists.some(p => p.entries.some(e => e?.type === 'youtube'))) this.warning += ' YouTubeの項目を一覧から外しました。変更前のリストはアプリのデータフォルダーに library.pre-0.5.0 として保存しています。';
        }
        if (value.version === 3 && (!Object.hasOwn(value, 'identityVersion') || value.identityVersion === 1)) {
          const backup = path.join(this.directory, `library.pre-0.6.7-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          try { fs.copyFileSync(candidate, backup, fs.constants.COPYFILE_EXCL); }
          catch (error) { error.migrationBackupFailed = true; throw error; }
        }
        return { version: 3, ...(Object.hasOwn(value, 'identityVersion') ? { identityVersion: value.identityVersion } : {}), ...(value.identityVersion === 2 ? { videoAliases: VideoAliases(value.videoAliases) } : {}), playlists, rootPlaylistIds: value.version === 3 ? value.rootPlaylistIds : playlists.map(p => p.id), activePlaylistId, settings };
      } catch (error) {
        if (error.identityDataInvalid || error.playlistLimitExceeded) throw error;
        if (error.migrationBackupFailed) throw new Error('更新前のバックアップを保存できません。空き容量とデータフォルダーの書き込み権限を確認してください。保存データは変更していません。');
        this.warning = '保存ファイルを読み込めませんでした。元のファイルは damaged として残しています。';
        fs.copyFileSync(candidate, `${candidate}.damaged-${Date.now()}`);
      }
    }
    return Defaults();
  }
  Save() {
    ValidatePlaylistCount(this.data.playlists.length);
    ValidateIdentityVersion(this.data);
    const videoAliases = VideoAliases(this.data.videoAliases);
    const assignments = PlanMediaIds(this.data.playlists, randomUUID, LibraryMediaKey(videoAliases));
    const next = { ...this.data, identityVersion: IDENTITY_SCHEMA_VERSION, videoAliases, playlists: this.data.playlists.map(p => ({ ...p, entries: p.entries.map(e => ({ ...e, mediaId: assignments.get(e) })) })) };
    const encoded = JSON.stringify(next, null, 2);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx' });
      // 置換前の正常な内容を保持し、途中終了で本体が空になることを防ぐ。
      if (fs.existsSync(this.file) && (!this.warning || this.recovered)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(temp, this.file);
    } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    this.data.identityVersion = IDENTITY_SCHEMA_VERSION;
    this.data.videoAliases = videoAliases;
    for (const [entry, mediaId] of assignments) entry.mediaId = mediaId;
    this.committedJSON = encoded; this.committedData = JSON.parse(encoded); this.referenceCache = null;
    try { this.options.committed?.(); } catch {}
  }
  SavedData() {
    try {
      const signature = () => { const s = fs.statSync(this.file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':'); };
      const stamp = signature();
      if (this.referenceCache === stamp) return this.committedData;
      if (fs.readFileSync(this.file, 'utf8') !== this.committedJSON || signature() !== stamp) return null;
      this.referenceCache = stamp; return this.committedData;
    } catch { return null; }
  }
  Snapshot() {
    const result = structuredClone(this.data);
    for (const p of result.playlists) for (const e of p.entries) if (e.type === 'local') e.missing = !fs.existsSync(path.join(this.media, e.fileName));
    return result;
  }
  Playlist(id) {
    const result = this.data.playlists.find(p => p.id === id);
    if (!result) throw new Error('再生リストが見つかりません。');
    return result;
  }
  Entry(playlistId, entryId) {
    const result = this.Playlist(playlistId).entries.find(e => e.id === entryId);
    if (!result) throw new Error('動画が見つかりません。');
    return result;
  }
  CleanTitle(value) { return TitleCleaner(this.data.settings.titleCleanupWords)(value); }
  IdentityKey() { return LibraryMediaKey(this.data.videoAliases); }
  RememberVideo(entry, details) {
    const media = VideoIdentity(entry, details);
    if (!media.verified) return false;
    const record = { aid: media.aliases.map(url => ParseBilibili(url).videoId).find(id => id.startsWith('av')).slice(2), bvid: media.videoId };
    if ((this.data.videoAliases || []).some(r => r.aid === record.aid && r.bvid === record.bvid)) return false;
    const aliases = VideoAliases([...(this.data.videoAliases || []), record]);
    if (aliases.length === (this.data.videoAliases || []).length) return false;
    PlanMediaIds(this.data.playlists, randomUUID, this.IdentityKey());
    const before = this.data, next = structuredClone(before), keyOf = LibraryMediaKey(aliases), winners = new Map();
    for (const p of next.playlists) for (const e of p.entries) {
      const key = keyOf(e);
      if (!winners.has(key)) winners.set(key, e.mediaId);
      e.mediaId = winners.get(key);
    }
    next.videoAliases = aliases;
    try { this.data = next; this.Save(); } catch (error) { this.data = before; throw error; }
    return true;
  }
  Targets(destinationIds) {
    const ids = typeof destinationIds === 'string' ? [destinationIds] : destinationIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PLAYLISTS) throw new Error('追加先のプレイリストにチェックしてください。');
    return [...new Set(ids)].map(id => this.Playlist(id));
  }
  InputItems(action) {
    if (!action || !['add', 'add-videos', 'add-existing'].includes(action.type)) throw new Error('追加操作が正しくありません。');
    let items;
    if (action.type === 'add') {
      const lines = String(action.urls || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length || lines.length > 100) throw new Error('1回につき1〜100件のURLを入力してください。');
      items = lines.map(line => ({ ...ParseVideo(line), title: CleanText((lines.length === 1 && action.title) || ShareTitle(line)) }));
    } else if (action.type === 'add-videos') {
      if (!Array.isArray(action.videos) || !action.videos.length || action.videos.length > MAX_ENTRIES) throw new Error('追加する動画を選んでください（最大10000件）。');
      items = action.videos.map(v => ({ ...ParseBilibili(v?.url), title: CleanText(v?.title), ...(Number.isFinite(v?.duration) && v.duration > 0 ? { duration: Math.min(v.duration, 604800) } : {}) }));
    } else {
      if (!Array.isArray(action.entries) || !action.entries.length || action.entries.length > MAX_ENTRIES) throw new Error('追加する曲にチェックしてください。');
      items = action.entries.map(ref => structuredClone(this.Entry(ref?.playlistId, ref?.entryId)));
    }
    return items;
  }
  AddItems(destinationIds, items) {
    const targets = this.Targets(destinationIds), cleanTitle = TitleCleaner(this.data.settings.titleCleanupWords);
    const key = this.IdentityKey();
    const unique = new Map();
    for (const item of items) { const id = key(item); if (!unique.has(id)) unique.set(id, item); }
    const additions = targets.map(p => {
      const known = new Set(p.entries.map(key));
      return { p, items: [...unique].filter(([id]) => !known.has(id)).map(([, item]) => item) };
    });
    const count = this.data.playlists.reduce((n, p) => n + p.entries.length, 0);
    if (count + additions.reduce((n, a) => n + a.items.length, 0) > MAX_ENTRIES) throw new Error('登録数の上限は全リスト合計10000件です。');
    const before = structuredClone(this.data);
    try {
      for (const { p, items: entries } of additions) for (const item of entries) {
        p.entries.push({ ...structuredClone(item), title: cleanTitle(item.title), id: randomUUID(), addedAt: new Date().toISOString() });
        p.lastAddedAt = new Date().toISOString();
      }
      this.Save();
    } catch (error) { this.data = before; throw error; }
    return this.Snapshot();
  }
  Apply(action) {
    const before = structuredClone(this.data);
    try { return this.ApplyAction(action); } catch (error) { this.data = before; throw error; }
  }
  ActionContext() { return { createId: randomUUID, now: () => new Date().toISOString(), cleanTitle: value => this.CleanTitle(value) }; }
  ApplyAction(action) {
    if (!action || typeof action !== 'object') throw new Error('操作が正しくありません。');
    const p = action.playlistId ? this.Playlist(action.playlistId) : null;
    if (Actions.Apply(this.data, action, this.ActionContext())) { /* 階層・名前・並び順・曲の削除/並べ替えは共通の規則（library-actions.cjs） */ }
    else if (['add', 'add-videos', 'add-existing'].includes(action.type)) {
      return this.AddItems(action.destinationIds ?? action.playlistId, this.InputItems(action));
    }
    else if (action.type === 'settings') {
      const settings = ValidateSettings({ ...this.data.settings, ...action.settings }), before = structuredClone(this.data);
      try {
        this.data.settings = settings;
        if (Object.hasOwn(action.settings || {}, 'titleCleanupWords')) {
          const cleanTitle = TitleCleaner(settings.titleCleanupWords);
          for (const list of this.data.playlists) for (const entry of list.entries) entry.title = cleanTitle(entry.title);
        }
        this.Save();
      } catch (error) { this.data = before; throw error; }
      return this.Snapshot();
    }
    else throw new Error('対応していない操作です。');
    Tree.ValidateGraph(this.data.playlists, this.data.rootPlaylistIds);
    this.Save(); return this.Snapshot();
  }
  Parent(id, parentId, move) { Actions.Parent(this.data, this.ActionContext(), id, parentId, move); }
  Entries(scope) { return Tree.Entries(this.data, scope); }
  async AddFiles(destinationIds, files) {
    const targets = this.Targets(destinationIds);
    if (!Array.isArray(files) || !files.length) throw new Error('追加するファイルを選んでください。');
    const count = this.data.playlists.reduce((n, list) => n + list.entries.length, 0);
    if (count + files.length * targets.length > MAX_ENTRIES) throw new Error('登録数の上限は全リスト合計10000件です。');
    const items = [], created = [];
    try {
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext) || !(await fs.promises.stat(file)).isFile()) throw new Error('対応していないファイルです。');
      const fileName = `${randomUUID()}${ext === '.wma' ? '.flac' : ext}`;
      created.push(fileName);
      if (ext === '.wma') {
        if (!this.options.convertWma) throw new Error('WMAの変換環境が見つかりません。セットアップを再実行してください。');
        await this.options.convertWma(file, path.join(this.media, fileName));
      } else await fs.promises.copyFile(file, path.join(this.media, fileName));
      items.push({ type: 'local', fileName, title: path.basename(file, path.extname(file)) });
    }
    return this.AddItems(targets.map(p => p.id), items);
    } catch (error) {
      for (const fileName of created) await fs.promises.rm(path.join(this.media, fileName), { force: true }).catch(() => {});
      throw error;
    }
  }
  Transfer({ playlistId, entryId, destinationIds, mode, targetId, after = false } = {}) {
    if (!['copy', 'move'].includes(mode) || !Array.isArray(destinationIds) || !destinationIds.length || destinationIds.length > MAX_PLAYLISTS - 1) throw new Error('移動・追加先のプレイリストを選んでください。');
    const source = this.Playlist(playlistId), entry = this.Entry(playlistId, entryId);
    const targets = [...new Set(destinationIds)].map(id => {
      if (id === playlistId) throw new Error('元のプレイリスト以外を選んでください。');
      return this.Playlist(id);
    });
    if (targetId !== undefined && (targets.length !== 1 || !targets[0].entries.some(e => e.id === targetId) || typeof after !== 'boolean')) throw new Error('挿入先の楽曲が見つかりません。挿入位置を選び直してください。');
    const keyOf = this.IdentityKey(), same = e => keyOf(e) === keyOf(entry);
    const operations = targets.map(p => ({ p, existing: p.entries.find(same) }));
    const added = operations.filter(o => !o.existing).length;
    const count = this.data.playlists.reduce((n, p) => n + p.entries.length, 0);
    if (count + added - (mode === 'move' ? 1 : 0) > MAX_ENTRIES) throw new Error('登録数の上限は10000件です。');
    const before = structuredClone(this.data), destinations = []; let retainedId = false;
    try {
      for (const { p, existing } of operations) {
        const item = existing || { ...structuredClone(entry), title: this.CleanTitle(entry.title), id: mode === 'move' && !retainedId ? entry.id : randomUUID() };
        if (!existing) retainedId = true;
        if (targetId !== undefined && item.id !== targetId) {
          if (existing) p.entries.splice(p.entries.indexOf(existing), 1);
          p.entries.splice(p.entries.findIndex(e => e.id === targetId) + (after ? 1 : 0), 0, item);
        } else if (!existing) p.entries.push(item);
        if (!existing) p.lastAddedAt = new Date().toISOString();
        destinations.push({ playlistId: p.id, entryId: item.id });
      }
      if (mode === 'move') source.entries = source.entries.filter(e => e.id !== entryId);
      this.Save();
    } catch (error) { this.data = before; throw error; }
    return { state: this.Snapshot(), destinations, added, skipped: operations.length - added, moved: mode === 'move' };
  }
  TransferMany({ entries, destinationIds } = {}) {
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) throw new Error('移動する曲を選んでください。');
    const targets = this.Targets(destinationIds), refs = [...new Map(entries.map(r => [`${r.playlistId}:${r.entryId}`, r])).values()];
    const sources = refs.map(r => ({ ...r, entry: structuredClone(this.Entry(r.playlistId, r.entryId)) }));
    if (sources.some(r => !targets.some(p => p.id !== r.playlistId))) throw new Error('元のプレイリスト以外にも移動先を選んでください。');
    const before = structuredClone(this.data), mappings = [], keyOf = this.IdentityKey(); let added = 0;
    try {
      // Remove the complete selection first: a destination may also be a source.
      // This keeps reused destination rows and playback mappings valid.
      for (const ref of sources) {
        const source = this.Playlist(ref.playlistId);
        source.entries = source.entries.filter(e => e.id !== ref.entryId);
      }
      for (const ref of sources) {
        const destinations = []; let retainedId = false;
        for (const p of targets) {
          if (p.id === ref.playlistId) continue;
          let item = p.entries.find(e => keyOf(e) === keyOf(ref.entry));
          if (!item) { item = { ...ref.entry, id: retainedId ? randomUUID() : ref.entry.id }; retainedId = true; p.entries.push(item); p.lastAddedAt = new Date().toISOString(); added++; }
          destinations.push({ playlistId: p.id, entryId: item.id });
        }
        mappings.push({ playlistId: ref.playlistId, entryId: ref.entryId, destinations });
      }
      if (this.data.playlists.reduce((n, p) => n + p.entries.length, 0) > MAX_ENTRIES) throw new Error('登録数の上限は10000件です。');
      this.Save();
    } catch (error) { this.data = before; throw error; }
    return { state: this.Snapshot(), moved: sources.length, added, mappings };
  }
  async Export(parent, options = {}) {
    const { ShareMode, ShareData } = require('./library-share.cjs');
    const mode = ShareMode(options);
    if (this.sharingBusy) throw new Error('出力・取り込みの完了後に出力してください。');
    const data = ShareData(structuredClone(this.data), mode); this.sharingBusy = true;
    let folder, missing = 0, omitted = 0;
    try {
      folder = await fs.promises.mkdtemp(path.join(parent, 'FavecusPlayer-'));
      const included = new Map();
      for (const p of data.playlists) for (const e of p.entries) if (e.type === 'local') {
        if (!included.has(e.fileName)) {
          let available = false;
          if (mode === 'media') {
            const source = path.join(this.media, e.fileName), stat = await fs.promises.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat?.isFile() && !stat.isSymbolicLink()) {
              await fs.promises.mkdir(path.join(folder, 'media'), { recursive: true });
              await fs.promises.copyFile(source, path.join(folder, 'media', e.fileName), fs.constants.COPYFILE_EXCL); available = true;
            } else missing++;
          } else omitted++;
          included.set(e.fileName, available);
        }
        e.mediaIncluded = included.get(e.fileName);
      }
      await fs.promises.writeFile(path.join(folder, 'favecus-player-library.json'), ExportJSON(data), { flag: 'wx' });
      return { folder, mode, missing, omitted };
    } catch (error) { if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); throw error; }
    finally { this.sharingBusy = false; }
  }
  async Import(file) {
    const { LibraryArchive } = require('./library-archive.cjs');
    const archive = new LibraryArchive(this);
    const plan = await archive.Prepare(file);
    try { return await archive.Commit(plan.id, plan.playlists.map(p => p.id)); }
    finally { await archive.Cancel(plan.id); }
  }
}

module.exports = { Store, MAX_PLAYLISTS, ValidatePlaylistCount, CleanText, ValidateLibrary, ValidateSettings, MEDIA_NAME };

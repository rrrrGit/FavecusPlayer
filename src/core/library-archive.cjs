'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const { WriteZip, ZipReader } = require('./zip.cjs');
const { ValidateLibrary, MAX_PLAYLISTS, ValidatePlaylistCount } = require('./store.cjs');
const { ReadJSON, ExportJSON } = require('./library-json.cjs');
const { PlanImportIdentity } = require('./import-identity.cjs');
const { VideoAliases } = require('./library-identity.cjs');
const { ShareMode, ShareData, ReadShare } = require('./library-share.cjs');
const { ExportDownloads, ReadDownloads, StageDownloads, DownloadMatches, MAX_MEDIA_BYTES } = require('./offline-archive.cjs');
const Tree = require('../ui/library-tree.js');
const { CheckInnerNames, CheckOuterNames } = require('./library-transfer.cjs');
const MAGIC = Buffer.from('FVPA0001'), AUTO_MAGIC = Buffer.from('FVPA0002'), LIMIT = 32 * 1024 * 1024;
const Key = (password, salt) => promisify(scrypt)(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function Password(value) { if (typeof value !== 'string' || value.length < 8 || value.length > 1024) throw new Error('パスワードは8〜1024文字で入力してください。'); }
class LibraryArchive {
  constructor(store, offline) { this.store = store; this.offline = offline; this.plans = new Map(); }
  async Export(file, password, options = {}) {
    if (password !== undefined) Password(password);
    const mode = ShareMode(options), json = path.extname(file).toLowerCase() === '.json';
    if (json && (mode !== 'information' || password !== undefined)) throw new Error('JSONはパスワードなしの情報のみ出力で使用してください。');
    if (this.store.sharingBusy || this.offline?.controller || this.offline?.importing) throw new Error('保存・出力・取り込みの完了後に出力してください。');
    const data = ShareData(structuredClone(this.store.data), mode);
    this.store.sharingBusy = true;
    if (this.offline) { this.offline.CancelEstimate(); this.offline.importing = true; }
    let folder, missing = 0, omitted = 0;
    try {
      folder = await fs.promises.mkdtemp(path.join(path.dirname(file), '.favecus-export-'));
      const temp = path.join(folder, json ? 'library.json' : 'library.zip'), items = [], locals = new Map();
      for (const p of data.playlists) for (const e of p.entries) if (e.type === 'local') {
        if (!locals.has(e.fileName)) {
          let included = false;
          if (mode === 'media') {
            const source = path.join(this.store.media, e.fileName), stat = await fs.promises.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat?.isFile() && !stat.isSymbolicLink()) { items.push({ name: `media/${e.fileName}`, file: source }); included = true; } else missing++;
          } else omitted++;
          locals.set(e.fileName, included);
        }
        e.mediaIncluded = locals.get(e.fileName);
      }
      if (json) {
        const bytes = Buffer.from(ExportJSON(data)); if (bytes.length > LIMIT) throw new Error('プレイリスト情報が大きすぎます。');
        await fs.promises.writeFile(temp, bytes, { flag: 'wx' }); await fs.promises.rename(temp, file);
        return { file, mode, missing, omitted, downloaded: 0 };
      }
      const inner = path.join(folder, 'lists.zip');
      await WriteZip(inner, [
        { name: 'identity.json', data: Buffer.from(ExportJSON({ shareVersion: data.shareVersion, exportMode: mode, identityVersion: data.identityVersion, videoAliases: data.videoAliases })) },
        ...data.playlists.map(p => ({ name: `playlists/${p.id}.json`, data: Buffer.from(ExportJSON({ version: 3, playlist: p, rootIndex: data.rootPlaylistIds.indexOf(p.id) })) }))
      ]);
      const plain = await fs.promises.readFile(inner); if (plain.length > LIMIT) throw new Error('プレイリスト情報が大きすぎます。');
      const salt = randomBytes(16), nonce = randomBytes(12), automatic = password === undefined;
      const key = automatic ? randomBytes(32) : await Key(password, salt);
      // 自動形式は復号キーも同梱するため、秘密保護用の暗号化ではない。
      const header = Buffer.concat(automatic ? [AUTO_MAGIC, key, nonce] : [MAGIC, salt, nonce]), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(header);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); key.fill(0);
      items.unshift({ name: 'playlists.fvpa', data: Buffer.concat([header, cipher.getAuthTag(), encrypted]) });
      const downloads = mode === 'media' ? await ExportDownloads(this.offline, data.playlists) : { items: [], count: 0 }; items.push(...downloads.items);
      await WriteZip(temp, items); await fs.promises.rename(temp, file); return { file, mode, missing, omitted, downloaded: downloads.count };
    } finally { this.store.sharingBusy = false; if (this.offline) { this.offline.importing = false; this.offline.ScheduleCleanup(); } if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); }
  }
  async Prepare(file, password) {
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'favecus-import-'));
    let zip, input;
    try {
      if (path.extname(file).toLowerCase() === '.json') {
        if ((await fs.promises.stat(file)).size > LIMIT) throw new Error('ファイルが大きすぎます。');
        input = ReadJSON(await fs.promises.readFile(file));
      } else {
        zip = await new ZipReader().Open(file); const bytes = await zip.Content('playlists.fvpa', null, LIMIT + 96);
        const automatic = bytes.subarray(0, 8).equals(AUTO_MAGIC), headerSize = automatic ? 52 : 36;
        if (bytes.length <= headerSize + 16 || (!automatic && !bytes.subarray(0, 8).equals(MAGIC))) throw new Error('Favecus Playerのアーカイブではありません。');
        if (!automatic && password === undefined) throw new Error('0.5.0のパスワード付きZIPは自動で復号できません。0.5.1以降で出力したZIPか、旧JSON形式を使用してください。');
        if (!automatic) Password(password);
        const key = automatic ? Buffer.from(bytes.subarray(8, 40)) : await Key(password, bytes.subarray(8, 24)); let plain;
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(headerSize - 12, headerSize)); decipher.setAAD(bytes.subarray(0, headerSize)); decipher.setAuthTag(bytes.subarray(headerSize, headerSize + 16));
          plain = Buffer.concat([decipher.update(bytes.subarray(headerSize + 16)), decipher.final()]);
        } catch { throw new Error(automatic ? 'アーカイブが破損しています。' : 'パスワードが違うか、アーカイブが破損しています。'); } finally { key.fill(0); }
        const inner = path.join(folder, 'lists.zip'); await fs.promises.writeFile(inner, plain, { mode: 0o600 });
        const reader = await new ZipReader().Open(inner), records = []; let identity = {};
        if ([...reader.entries.values()].reduce((n, e) => n + e.bytes, 0) > LIMIT) { await reader.Close(); throw new Error('プレイリスト情報が大きすぎます。'); }
        try {
          if (reader.entries.has('identity.json')) {
            const meta = ReadJSON(await reader.Content('identity.json'));
            if (!meta || !Object.hasOwn(meta, 'identityVersion')) throw new Error('識別形式の情報がありません。');
            identity = { identityVersion: meta.identityVersion, videoAliases: meta.videoAliases, ...(Object.hasOwn(meta, 'shareVersion') ? { shareVersion: meta.shareVersion } : {}), ...(Object.hasOwn(meta, 'exportMode') ? { exportMode: meta.exportMode } : {}) };
          }
          for (const name of CheckInnerNames([...reader.entries.keys()])) records.push(ReadJSON(await reader.Content(name))); // 名前と件数の規則は共通
        } finally { await reader.Close(); }
        input = { version: 3, ...identity, playlists: records.map(r => r.playlist), rootPlaylistIds: records.filter(r => r.rootIndex >= 0).sort((a, b) => a.rootIndex - b.rootIndex).map(r => r.playlist.id) };
      }
      const playlists = ValidateLibrary(input), roots = input.version === 3 ? input.rootPlaylistIds : playlists.map(p => p.id), share = ReadShare(input);
      if (zip) CheckOuterNames(share, [...zip.entries.keys()]);
      await fs.promises.rm(folder, { recursive: true, force: true });
      const downloads = await ReadDownloads(zip);
      const id = randomUUID(); this.Prune();
      const identity = Object.hasOwn(input, 'identityVersion') ? { identityVersion: input.identityVersion, ...(input.identityVersion === 2 ? { videoAliases: VideoAliases(input.videoAliases) } : {}) } : {};
      const skipped = input.playlists.reduce((n, p) => n + p.entries.filter(e => e?.type === 'youtube').length, 0);
      this.plans.set(id, { id, input: { version: 3, ...identity, playlists, rootPlaylistIds: roots }, skipped, file, zip, downloads, share, folder, at: Date.now(), busy: false });
      return { id, mode: share.mode, playlists: playlists.map(p => ({ id: p.id, name: p.name, count: p.entries.length, downloaded: downloads.filter(r => p.entries.some(e => DownloadMatches(r, e))).length, childIds: p.childIds, sameName: this.store.data.playlists.some(q => q.name === p.name) })), rootPlaylistIds: roots };
    } catch (error) { await zip?.Close(); await fs.promises.rm(folder, { recursive: true, force: true }); throw error; }
  }
  Prune() { for (const [id, p] of this.plans) if (!p.busy && (Date.now() - p.at > 30 * 60000 || this.plans.size >= 3)) void this.Cancel(id).catch(() => {}); }
  async Cancel(id) { const plan = this.plans.get(id); if (!plan || plan.busy) return; this.plans.delete(id); await plan.zip?.Close(); await fs.promises.rm(plan.folder, { recursive: true, force: true }); }
  async Commit(id, ids, options = {}) {
    const plan = this.plans.get(id);
    if (!plan || plan.busy || Date.now() - plan.at > 30 * 60000) throw new Error('取り込み一覧を読み込み直してください。');
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PLAYLISTS || ids.some(id => !plan.input.playlists.some(p => p.id === id))) throw new Error('取り込むプレイリストを選んでください。');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('取り込み先の指定が正しくありません。');
    const parentId = options.parentId || null; if (parentId) this.store.Playlist(parentId);
    const selection = Tree.Selection(plan.input, ids), chosen = structuredClone(selection.playlists), roots = selection.rootPlaylistIds;
    let lists = ValidateLibrary({ ...plan.input, playlists: chosen, rootPlaylistIds: roots });
    const checkLimits = () => { ValidatePlaylistCount(this.store.data.playlists.length + lists.length); if ([...this.store.data.playlists, ...lists].reduce((n, p) => n + p.entries.length, 0) > 10000) throw new Error('登録数の上限を超えています。'); };
    checkLimits();
    if (this.store.sharingBusy || this.offline?.controller || this.offline?.importing) throw new Error('保存・出力・取り込みの完了後に取り込んでください。');
    if (this.offline) { this.offline.CancelEstimate(); this.offline.importing = true; }
    this.store.sharingBusy = true; plan.busy = true;
    const copied = [], files = new Map(); let before, downloadStage, localStage, missing = 0, omitted = 0;
    try {
      for (const p of lists) for (const entry of p.entries) if (entry.type === 'local') {
        const original = entry.fileName;
        if (!files.has(original)) {
          let name;
          const reserved = new Set([...this.store.data.playlists.flatMap(p => p.entries).filter(e => e.type === 'local').map(e => e.fileName), ...files.values()]);
          for (let attempt = 0; attempt < 16; attempt++) {
            const candidate = `${randomUUID()}${path.extname(original)}`;
            let exists = true; try { fs.lstatSync(path.join(this.store.media, candidate)); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
            if (!exists && !reserved.has(candidate)) { name = candidate; break; }
          }
          if (!name) throw new Error('衝突しないローカル曲の保存先を作成できません。');
          const destination = path.join(this.store.media, name); files.set(original, name);
          if (plan.share.locals.get(original) === false) { if (plan.share.mode === 'information') omitted++; else missing++; entry.fileName = name; continue; }
          localStage ||= await fs.promises.mkdtemp(path.join(this.store.media, '.import-'));
          const staged = path.join(localStage, name); let available = false;
          if (plan.zip?.entries.has(`media/${original}`)) { await plan.zip.Content(`media/${original}`, staged, MAX_MEDIA_BYTES); available = true; }
          else if (!plan.zip) {
            const source = path.join(path.dirname(plan.file), 'media', original), stat = await fs.promises.lstat(source).catch(() => null), dir = await fs.promises.lstat(path.dirname(source)).catch(() => null);
            if (stat?.isFile() && !stat.isSymbolicLink() && dir?.isDirectory() && !dir.isSymbolicLink()) {
              if (stat.size > MAX_MEDIA_BYTES) throw new Error('メディアが展開上限を超えています。');
              await fs.promises.copyFile(source, staged, fs.constants.COPYFILE_EXCL); available = true;
            } else missing++;
          } else missing++;
          if (!available && plan.share.locals.get(original) === true) throw new Error('同梱されたローカル曲を読み取れません。');
          if (available) {
            if ((await fs.promises.stat(staged)).size > MAX_MEDIA_BYTES) throw new Error('メディアが展開上限を超えています。');
            try { await fs.promises.link(staged, destination); }
            catch (error) {
              if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EACCES', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error;
              await fs.promises.copyFile(staged, destination, fs.constants.COPYFILE_EXCL);
            }
            copied.push(destination);
          }
        }
        entry.fileName = files.get(original);
      }
      checkLimits();
      const identity = PlanImportIdentity(this.store.data.playlists, lists, roots, { keyOf: this.store.IdentityKey(), createId: randomUUID, preserveIds: !!plan.input.identityVersion });
      lists = identity.playlists;
      const names = new Set(this.store.data.playlists.map(p => p.name));
      for (const p of lists) {
        const base = p.name; let i = 1; while (names.has(p.name)) p.name = `${base.slice(0, 42)}（取り込み${i++}）`; names.add(p.name);
        for (const e of p.entries) e.title = this.store.CleanTitle(e.title);
      }
      const layout = structuredClone(this.store.data); layout.playlists.push(...lists);
      const rootIds = identity.rootPlaylistIds, stamp = JSON.stringify(this.store.data);
      if (parentId) layout.playlists.find(p => p.id === parentId).childIds.push(...rootIds); else layout.rootPlaylistIds.push(...rootIds);
      downloadStage = await StageDownloads(this.offline, plan.zip, plan.downloads, lists, layout);
      if (JSON.stringify(this.store.data) !== stamp) throw new Error('取り込み中に保存データが変更されました。取り込みをやり直してください。');
      checkLimits(); before = structuredClone(this.store.data);
      const parent = parentId ? this.store.Playlist(parentId) : null;
      downloadStage?.commit();
      this.store.data.playlists.push(...lists); (parent ? parent.childIds : this.store.data.rootPlaylistIds).push(...rootIds);
      if (parent) parent.lastAddedAt = new Date().toISOString();
      this.store.data.activePlaylistId = identity.idMap.get(ids[0]);
      Tree.ValidateGraph(this.store.data.playlists, this.store.data.rootPlaylistIds); this.store.Save();
      return { state: this.store.Snapshot(), imported: lists.length, ancestors: selection.ancestorIds.length, missing, omitted, skipped: plan.skipped, downloaded: downloadStage?.imported || 0 };
    } catch (error) {
      if (before) this.store.data = before;
      try { await downloadStage?.rollback(); } catch {}
      for (const file of copied) { try { await fs.promises.rm(file, { force: true }); } catch {} }
      throw error;
    }
    finally {
      try { if (localStage) await fs.promises.rm(localStage, { recursive: true, force: true }); }
      finally {
        this.store.sharingBusy = false; if (this.offline) { this.offline.importing = false; this.offline.ScheduleCleanup(); } plan.busy = false;
        try { if (this.offline) this.offline.Notify(true); } finally { await this.Cancel(id); }
      }
    }
  }
}
module.exports = { LibraryArchive };

'use strict';
// PC版UIの全画面スクリーンショットをローカルHTTP＋Headless Chrome(CDP)で撮影する。
// GitHub Actions(ubuntu-24.04)とローカル開発の両方から追加パッケージなしで実行できるよう、Node 24標準機能のみ使う。
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { Store } = require('../src/core/store.cjs');

const ROOT = path.join(__dirname, '..');
const UI_ROOT = path.join(ROOT, 'src', 'ui');
const BUILD_ROOT = path.join(ROOT, 'build');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function ParseArgs(argv) {
  let out = path.join(os.tmpdir(), 'favecus-pc-screenshots');
  let chrome = process.env.CHROME_PATH || '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = path.resolve(argv[++i]);
    else if (argv[i] === '--chrome' && argv[i + 1]) chrome = argv[++i];
  }
  return { out, chrome };
}

function FindChrome(explicit) {
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`指定されたブラウザが見つかりません: ${explicit}`);
  }
  const commands = process.platform === 'win32'
    ? ['chrome', 'chrome.exe', 'msedge', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const locator = process.platform === 'win32' ? 'where' : 'which';
  for (const name of commands) {
    const res = spawnSync(locator, [name], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
    : [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/opt/google/chrome/chrome',
      '/snap/bin/chromium'
    ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Headless Chrome / Edge が見つかりません (--chrome で指定できます)。');
}

function FreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function BuildDemoStore(dir) {
  const { randomUUID } = require('node:crypto');
  const store = new Store(dir);
  const bv = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`;

  const mainId = store.data.playlists[0].id;
  store.Apply({ type: 'rename', playlistId: mainId, name: 'お気に入りの曲' });
  const mainSongs = [
    ['朝のピアノ（作業用セレクト）', 257],
    ['Lo-fi ビート 1時間ミックス', 1980],
    ['雨の日のジャズセッション', 312],
    ['夜明けのチルギター', 245],
    ['静かなライブラリBGM', 420]
  ];
  store.Apply({
    type: 'add-videos',
    playlistId: mainId,
    videos: mainSongs.map(([title, duration], i) => ({ url: bv(i + 1), title, duration }))
  });
  // 存在するローカル曲とリンク切れローカル曲を模擬追加する
  fs.mkdirSync(store.media, { recursive: true });
  fs.writeFileSync(path.join(store.media, 'acoustic-demo.m4a'), Buffer.alloc(128));
  const mainList = store.data.playlists.find(p => p.id === mainId);
  mainList.entries.push(
    { id: randomUUID(), type: 'local', fileName: 'acoustic-demo.m4a', title: 'ローカル録音サンプル.m4a', duration: 196, addedAt: new Date().toISOString() },
    { id: randomUUID(), type: 'local', fileName: 'sample-missing.mp3', title: 'リンク切れ確認用トラック.mp3', duration: 142, addedAt: new Date().toISOString() }
  );
  store.Save();

  const make = (name, parentId = null) => {
    store.Apply({ type: 'create', name, parentId });
    return store.data.activePlaylistId;
  };
  const addTracks = (playlistId, list) => store.Apply({
    type: 'add-videos',
    playlistId,
    videos: list.map(([n, title, duration]) => ({ url: bv(n), title, duration }))
  });

  const work = make('作業用BGM');
  addTracks(work, [
    [10, '集中できる環境音とピアノ', 640],
    [11, 'コーディング用シンセウェーブ', 388]
  ]);

  const focus = make('集中・ピアノ', work);
  addTracks(focus, [
    [12, 'Deep Focus Piano', 510],
    [13, '夜のクラシックメドレー', 840]
  ]);

  const exam = make('深夜の勉強用', focus);
  addTracks(exam, [[14, 'ノイズカット・アンビエント 8時間', 28800]]);

  const relax = make('Lo-fi・リラックス', work);
  addTracks(relax, [[15, '夜の海辺 Lo-fi', 274]]);

  const game = make('ゲーム音楽');
  addTracks(game, [
    [16, 'フィールド曲オーケストラアレンジ', 345],
    [17, 'ボス戦バトルテーマ総集編', 492]
  ]);

  const excluded = make('全体再生から外したリスト');
  addTracks(excluded, [[18, '効果音・ラジオ切り抜き', 185]]);
  store.Apply({ type: 'playlist-properties', playlistId: excluded, includeInAll: false });

  make('空のリスト');

  store.Apply({
    type: 'settings',
    settings: {
      mediaKeysEnabled: true,
      titleCleanupWords: ['【歌ってみた】', '純k投屏', 'ニコカラ'],
      discordEnabled: true,
      discordClientId: '123456789012345678',
      discordImageKey: 'favecus_player_music',
      releaseDriveURL: 'https://drive.google.com/drive/folders/demo-favecus-releases',
      volume: 0.85
    }
  });
  store.Apply({ type: 'select', playlistId: work });

  return { store, workId: work, focusId: focus, examId: exam, mainId };
}

function BuildStatsMock() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  const playPattern = [14, 22, 19, 31, 27, 35, 29, 44, 38, 52, 47, 63];
  const secPattern = [1800, 3240, 2760, 4920, 4140, 6120, 5100, 7980, 6840, 9600, 8700, 11820];
  const months = [];
  let total = 0;
  let totalSeconds = 0;
  for (let i = 0; i < 12; i++) {
    const idx = year * 12 + month - (11 - i);
    const y = Math.floor(idx / 12);
    const m = ((idx % 12) + 12) % 12 + 1;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const plays = playPattern[i];
    const seconds = secPattern[i];
    total += plays;
    totalSeconds += seconds;
    months.push({ month: key, plays, seconds });
  }
  return {
    total,
    totalSeconds,
    months,
    thisMonthTop: [
      { title: '朝のピアノ（作業用セレクト）', count: 19 },
      { title: 'Deep Focus Piano', count: 14 },
      { title: 'コーディング用シンセウェーブ', count: 11 },
      { title: '夜の海辺 Lo-fi', count: 9 }
    ],
    top: [
      { title: '朝のピアノ（作業用セレクト）', count: 84 },
      { title: 'Deep Focus Piano', count: 67 },
      { title: '雨の日のジャズセッション', count: 52 },
      { title: 'コーディング用シンセウェーブ', count: 48 },
      { title: 'フィールド曲オーケストラアレンジ', count: 41 },
      { title: '夜明けのチルギター', count: 35 }
    ]
  };
}

function MakeMockPreviewJs(demoIds) {
  const statsData = BuildStatsMock();
  return `'use strict';
(() => {
  const listeners = new Set();
  const previewViews = {};
  const demoIds = ${JSON.stringify(demoIds)};
  const statsData = ${JSON.stringify(statsData)};

  const makeArtwork = (seedText, variant) => {
    let h = 0;
    for (const c of String(seedText || 'favecus')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const cover = variant === 'cover';
    const canvas = document.createElement('canvas');
    canvas.width = cover ? 300 : 128;
    canvas.height = cover ? 300 : 72;
    const g = canvas.getContext('2d');
    const hue = h % 360;
    const grad = g.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, \`hsl(\${hue} 68% 52%)\`);
    grad.addColorStop(1, \`hsl(\${(hue + 55) % 360} 65% 28%)\`);
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.beginPath();
    g.arc(canvas.width * 0.78, canvas.height * 0.25, canvas.height * 0.34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.font = cover ? 'bold 84px sans-serif' : 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♫', canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL(cover ? 'image/jpeg' : 'image/png', 0.88);
  };

  const post = async (name, ...args) => {
    const response = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  let preferSaved = true;
  let outputDevice = '';
  let autoListSettings = {
    limits: { frequent: 50, recent: 50, unplayed: 200, favorites: 200, history: 100 },
    frequentMin: 1,
    recentDays: 0
  };
  const demoSync = {
    url: 'https://demo-project.supabase.co',
    enabled: true,
    configured: true,
    signedIn: true,
    email: 'demo@example.com',
    encryption: true,
    state: 'idle',
    error: '',
    lastSyncAt: Date.now() - 1800 * 1000,
    pending: 0,
    conflicts: 0
  };

  window.__demoEmit = event => {
    for (const cb of listeners) cb(event);
  };
  window.__demoMakeArtwork = makeArtwork;

  window.favecusApp = {
    state: () => post('state'),
    action: action => post('action', action),
    entryThumbnail: async (playlistId, entryId, scope, variant) => makeArtwork(entryId, variant),
    accounts: async () => ({ bilibili: { loggedIn: true, name: 'Favecus Demo' } }),
    listViewSet: async (id, view) => {
      const EV = window.FavecusEntryView;
      const v = EV.Normalize(view);
      if (!EV.IsActive(v)) delete previewViews[id];
      else previewViews[id] = v;
      return previewViews[id] || null;
    },
    listStats: async id => {
      const result = {};
      const data = (await post('state')).state;
      const list = data.playlists.find(p => p.id === id);
      (list ? list.entries : []).forEach((entry, i) => {
        result[entry.id] = { count: (i * 7 + 3) % 15, favorite: i % 2 === 0, saved: i % 2 === 0 };
      });
      return result;
    },
    favorite: async (playlistId, entryId, value) => value ? [entryId] : [],
    favoriteMany: async (refs, value) => value ? refs.map(r => r.entryId) : [],
    autoList: async kind => {
      if (!kind) return { frequent: 12, recent: 14, unplayed: 3, favorites: 5, history: 9 };
      return [
        { id: demoIds.firstEntryId || 'e1', title: '朝のピアノ（作業用セレクト）', count: 19 },
        { id: demoIds.secondEntryId || 'e2', title: 'Deep Focus Piano', count: 14 }
      ];
    },
    autoListSettings: async next => {
      if (next) autoListSettings = { ...autoListSettings, ...next };
      return autoListSettings;
    },
    clearHistory: async () => true,
    stats: async () => statsData,
    audit: async () => ({
      checked: 15,
      duplicates: [
        {
          playlistId: demoIds.mainId,
          playlistName: 'お気に入りの曲',
          title: '朝のピアノ（作業用セレクト）',
          entries: [
            { id: 'dup-1', title: '朝のピアノ（作業用セレクト）' },
            { id: 'dup-2', title: '朝のピアノ（作業用セレクト） [別登録]' }
          ]
        }
      ],
      missing: [
        {
          playlistId: demoIds.mainId,
          playlistName: 'お気に入りの曲',
          entryId: demoIds.missingEntryId || 'miss-1',
          title: 'リンク切れ確認用トラック.mp3',
          fileName: 'sample-missing.mp3'
        }
      ]
    }),
    outputGet: async () => outputDevice,
    outputSet: async name => { outputDevice = name || ''; return outputDevice; },
    trashList: async () => [
      { id: 'trash-1', label: '懐かしの作業用ミックス（プレイリスト）', deletedAt: Date.now() - 2 * 86400000, daysLeft: 28 },
      { id: 'trash-2', label: '雨が止むまで（曲）', deletedAt: Date.now() - 5 * 86400000, daysLeft: 25 }
    ],
    trashRestore: async () => [],
    trashDelete: async () => [],
    trashClear: async () => [],
    notesGet: async () => ({
      identified: true,
      record: {
        artist: 'Favecus Composer',
        tags: ['ピアノ', '作業用BGM', '高音質'],
        memo: '集中作業に向いている静かなピアノ曲です。',
        chapterText: '0:00 イントロ\\n1:15 Aメロ\\n2:40 サビ\\n3:45 アウトロ',
        chapters: [
          { at: 0, title: 'イントロ' },
          { at: 75, title: 'Aメロ' },
          { at: 160, title: 'サビ' },
          { at: 225, title: 'アウトロ' }
        ]
      }
    }),
    notesSet: async () => true,
    downloads: async () => post('downloads'),
    estimateDownload: async () => ({
      id: 'est-demo-1',
      total: 6,
      skipped: 2,
      checked: 6,
      projected: false,
      unknown: 0,
      fileBytes: 185 * 1048576,
      requiredBytes: 240 * 1048576,
      freeBytes: 128 * 1073741824,
      secondsMin: 18,
      secondsMax: 42,
      failures: []
    }),
    cancelDownloadEstimate: async () => {},
    preferSaved: async value => {
      preferSaved = value !== false;
      const dl = await post('downloads');
      return { ...dl, preferSaved };
    },
    downloadPlaylist: async () => post('downloads'),
    cancelDownload: async () => post('downloads'),
    downloadDirectory: async () => post('downloads'),
    openDownloads: async () => {},
    resolveURL: async url => ({
      kind: 'video',
      video: { videoId: 'BV1aaaaaaaa1', part: 1, title: 'サンプル取得動画タイトル', url },
      sources: []
    }),
    sync: async command => {
      if (command?.action === 'disable') Object.assign(demoSync, { enabled: false, state: 'off' });
      else if (command?.action === 'enable') Object.assign(demoSync, { enabled: true, state: 'idle', lastSyncAt: Date.now() });
      else if (command?.action === 'now') demoSync.lastSyncAt = Date.now();
      return { ...demoSync };
    },
    volume: async value => value,
    speed: async value => {
      window.__demoEmit({ type: 'speed', value });
      return value;
    },
    sleepTimer: async () => ({ mode: 'minutes', minutes: 30, deadline: Date.now() + 30 * 60000 }),
    bounds: () => {},
    onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    entryDuration: async () => 240,
    resetPlayCounts: async () => true,
    saveSelected: async () => ({}),
    moveTracks: async () => ({ state: (await post('state')).state, mappings: [] }),
    queueReorder: async () => {},
    queueJump: async () => {},
    queueInsert: async () => {},
    play: async () => {},
    shufflePlay: async () => {},
    playEverything: async () => {},
    autoPlay: async () => {},
    resumeLast: async () => {},
    shortcut: async () => {},
    command: async () => {},
    prepareAdd: async () => ({ additions: [], duplicates: [], skipped: [] }),
    prepareFiles: async () => ({ additions: [], duplicates: [], skipped: [] }),
    prepareFolder: async () => ({ additions: [], duplicates: [], skipped: [] }),
    commitAdd: async () => (await post('state')).state,
    cancelAdd: async () => {},
    exportLibrary: async () => null,
    importLibrary: async () => null,
    cancelImport: async () => {},
    commitImport: async () => ({ state: (await post('state')).state, imported: 0 }),
    transferEntry: async () => {},
    browseBilibili: async () => {},
    openOfficial: async () => {},
    help: async () => {},
    discordPortal: async () => {},
    discordGuide: async () => {},
    discordImage: async () => {},
    taskbarGuide: async () => {},
    taskbarLog: async () => {},
    openRelease: async () => {},
    login: async () => {},
    favoriteFolders: async () => [],
    favoriteVideos: async () => ({ videos: [], hasMore: false }),
    mini: async () => {}
  };
})();
`;
}

function StartServer(store, demoIds) {
  const workEntries = store.data.playlists.find(p => p.id === demoIds.workId)?.entries || [];
  const mainEntries = store.data.playlists.find(p => p.id === demoIds.mainId)?.entries || [];
  const available = [
    ...workEntries.slice(0, 1).map(e => ({ url: e.url, kind: 'video' })),
    ...workEntries.slice(1, 2).map(e => ({ url: e.url, kind: 'audio' })),
    ...mainEntries.slice(0, 2).map(e => ({ url: e.url, kind: 'audio' }))
  ];
  const mockPreview = MakeMockPreviewJs({
    ...demoIds,
    firstEntryId: workEntries[0]?.id,
    secondEntryId: mainEntries[0]?.id,
    missingEntryId: mainEntries.find(e => e.fileName === 'sample-missing.mp3')?.id
  });
  const downloadsPayload = {
    directory: 'C:\\Users\\Demo\\Music\\FavecusPlayer',
    preferSaved: true,
    available,
    job: null
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && reqUrl.pathname === '/api') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { name, args } = JSON.parse(body);
        let value = null;
        if (name === 'state') {
          const favIds = workEntries.map(e => e.id);
          value = {
            state: store.Snapshot(),
            version: `${PKG.version} preview`,
            statuses: {
              discord: { code: 'connected', text: 'Discord Rich Presence に接続済み（模擬）' },
              taskbar: { code: 'off', text: '下向き矢印を押すと埋め込みを試します' }
            },
            current: null,
            playback: null,
            thumbnail: null,
            queue: null,
            foreground: true,
            accounts: { bilibili: { loggedIn: true, name: 'Favecus Demo' } },
            sleep: { mode: 'off' },
            speed: 1,
            listViews: {},
            resume: null,
            favorites: favIds,
            downloads: downloadsPayload,
            platform: 'win32'
          };
        } else if (name === 'action') {
          value = store.Apply(args[0]);
        } else if (name === 'downloads') {
          value = downloadsPayload;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, value }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (reqUrl.pathname === '/preview.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(mockPreview);
      return;
    }

    const rel = decodeURIComponent(reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname.slice(1)).replace(/^\/+/, '');
    const safeUi = path.resolve(UI_ROOT, rel);
    const safeBuild = path.resolve(BUILD_ROOT, rel);
    let filePath = null;
    if (safeUi.startsWith(UI_ROOT + path.sep) && fs.existsSync(safeUi) && fs.statSync(safeUi).isFile()) {
      filePath = safeUi;
    } else if (['icon.png', 'music.png'].includes(rel) && safeBuild.startsWith(BUILD_ROOT + path.sep) && fs.existsSync(safeBuild)) {
      filePath = safeBuild;
    }
    if (!filePath) {
      res.writeHead(404).end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
          : ext === '.svg' ? 'image/svg+xml'
            : ext === '.png' ? 'image/png'
              : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }).end(fs.readFileSync(filePath));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function WaitForTarget(debugPort, chromeExit) {
  const deadline = Date.now() + 20000;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (chromeExit.code !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
        lastErr = `targets=${list.length}`;
      } else {
        lastErr = `http=${res.status}`;
      }
    } catch (e) {
      lastErr = e.cause?.code || e.message;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Chrome DevTools target の起動がタイムアウトしました (exitCode=${chromeExit.code}, lastErr=${lastErr}, head=${chromeExit.head}, tail=${chromeExit.stderr.slice(-800)})`);
}

function ConnectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const pageErrors = [];

    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
      resolve({ ws, send, pageErrors });
    });
    ws.addEventListener('error', err => reject(err.error || new Error('WebSocket error')));
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message || JSON.stringify(msg.error)));
        else ok(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Runtime exception';
        pageErrors.push(text);
      }
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function Eval(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluation failed';
    throw new Error(`CDP eval error: ${desc}`);
  }
  return res.result?.value;
}

async function WaitFor(cdp, predicateExpr, timeoutMs = 8000) {
  const ok = await Eval(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const tick = () => {
      try { if (${predicateExpr}) return resolve(true); } catch {}
      if (Date.now() > deadline) return reject(new Error('WaitFor timeout: ' + ${JSON.stringify(predicateExpr)}));
      setTimeout(tick, 40);
    };
    tick();
  })`);
  return ok;
}

async function Snap(cdp, outDir, name, waitMs = 280) {
  await Eval(cdp, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await sleep(waitMs);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  process.stdout.write(`captured ${name}.png\n`);
}

async function SetViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function RunCapture(outDir, chromePath) {
  fs.mkdirSync(outDir, { recursive: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-pc-store-'));
  const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-pc-chrome-'));
  const { store, workId, focusId, examId, mainId } = BuildDemoStore(storeDir);
  const { server, port } = await StartServer(store, { workId, focusId, examId, mainId });
  const debugPort = await FreePort();

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    '--window-size=1280,960',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const chromeExit = { code: null, head: '', stderr: '' };
  chrome.stderr?.on('data', chunk => {
    const s = String(chunk);
    if (chromeExit.head.length < 1500) chromeExit.head = (chromeExit.head + s).slice(0, 1500);
    chromeExit.stderr = (chromeExit.stderr + s).slice(-4000);
  });
  chrome.once('exit', code => { chromeExit.code = code ?? -1; });

  let cdp = null;
  try {
    const wsUrl = await WaitForTarget(debugPort, chromeExit);
    cdp = await ConnectCDP(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await SetViewport(cdp, 1280, 800);

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` });
    await Eval(cdp, `new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        if (typeof state === 'object' && state && document.querySelectorAll('#playlists .tree-row').length > 0) return resolve(true);
        if (Date.now() > deadline) return reject(new Error('UI initialization timeout'));
        setTimeout(check, 60);
      };
      check();
    })`);

    // 1. ホーム画面
    await Eval(cdp, `$('all-lists').click();`);
    await WaitFor(cdp, `allListsView && document.querySelectorAll('.home-card').length > 0`);
    await Snap(cdp, outDir, '01-home', 450);

    // 2. ホーム全曲検索結果
    await Eval(cdp, `$('home-query').value = 'ピアノ'; $('home-query').dispatchEvent(new Event('input'));`);
    await WaitFor(cdp, `document.querySelectorAll('.home-result').length > 0`);
    await Snap(cdp, outDir, '02-home-search', 400);
    await Eval(cdp, `$('home-search-clear').click();`);

    // 3. プレイリスト画面（階層と子プレイリストあり）
    await Eval(cdp, `OpenPlaylist(${JSON.stringify(workId)})`);
    await WaitFor(cdp, `!allListsView && ($('list-title')?.textContent || '').includes('作業用BGM')`);
    await Snap(cdp, outDir, '03-playlist', 450);

    // 4. 再生中状態＋「次に再生」タイムライン展開（保存ボタン削除後）
    await Eval(cdp, `(() => {
      const list = state.playlists.find(p => p.id === ${JSON.stringify(workId)});
      const cur = list.entries[0];
      const nextEntry = list.entries[1];
      const mainList = state.playlists.find(p => p.id === ${JSON.stringify(mainId)});
      window.__demoEmit({
        type: 'current',
        value: {
          source: 'bilibili',
          queuePlaylistId: ${JSON.stringify(workId)},
          playlistId: ${JSON.stringify(workId)},
          entryId: cur.id,
          entry: cur,
          pageMode: false,
          officialPlayer: false,
          offline: { kind: 'audio', height: null }
        }
      });
      window.__demoEmit({
        type: 'thumbnail',
        value: { image: window.__demoMakeArtwork(cur.id, 'cover'), pending: false }
      });
      window.__demoEmit({
        type: 'playback',
        value: { position: 62, duration: 640, paused: false, title: cur.title, artist: 'Favecus Composer' }
      });
      window.__demoEmit({
        type: 'queue',
        value: {
          playlistId: ${JSON.stringify(workId)},
          name: list.name,
          repeat: 'off',
          next: { index: 2, playlistId: ${JSON.stringify(workId)}, title: nextEntry.title },
          timeline: {
            history: [{ id: mainList.entries[0].id, playlistId: ${JSON.stringify(mainId)}, title: mainList.entries[0].title }],
            current: { id: cur.id, playlistId: ${JSON.stringify(workId)}, title: cur.title },
            upcoming: [
              { id: nextEntry.id, playlistId: ${JSON.stringify(workId)}, title: nextEntry.title },
              { id: mainList.entries[1].id, playlistId: ${JSON.stringify(mainId)}, title: mainList.entries[1].title },
              { id: mainList.entries[2].id, playlistId: ${JSON.stringify(mainId)}, title: mainList.entries[2].title }
            ]
          }
        }
      });
      if (!timelineOpen) $('up-next-toggle').click();
    })()`);
    await WaitFor(cdp, `!$('up-next').classList.contains('hidden') && !$('queue-timeline').classList.contains('hidden')`);
    await Snap(cdp, outDir, '04-playlist-playing', 400);
    await Eval(cdp, `if (timelineOpen) $('up-next-toggle').click();`);

    // 5. 複数選択モード
    await Eval(cdp, `(() => {
      SetSelectionMode(true);
      const checks = document.querySelectorAll('#entries .entry-check');
      if (checks[0]) checks[0].click();
      if (checks[1]) checks[1].click();
    })()`);
    await Snap(cdp, outDir, '05-playlist-select', 350);
    await Eval(cdp, `SetSelectionMode(false);`);

    // モーダル群は内容全体を見やすくするため高さを 960 に拡張する
    await SetViewport(cdp, 1280, 960);
    const closeModal = `if ($('modal').open) CloseModal();`;

    // 6. 曲の表示モーダル
    await Eval(cdp, `ViewSettings();`);
    await WaitFor(cdp, `$('modal').open && $('modal-title').textContent.includes('並べ替え')`);
    await Snap(cdp, outDir, '06-view-options', 250);
    await Eval(cdp, closeModal);

    // 7. URLから追加モーダル
    await Eval(cdp, `AddURL();`);
    await WaitFor(cdp, `$('modal').open && $('modal-title').textContent.includes('URLから追加')`);
    await Snap(cdp, outDir, '07-add-url', 250);
    await Eval(cdp, closeModal);

    // 8. 動画・音声の保存モーダル
    await Eval(cdp, `DownloadsDialog();`);
    await WaitFor(cdp, `$('modal').open && ($('download-estimate')?.textContent || '').includes('追加の保存容量')`);
    await Snap(cdp, outDir, '08-downloads', 250);
    await Eval(cdp, closeModal);

    // 9. 曲の情報モーダル
    await Eval(cdp, `(() => {
      const list = state.playlists.find(p => p.id === ${JSON.stringify(workId)});
      return SongInfoDialog(${JSON.stringify(workId)}, list.entries[0]);
    })()`);
    await WaitFor(cdp, `$('modal').open && $('modal-title').textContent.includes('曲の情報')`);
    await Snap(cdp, outDir, '09-song-info', 250);
    await Eval(cdp, closeModal);

    // 10. 設定・連携トップ
    await Eval(cdp, `Settings();`);
    await WaitFor(cdp, `$('modal').open && $('modal-title').textContent.includes('設定・連携') && ($('bili-account-state')?.textContent || '').includes('ログイン済み')`);
    await Snap(cdp, outDir, '10-settings', 250);

    // 11. キーコンフィグ（メディアキー ON/OFF 含む）
    await Eval(cdp, `KeySettings();`);
    await WaitFor(cdp, `$('modal').open && !!$('media-keys-enabled')`);
    await Snap(cdp, outDir, '11-settings-keys', 250);

    // 12. 再生統計（上部）
    await Eval(cdp, `StatsSettings();`);
    await WaitFor(cdp, `$('modal').open && $('modal-title').textContent.includes('再生統計') && !!$('stat-all')`);
    await Snap(cdp, outDir, '12-settings-stats', 300);

    // 12b. 再生統計（月ごとの再生時間グラフ）
    await Eval(cdp, `(() => {
      const modal = $('modal');
      const heading = [...modal.querySelectorAll('.stat-heading')].find(h => h.textContent.includes('再生時間'));
      if (heading) modal.scrollTop = Math.max(0, heading.offsetTop - 90);
      else modal.scrollTop = modal.scrollHeight / 2;
    })()`);
    await Snap(cdp, outDir, '12b-settings-stats-time', 250);

    // 13-24. その他の設定モーダル一式
    const modals = [
      ['13-settings-playback', 'PlaybackSettings()', `$('modal').open && !!$('playback-source')`, 250],
      ['14-settings-discord', 'DiscordSettings()', `$('modal').open && !!$('discord-enabled')`, 250],
      ['15-settings-taskbar', 'TaskbarSettings()', `$('modal').open && !!$('taskbar-embed')`, 250],
      ['16-settings-sync', 'SyncSettings()', `$('modal').open && ($('sync-state')?.textContent || '').includes('同期：')`, 250],
      ['17-settings-autolist', 'AutoListSettings()', `$('modal').open && !!$('auto-min')`, 250],
      ['18-settings-audit', 'AuditSettings()', `$('modal').open && ($('modal-body')?.textContent || '').includes('重複')`, 250],
      ['19-settings-output', 'OutputSettings()', `$('modal').open && !!$('output-select')`, 250],
      ['20-settings-trash', 'TrashSettings()', `$('modal').open && ($('modal-body')?.textContent || '').includes('懐かしの')`, 250],
      ['21-settings-transfer', 'Transfer()', `$('modal').open && !!$('export-information')`, 250],
      ['22-settings-words', 'TitleWordsSettings()', `$('modal').open && !!$('title-word-list')`, 250],
      ['23-settings-shuffle', 'ShuffleSettings()', `$('modal').open && !!$('weighted-shuffle')`, 250],
      ['24-settings-release', 'ReleaseSettings()', `$('modal').open && !!$('release-drive-url')`, 250]
    ];
    for (const [name, expr, readyPred, waitMs] of modals) {
      await Eval(cdp, expr);
      await WaitFor(cdp, readyPred);
      await Snap(cdp, outDir, name, waitMs);
    }

    await Eval(cdp, closeModal);
    if (cdp.pageErrors.length) {
      throw new Error(`画面実行中にJSエラーが発生しました:\n${cdp.pageErrors.join('\n')}`);
    }
    process.stdout.write(`done: 25 screenshots saved in ${outDir}\n`);
  } finally {
    try { cdp?.ws?.close(); } catch {}
    await new Promise(resolve => {
      if (chrome.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 2000);
      chrome.once('exit', () => { clearTimeout(timer); resolve(); });
      try { chrome.kill(); } catch { clearTimeout(timer); resolve(); }
    });
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
  }
}

async function VerifyServerOnly() {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-pc-srv-'));
  const { store, workId, focusId, examId, mainId } = BuildDemoStore(storeDir);
  const { server, port } = await StartServer(store, { workId, focusId, examId, mainId });
  try {
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${base}/index.html`)).text();
    const preview = await (await fetch(`${base}/preview.js`)).text();
    const apiRes = await (await fetch(`${base}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'state', args: [] })
    })).json();
    if (!html.includes('Favecus Player') || !preview.includes('window.favecusApp') || !apiRes.ok || !apiRes.value?.state?.playlists?.length) {
      throw new Error('サーバー応答の検証に失敗しました。');
    }
    process.stdout.write(`server OK: playlists=${apiRes.value.state.playlists.length}, version=${apiRes.value.version}\n`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch {}
  }
}

async function Main() {
  if (process.argv.includes('--verify-server')) return VerifyServerOnly();
  const { out, chrome } = ParseArgs(process.argv.slice(2));
  const chromePath = FindChrome(chrome);
  await RunCapture(out, chromePath);
}

Main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

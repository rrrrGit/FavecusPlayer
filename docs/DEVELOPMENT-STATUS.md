# FavecusPlayer 開発状況

更新日：2026-11-26（日本時間）
対象：v0.7.6（開発中） / `release/v0.7.6`（`main` の v0.7.5 マージ `8e6dd79` から作成）
現在地：v0.7.5 は Release 公開・`main` 統合済み。`release/v0.7.6` にて全体再スキャンに基づく全領域（共通コア・同期・PC Main/IPC/Preload/UI/CI・iPhone Playback/Alarm/Downloads/Bilibili/Library/Sync/UI・ドキュメント）の不具合・競合・性能・保守性の是正および `README.md` の `0.7.5` 更新を実施。持ち越し：macOS/Xcode CI での Swift コンパイル・XCTest 確認、Windows実機での更新（特に0.6.6から）・動作の確認、iPhone実機の確認（アラーム・F1〜F5）、同期の見直し（D）、サムネイルの統一（E2）、E1（動画のみ保存の失敗3本。失敗の文待ち）、v0.7.6 リリース時のバージョン更新・配布物生成。

## v0.7.6 全体再スキャン是正記録（2026-11-26）
- **共通コア・同期・ZIP/DL**：`Store.Save()` の 32MB 上限検証・`.bak` 原子的置換・`Read()` 退避の例外保護・重複 `structuredClone` 削減、`OfflineLibrary.AtomicJSON` / `offline-migration.cjs` の `finally` 内 `rmSync` 保護と別画質再保存時の既存サムネイル引き継ぎ、`LoudnessStore` 読込検証、`FavoriteStore` / `HistoryStore` の `SyncApply` 保存失敗時例外化、`AdditionReview.Commit()` の `lastAddedAt` 更新、`SyncService.SignOut()` の世代保護、`SyncRuntime.Cycle()` → `SyncExtras` への `isAborted` 伝播、`SyncSession.Unblock('restore')` の `applying` 保護、`SupabaseSyncRepository` のページング上限エラー化と `Compact()` 1トランザクション化、`SyncHistoryBlock` の `PullHistory` 後 `GetHistoryState` 再確認、`play-ledger.cjs` / `favorites-core.cjs` の $O(N)$ 化、`PlayCounts` のエイリアスキャッシュ、`LibraryArchive` 4GB展開上限解除、`ZipReader.Content()` 失敗時削除、`Thumbnails.Frame()` の `page` 一致優先、`MediaResponse` 拡張子小文字化、`bilibili-download.cjs` HTTP 403 `stopBatch` 統一。
- **PC版 Main / IPC / Preload / Scripts / CI**：`StartShuffled` / `Step` / `queue:jump` の `LoadEntry` 失敗時ロールバック、`MakeView` `dom-ready` の `MatchesCurrentURL` 許容、`SetVolume` と `SyncPlayerExtras` 分離、`media:state` / `library:duration` の `duration` 保存失敗時ロールバック、`CloseView()` `frameChecks` クリア、`presenceTimer` 解放、`before-quit` 重複抑止、`OpenAccount` 破棄チェック、`QueueState` 安全参照、`trash:restore` `Remove` 失敗通知、`queue:reorder`/`queue:insert` の `Emit` 統一、`filePaths?.[0]` チェック統一、`media.cjs` 100ms タイマー不要時停止、`mini.cjs` 解除関数返却、`install-core.cjs` `keepStage` 保護、`audit-release.py` 現行データファイル追加、`build-windows.py` `as_posix()`、`ios.yml` に `permissions: contents: read`・Node `24.20.0`・`release/v*` 統一、`package.json` `test` スクリプト整理。
- **PC版 UI**：`ImportSelection` の `modalEpoch` 先行検証、`ExistingMenu` の `SendBounds()` 連動とフォーカス復元、`KeySettings` の `Tab`/`Escape` 通過、グローバル `Space`/`Enter` のボタン・メニュー除外、サイドバー幅スライダーの `oninput` CSS 更新＋`onchange` 保存、`ViewStatsFor` 世代トークン管理、`EntryMenu` からの `SongInfoDialog` 直接遷移、`Bulk` 選択同期・`BulkFavorite` 再描画・`aria-live`、`StatsSettings` の `.textContent` 統一、`RenderEntries`/`ExistingTracks` 一括 DOM 挿入、`Alt+↑/↓` フォーカス復元、`home-view.js` リスナー解除、`tree-view.js` スクロール位置復元、`RenderPlayer` サムネイル検証、`style.css` 1280px以下 `.entry.selecting` 列定義修正・`mini.css` エラー重なり解消。
- **iPhone版**：`PlaybackEngine` の `crossfadePending` 確実解除・`countsBeginTask` 順序保証・`queueSyncSerial` 競合防止・`seek()` 跳ね解消・`levelingTask` キャンセル・`goNext()` `restoredPending` 解除、`PlayerBackend` クロスフェード速度引き継ぎと `isPlaying` `timeControlStatus` 判定、`FullPlayerView` `GeometryReader` 化と二重 `AVPlayerLayer` 回避、`VideoSurface` 弱参照化、`SystemAudio` `deinit` コマンド解除、`FavecusPlayerApp`/`LibraryViews` 起動順で `downloads.start()` を先行、`BilibiliAccount` `authGeneration` 保護、`BiliCore`/`SyncCore` の `[weak self]`・キャンセル対応・`isAborted` 連携、`BilibiliCookieVault`/`KeychainVault` ロック保護、`BackgroundTransfers` 完全ロック・`taskIdentifier` 単位 `restarting`・`totals` 復元、`DownloadService` `reconcile`/`save`/`cancelAll`/`fetchOnline` 是正、`MediaDownloader` ホスト名統一、`MediaProcessor`/`AlarmSoundMaker` キャンセル対応、`AlarmService` 保存失敗通知・ランダム二重生成解消・孤立 `.caf` 掃除、`AlarmSoundViews` `file(forKey:)` 高速化と試聴セッション設定、`ArtworkStore` `session.download` 化と `NSCache` 上限、`SyncCoordinator` `enable`/`unblock`/`storeChanged` 排他と `signOut` エラークリア、`SyncViews` 文言整合と URL 変更検知、`PlayCountStore`/`PlayHistoryStore` 保存失敗ロールバック・UUID 退避名、`TrashStore` ファイル保護、`LoudnessCache` 初期化トリム、`OtherTabs` `downloads.message` 表示、`AddSongSheet` エラー表示、`PlaylistDetailView` 一括対象統一、`SwipeBackEnabler` インスタンス化、`PlaylistIcon` キャッシュ。
- **ドキュメント**：`README.md` を現行最新バージョン `0.7.5` へ更新、`docs/BUILD.md` のバージョン更新チェックリストを補完。
- **テスト整理**：重複テスト・バージョン別回帰ファイル（`bugfix-075` / `bugfix-075-2` / `bugfix-076` / `notice-layout`）・小規模ファイル群を機能ドメイン別（`queue.test.cjs` / `player-runtime.test.cjs` / `ui-components.test.cjs` / `infra.test.cjs` / `library-app.test.cjs` / `ui-regression.test.cjs` 等）へ統合し、同一ファイル内の細分化ケースもカバレッジを保ったまま集約。Node テストは **93ファイル → 68ファイル（-25）**、実行件数 **778件 → 678件（-100）** に整理。
- **検証**：`node scripts/build-shared-bundle.cjs`、`node scripts/check.cjs`（214 JS files OK）、`node --test --test-concurrency=4 test/*.test.cjs`（678件中 665成功・0失敗・13環境依存スキップ）。Swift コンパイル・XCTest は `release/v0.7.6` Push 後の GitHub Actions で検証予定。

## v0.7.6 稼働履歴・日次0:00 Supabase同期追加（2026-11-27）
- **目的**：v0.7.5 実機で発生した「平日 9:05 設定のアラームが 14:30 頃にも AlarmKit 画面付きで鳴動した事象」の事後追跡のため、アプリ稼働履歴（7日保持・個人データ除外）と日次 0:00 同期を追加。
- **変更内容**：
  - **Supabase・共通JS**：`supabase/schema.sql` に `sync_activity_logs` テーブル（`user_id`, `device_id`, `day`, `entries`, `updated_at`・RLS）を追加。`src/core/sync-supabase.cjs`（`PushActivityLogs`）・`src/core/sync-runtime.cjs`・`shared/runtime/fixture-runner.js`・`scripts/build-shared-bundle.cjs`・`test/fake-supabase.cjs`・`test/sync-supabase.test.cjs` へ日単位 upsert＋7日超削除を実装。
  - **iPhone版**：`ios/FavecusPlayer/Sync/ActivityLogStore.swift`（`activity-logs.json` 7日保持・1日300件上限・破損時退避）、`AlarmScheduler.swift`（`scheduledSnapshots()`）・`AlarmService.swift`（`save`/`remove`/`resync` のOS予約状態含む記録）、`SyncCoordinator.swift`（0:00 フォアグラウンドタイマー・起動/復帰時未送信キャッチアップ・`SyncPushActivityLogs` 呼び出し）、`FavecusPlayerApp.swift`（起動/復帰/背面移行/再生依頼、`BGAppRefreshTask` `dev.favecus.player.activity-sync`）、`ios/project.yml`（`UIBackgroundModes: fetch`・`BGTaskSchedulerPermittedIdentifiers`）、`ios/FavecusPlayerTests/ActivityLogTests.swift` を追加。
- **検証**：`node scripts/build-shared-bundle.cjs`、`node scripts/check.cjs`（214 JS files OK）、`node --test test/sync-supabase.test.cjs test/sync-runtime.test.cjs`（25/25 成功）。未検証：macOS/Xcode での Swift コンパイル・`ActivityLogTests` 実行、実機での `BGAppRefreshTask`・実 Supabase（利用者は `supabase/schema.sql` の再実行が必要）。
v0.7.0〜v0.7.4（配布済み・main）の詳細工程・検証記録は [DEVELOPMENT-STATUS-ARCHIVE.md](DEVELOPMENT-STATUS-ARCHIVE.md) と docs/VALIDATION-067.md（v0.6.7分）にあります。

## v0.7.5 の開発記録（2026-11-22）
- **目的**：未再生・よく聴く曲・お気に入り（ハート）・最近聴いた曲が端末間で同期されない問題の解消。
- **変更内容**：
  - **共通JS・Supabase スキーマ**：`src/core/favorites-core.cjs`（LWW＋同値 `fav: true` 優先、`at: 1` 旧形式移行、お気に入り上限20000と解除履歴上限20000の分離、未来時刻 +10分クランプ）と `src/core/play-history.cjs` 同期対応（リモート履歴クリア時は Bilibili 曲のみ削除しローカル曲は残存）を追加。`supabase/schema.sql` に `sync_favorites*`・`sync_history*`・`sync_history_state`（ロック 13 / 17・未来時刻クランプ・RLS）を追加。`sync-counts.cjs` は `counts`・`favorites`・`history` を独立 `try/catch` で実行。
  - **PC版**：`FavoriteStore`・`HistoryStore`・`PlayCounts` を `SyncService` の `extras` および `ResetLink()`（cursor リセット）に接続し、変更時の `ScheduleExtras()` 自動予約、`applyingExtras` による再同期ループ抑止、ホーム自動リスト件数（`RefreshAutoLists`）・並び替えキャッシュ・`#sync-extras-notice` 表示を更新。
  - **iPhone版**：`FavoritesStore`・`PlayHistoryStore`・`PlayCountStore`・`SyncCore`・`StoreSyncHost`・`SyncCoordinator`（前面時のみ `scheduleExtras()`・`extrasNotice` 表示）・`SyncViews` を接続し、`PlaybackEngine.extrasRevision` 経由で自動リスト・並べ替え結果・再生統計・ハート表示を自動更新。
- **検証**：`node scripts/check.cjs`（233 JavaScript files: syntax OK）、`node --test --test-concurrency=4 test/*.test.cjs`（758件中 745成功・0失敗・13環境依存スキップ）、`checker-pro` レビュー実施。Swift コンパイル・XCTest は `release/v0.7.5` Push 後の GitHub Actions で検証、実機・実 Supabase 接続は未検証（利用者は `supabase/schema.sql` の再実行が必要）。

### v0.7.5 既存不具合・競合の是正（2026-11-22）
- **PC版・共通・Supabase・CI・ドキュメント**：
  - `src/ui/app/05-insights.js`：再生統計バーのインライン `style` 属性を廃止して `data-pct` + DOM `.style.width` 設定へ変更（CSP `style-src 'self'` 準拠）。`AutoListSettings`・`StatsSettings`・`AuditSettings`・`OutputSettings` に `Settings` 戻り先を設定。
  - `src/main.cjs`・`src/main/ipc-library.cjs`・`src/main/ipc-lists.cjs`：`ResumeOffer()` / `MiniState()` / `Command('toggle')` で `ArrangedEntries` を使い絞り込み後と一致させ、`SyncPlayingQueue()` 内で `'queue'` を Emit。`onApplied` / `RememberVideo` / 曲追加・移動・復元・取込後に `'favorites'` を Emit。
  - `src/core/favorites.cjs` / `src/core/play-time-store.cjs`：`FavoriteStore.SetMany` 追加（全キー事前検証＋1回原子保存＋失敗時ロールバック＋1回通知）および `PlayTimeStore.Flush()` の書込成功時限定 `dirty = false` 更新。
  - `src/ui/app/05-bulk.js` / `src/ui/app/06-list-view.js`：`SyncSelectionScope()` により別リスト移動・ホーム切替時に複数選択モードを自動解除。
  - `supabase/schema.sql` / `test/fake-supabase.cjs`：`sync_counts_before` で `UPDATE` 時に `new.n <= old.n` なら `seq` を加算せずスキップ。
  - `docs/DEVELOPMENT-STATUS.md` の NUL バイト 3 箇所除去、`.github/workflows/windows-build.yml` に `release/v0.7.5` 追加、`CLAUDE.md`・コメントの整合。
- **iPhone版**：
  - `LibraryModel.swift` / `DownloadService.swift` / `FavecusPlayerApp.swift`：`VideoAlias` を追加し、`aliasesProvider` 経由で `MediaKeys` へ `videoAliases` を供給。
  - `PlayCountStore.swift` / `PlaybackEngine.swift`：`observe(..., playbackRate:)` 導入、全 `PlayBegin`/`PlayStop`/`PlayObserve` を `playChain` で直列化し `ended == true` のドロップ防止、`load` 冒頭の停止/フラッシュ、`ended`/`prepareRestoredQueue` の `generation` 検証と絞り込み対応、`foregroundObserver` の `deinit` 解除を実装。
  - `LibraryStore.swift` / `StoreSyncHost.swift` / `SyncCoordinator.swift`：`syncWriting` フラグ廃止（`replaceLibrary(..., bySync:)`）、`sessionLock` 内の世代検証＋`vault` 原子操作（`invalidateSession`/`clearSession`/`setSession`/`saveSession`）で TOCTOU 解消、`cycle`・`catch` の有効状態再確認、`signOut` 時の `.syncing` 残留抑止、`resetLink` の `pendingReset` 直列化、`foreground` の `deinit` 解除を実装。
  - `BackgroundTransfers.swift`（削除済みジョブの `.err` 再作成防止）、`AtomicJsonFile.swift`（`.completeFileProtectionUntilFirstUserAuthentication` 統一）、`Insights.swift`（`play-history.broken-*` 退避と `PlayTimeStore.flush` の書込失敗時 `dirty` 維持）、`FavoritesStore.swift`（`preserved` 復元時の `maxKeys` 上限保護）、`PlayerBackend.swift`（クロスフェード `seek` 後の `ghost === outgoing` 確認）を是正。
- **検証**：`test/bugfix-075.test.cjs`・`ios/FavecusPlayerTests/` 5ファイルへ回帰テストを追加。`node scripts/check.cjs`（234 files: syntax OK）、`node --test --test-concurrency=2 test/*.test.cjs`（764件中 751成功・0失敗・13環境依存スキップ）、最終パッチ後の影響テスト群 96/96 成功、`checker-pro` レビューを実施（Swift ビルド・XCTest は `release/v0.7.5` Push 後の GitHub Actions で検証予定）。

### v0.7.5 第2弾修正・PC再生バー整理（2026-11-23）
- **PC版再生バー整理**：`src/ui/index.html`・`src/ui/style.css`・`src/ui/app/01-core.js`・`src/ui/app.js` でおやすみタイマー（`#sleep`）・再生速度（`#speed`）・停止（`#stop`）を 3点リーダー（`#transport-more`）内のメニュー（`#transport-menu`）へまとめ、音量バー（`#transport-volume`）を延長（通常 右列 236px / スライダー 150px、1280px以下 196px / 118px）。メニュー展開時は `SendBounds()` で BrowserView を非表示にし、外側クリック・`Escape`・`blur`・`OpenModal`・`#stop` で閉じる。
- **共通・Supabase・Sync是正**：`CanonicalMediaKey` による `bili-av` → `bili:BV` 合算（`play-ledger.cjs`・`play-counts.cjs`・`favorites-core.cjs`・`play-history.cjs`・`song-notes-store.cjs`・`library-app.cjs`）、`SyncRows` 自端末行限定、`PushCounts` 重複排除、`FakeServer` `21000` 重複検査および `sync_history_state` 未来時刻 `+599000` クランプ（`supabase/schema.sql`・`test/fake-supabase.cjs`）、`SyncService` `SuppressChanged` と `ResetLink`/`Cycle` 競合解消。
- **PC版 Main・IPC・UI・ローカルストア・スクリプト是正**：各ローカルストア（`auto-list-settings-store.cjs`・`list-views.cjs`・`loudness.cjs`・`output-device.cjs`・`playback-speed.cjs`・`resume-point.cjs`・`trash-store.cjs`・`song-notes-store.cjs`・`play-history-store.cjs`）の `WriteJsonAtomic` 失敗時ロールバック、`AcceptPlayback` の自動リスト範囲維持、`MakeView` のナビゲーション制限、`SyncPlayingQueue(notify)` 重複抑止、`FinishModalClose` による `modalEpoch` 二重加算防止、各種モーダルの世代保護、`:focus-visible` タイポ修正、`06-list-view.js` 並べ替え/絞り込み中の `.entry-number` 無効化、`05-bulk.js` 選択保持・再描画、`check.cjs` / `audit-release.py` / `package-release.py` 改善。
- **iPhone版是正**：`FavoritesStore`・`PlayCountStore`・`PlayHistoryStore` のエイリアス移行・`syncPushed() async` 化・並行ローカル編集保護、`SyncCoordinator` の `pendingReset` / `onResetExtras` 直列化、`PlaybackEngine`/`PlayerBackend` のセッション検証とクロスフェード保護、`AlarmService` の `isLibraryReady` / 再入ループ / 欠損 `.caf` 保護、`BackgroundTransfers`/`DownloadService`/`MediaDownloader`/`Components`/`FullPlayerView`/`BulkViews`/`TrashStore`/`SongNotes`/`BilibiliAccount`/`ImportViews`/`ExportViews`/`AutoLists` を修正。
- **検証**：`test/bugfix-075-2.test.cjs`・`test/notice-layout.test.cjs`・`ios/FavecusPlayerTests/` 4ファイル（`PlayCountTests`・`FavoritesTests`・`AlarmTests`・`AlarmSoundTests`）を更新・追加し、`checker-pro` 指摘の是正後に `node scripts/build-shared-bundle.cjs`・`node scripts/check.cjs`・NUL バイト検査・`node --test --test-concurrency=2 test/*.test.cjs` を再実行。未検証：Python 未導入のため `audit-release.py` の実実行、macOS/Xcode（Swift コンパイル・XCTest は CI 待ち）、実 Electron/実 GUI・実 Supabase・実 Bilibili・iPhone 実機。

## v0.7.4の状況まとめ（2026-11-21。実装済み／実装予定／実装をあきらめたもの）
※「実装済み」は、ソース・自動テスト（PC 約750件）・iOS CI（シミュレーター・スクリーンショット）までの確認。実機・実Electron・実Bilibili・実際の音は未確認。詳細は、下の各Stepの記録を参照。

### 実装済み
- **共通**：お気に入り（シャッフルで1.5倍選ばれやすい・端末内のみ）／自動リスト「お気に入り」「最近聴いた曲」／自動リストの設定（件数・よく聴く曲の最低回数・最近追加の期間）／再生統計（月ごとの回数・再生時間・上位）／曲の並べ替え9種・絞り込み4種（再生順にも反映）／次に再生・キューの最後に追加／複数選択の一括操作（移動・追加・お気に入り・保存・外す。最近削除へ曲ごとに保管）／曲の情報（アーティスト・タグ・メモ・チャプター。端末内の別ファイル）／ライブラリの点検（重複・リンク切れの報告のみ）／検索の共通化／音量の自動調整（v0.7.3から）。
- **iPhone**：再生速度（0.5〜2.0）／ハートの位置（曲名の右・マークのみ）／曲を選ぶ・まとめ操作／曲名の変更／URLのまとめ追加（最大100件）／プレイリスト画像の表示／クロスフェード（保存済み・ローカルのみ。既定オフ）／チャプターメニュー／アラーム（一覧に曲名・ランダム曲名を表示）・おやすみタイマー・前回の続きから（v0.7.3から）／動画⇔音声の切替時の音量調整の修正／お気に入り・音量記録のファイル化。
- **Windows**：再生速度／メディアキー（ON/OFF切替対応）／キュー操作（並べ替え・ジャンプ）／選択モード／並べ替え・絞り込み画面／出力デバイスの選択／フォルダから追加（サブフォルダ・最大2000件・タグ）／曲の情報・チャプター／通知の重ね表示・ダイアログ後の続き操作／一覧の高速化（1万曲で約4.8秒→約0.3秒）／ffmpegの同時実行制限／環境依存テスト9件の理由つきスキップ／お気に入りハート配置の微調整（曲名のすぐ右）／library:durationのS.ffmpeg参照修正・不要コード整理。
- **内部の整理（Step3の一部）**：main.cjs・app.js の分割（main.cjs 884行）／行の遅延生成／iPhone画面の一部の分割／PC10ストア・iOS6クラスの原子JSON保存共通化（json-file.cjs・AtomicJsonFile.swift）／PC再生・UI重複整理。

### 実装予定（未着手。指示があれば着手）
- **Windows版 v0.7.4 のビルド・Patch・Release**：未生成。実機・実Electronでの確認が先。
- **Step7**：お気に入り・サムネイル選択の同期/ZIP／Supabase・Discordの診断／PCのb23.tv／アラームの改善／AltStoreの複数PC。
- **サムネイルの既定の統一**（表紙優先／場面優先／点数比較）：既定が未決定。
- **E1**：エラーの文面の提供待ち。
- **同期の作り直し（D）**：将来の課題。
- **見送り中の整理**：iOSの通知observerの解放・officialPreferredの保存・UIScreen.main／0.4秒遅延の整理・DownloadServiceの分割・main.cjsの残りの分割・media.cjsの分割（preloadがsandboxのため難しい）・サムネイル用プロトコル（サムネイルは128KB以下のため緊急性なし）。
- **ユーザー側**：GitHubのruleset「Restrict deletions」の再有効化（未確認）。

### 実装をあきらめた・見送ったもの
- **ABリピート**：ユーザー判断で、なし。
- **イコライザー**：評価のみ。PCはメディアが別ホスト（favecus://media・offline）のため、CORS・crossOrigin・AudioContextのsuspended（無音）の対策が要り、実Electronで確認できないため見送り。iPhoneはAVPlayerにEQがなく、再生方式の変更が要る。
- **PCのクロスフェード・ギャップレス**：PCは曲ごとに再生画面を作り直す構造のため、対象外。iPhoneも、独立したギャップレス（先読み）は未実装。
- **利用者が設定できるグローバルショートカット／Windowsの再生オーバーレイ（SMTC）**：未実装。
- **同期へのお気に入りの追加**：しない（ユーザー決定。同期は今のまま）。
- **キーボードの配色**：保留。


---
- 過去版（v0.7.0〜v0.7.4詳細）の開発・検証記録: [DEVELOPMENT-STATUS-ARCHIVE.md](DEVELOPMENT-STATUS-ARCHIVE.md)

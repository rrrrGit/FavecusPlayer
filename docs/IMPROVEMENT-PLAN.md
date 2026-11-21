# FavecusPlayer 課題整理と段階的改善計画

- 更新日: 2026-11-20
- 対象ブランチ / 基準コミット: `release/v0.7.4`（基準 SHA: `9f0c792`）
- 位置づけ: コード監査と Node テスト実測（668 件中 654 件成功・10 件失敗・1 件キャンセル・3 件スキップ）に基づく中長期の課題整理・改善計画案です。現行の開発進捗・決定事項の正本は [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md)、本体外構想は [FUTURE-PLANS.md](FUTURE-PLANS.md) とし、本書は各 Step の着手・優先順位・詳細仕様をユーザー承認のうえ [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) へ反映するための土台として扱います。

---

## 1. 内部的な問題点・改善点（コード・設計・テスト）

### A. 具体的な不具合・状態管理リスク

- **iOS 動画／音声切替時の音量調整漏れ**: [PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift) の `switchVideo` で別ファイル（`.m4a` ⇔ `.mp4`）へ切り替える際に `applyLeveling` が呼ばれておらず、音量差や直前の `levelGain` が残るリスクがあります。
- **iOS おやすみタイマーの復帰時補正漏れ**: [SleepTimer.swift](../ios/FavecusPlayer/Playback/SleepTimer.swift) の `tick()` はフォアグラウンド復帰時に呼び出す設計ですが、[PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift) の `didBecomeActiveNotification` ハンドラでは `applyPreferredVideo()` のみを呼んでおり、ロック解除直後の停止・8 秒フェードが最大約 1 秒遅延する恐れがあります。
- **iOS 通知オブザーバ未解除・二重処理・DL 回収条件・アラーム同期**:
  - [PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift) と [SyncCoordinator.swift](../ios/FavecusPlayer/Sync/SyncCoordinator.swift) で `NotificationCenter.default.addObserver` のトークンが保持・解放されておらず、再生成やテスト時にリーク要因になります。
  - [AutoLists.swift](../ios/FavecusPlayer/Library/AutoLists.swift) の `AutoListsSection` が `.task(id: store.document)` と `.onAppear` の双方で `model.reload` を呼んでおり、全リスト走査＋JS 呼び出しが重複実行され得ます。
  - [DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift) の `save()` が `chain` で `begin()` 全体（`bilibili.resolve` の通信を含む）を直列化しているため、1 曲の解決遅延で後続の単曲保存が詰まります。また `reconcile()` は `finishing.isEmpty` を条件としているため、他件が仕上げ中のあいだ孤立レコードの失敗回収がスキップされます。
  - [AlarmService.swift](../ios/FavecusPlayer/Alarm/AlarmService.swift) の `resync()` で `alarms` 配列を走査しながら内部で `alarms` を書き換える `save()` 等を呼び出しており、状態整合に注意が必要です。
- **PC 側の未接続機能と揮発学習**:
  - [queue.cjs](../src/core/queue.cjs) に `Queue.Reorder` / `Queue.JumpTo` が実装済みですが、Windows 版の IPC / UI に未接続です（iOS 版のみ利用可能）。
  - [main.cjs](../src/main.cjs) の `officialPreferred`（埋め込み失敗時に公式プレイヤーへ切り替える学習状態）がメモリ上の `Set` のみで保持されており、アプリ再起動ごとに復旧リトライ（`PlayerRecovery`）が再発します。

### B. Windows 版と iOS 版の仕様乖離

- **サムネイル選定（持ち越し E2）**:
  - Windows 版（[thumbnail.cjs](../src/core/thumbnail.cjs)）は公式表紙を優先し、単色判定（輝度標準偏差 `< 6 && range < 48`）に該当したときのみ動画場面へ差し替えます。
  - iOS 版（[ArtworkStore.swift](../ios/FavecusPlayer/Artwork/ArtworkStore.swift)）は 60 秒付近（短尺は 30%）の場面を最優先し、単色判定もグレースケール 16×16 の標準偏差 `< 8` と基準が異なります。さらに [DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift) の `ensureFrames` が `coverURL: nil` で呼ぶため、一括取得時は `videoshot` が取れないと表紙フォールバックも働きません。また、Windows 版にある 64px PNG のカスタムプレイリストアイコン編集も iOS 側にはありません。
- **検索仕様**:
  - Windows 版（[library-search.js](../src/ui/library-search.js)）は NFKC・カタカナ/ひらがな正規化、空白区切り AND 検索、祖先リストを含む経路検索、50 件ごとのページングに対応しています。
  - iOS 版（[LibraryViews.swift](../ios/FavecusPlayer/Library/LibraryViews.swift)）は単一文字列の部分一致のみで、100 件上限で打ち切られます。
- **音量計測とキャッシュ**:
  - Windows 版（[loudness.cjs](../src/core/loudness.cjs)）は FFmpeg `volumedetect`＋更新時刻 `at` に基づく古い順の LRU 削除（最大 2,000 件）を採用しています。
  - iOS 版（[VolumeLeveling.swift](../ios/FavecusPlayer/Playback/VolumeLeveling.swift)）は `AVAssetReader` による 22.05kHz モノラル RMS（最大 1,200 秒で打ち切り）で、`UserDefaults` の辞書キー先頭から順序不定で間引くほか、`url.path` をキャッシュキーに含むためコンテナパス変更やオンライン一時ファイル再取得時にキャッシュが無効化されます。なお、iOS 版はオンライン再生も一時ファイルを経由するため実質的にラウドネス調整が働きます。

### C. パフォーマンス・I/O・保守性・テスト品質

- **再生中の重い同期保存 I/O**: [main.cjs](../src/main.cjs) の `media:state` 受信処理内で曲長（`duration`）の差異 1 秒超を検知するたびに [store.cjs](../src/core/store.cjs) の同期 `Store.Save()`（全 ID 割当・`JSON.stringify`・`.bak` コピー・`renameSync`・`JSON.parse`・削除整理予約・同期通知）が走ります。
- **リソース・メモリ・UI 再描画負荷**:
  - [loudness.cjs](../src/core/loudness.cjs) の `GainFor` には FFmpeg 同時実行数制限がなく（[thumbnail.cjs](../src/core/thumbnail.cjs) には `pending.size < 2` 上限あり）、連続曲送り時に複数 FFmpeg プロセスが並行起動し得ます。
  - [app.js](../src/ui/app.js) の `Render()` / `RenderEntries()` は仮想スクロールなしで `replaceChildren()` による全 DOM 再構築を行っており、`UpdateDuration` も毎回全プレイリストを `flatMap` 走査しています。サムネイルも最大 3MB の Base64 Data URL として保持・IPC 転送しています。
  - iOS 版の [FavoritesStore.swift](../ios/FavecusPlayer/Playback/FavoritesStore.swift)（最大 20,000 件配列）と `LoudnessCache`（最大 2,000 件辞書）が更新のたびに `UserDefaults` へ全量シリアライズされます。
- **ファイル肥大化・重複ロジック・Swift 6 / UI 負債**:
  - 主要ファイルへの責務集中が進行しています：
    - [app.js](../src/ui/app.js): 1,380 行（DOM テンプレート、全モーダル、状態管理、DL 進捗、同期 UI、D&D）
    - [main.cjs](../src/main.cjs): 999 行（ウィンドウ/ビュー管理、再生状態機械、自動リスト、サムネイル、診断ログ、全 IPC）
    - [LibraryViews.swift](../ios/FavecusPlayer/Library/LibraryViews.swift): 766 行（ルート骨格、デモ制御、シート管理、ホーム、検索結果、リスト詳細）
    - [DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift): 685 行（背景 DL、オンライン LRU キャッシュ、Bilibili メタデータ/サムネイル、ZIP 取込、容量計算）
    - [PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift): 580 行（キュー、再生/レジューム、ラウドネス、再生回数、動画切替、アートワーク、自動リスト）
    - [MiniPlayerView.swift](../ios/FavecusPlayer/Playback/MiniPlayerView.swift): 578 行（ミニバー、向きロック、最大化動画、`VideoSurface`、フルプレイヤー、キューパネル、タイマー）
  - ショートカット文字化ロジックが [keybindings.js](../src/ui/keybindings.js) / [app.js](../src/ui/app.js) と [media.cjs](../src/preloads/media.cjs) で二重実装されています。
  - iOS 側には [BackgroundTransfers.swift](../ios/FavecusPlayer/Downloads/BackgroundTransfers.swift) と [MiniPlayerView.swift](../ios/FavecusPlayer/Playback/MiniPlayerView.swift) での `nonisolated(unsafe)`、非推奨の `UIScreen.main.bounds.width`、[LibraryViews.swift](../ios/FavecusPlayer/Library/LibraryViews.swift) の固定 0.4 秒遅延スクロールが残っています。
- **サイレント失敗とデータ保護**: [loudness.cjs](../src/core/loudness.cjs)、[store.cjs](../src/core/store.cjs)、[PlayCountStore.swift](../ios/FavecusPlayer/Playback/PlayCountStore.swift)、[TrashStore.swift](../ios/FavecusPlayer/Library/TrashStore.swift)、[DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift) 等で保存失敗を `catch {}` / `try?` で握りつぶす箇所があり、ディスク障害や権限異常に気付きにくい構造です。また `Store.Read()` で本体・`.bak` とも破損時は退避後に空データで上書きするため、Sync 無効時はユーザーへの明確な警告導線が重要になります。
- **Windows ローカルテストのノイズと進捗文書の肥大化**:
  - Node テスト実測（668 件中 654 件成功・10 件失敗・1 件キャンセル・3 件スキップ）において、Windows 非特権環境での `symlinkSync` の `EPERM`（7 件）、ローカル `ffmpeg` / `python3` 不在（2 件）、Discord モック 8 秒タイムアウト（[core.test.cjs](../test/core.test.cjs)）、並列ダウンロードのタイミング依存失敗（[release-065.test.cjs](../test/release-065.test.cjs)）が毎回失敗扱いとなり、真のリグレッションが埋もれやすくなっています。
  - [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) が約 190KB まで肥大化して一部ツールでバイナリ判定による読込制限にかかるほか、冒頭の「現在地」（ブランチ作成直後）と直下の「G・H 実装済み」で記載の食い違いが生じています。

---

## 2. 外部的な問題点・改善点（UX・実機・外部サービス・配布）

- **未確認の実機・実通信ギャップ（最大リスク）**:
  - Windows 実機での旧版（特に v0.6.6）からの `Patch.exe` 適用、実 GUI 操作、FFmpeg ラウドネス実測、Bilibili 実再生・保存、Discord 実表示が未確認のまま機能追加が先行しています。
  - iPhone 実機での AlarmKit（iOS 26 での発火・サイレント/集中モード・CAF 音長上限・「曲を再生」AppIntent）、v0.7.3〜0.7.4 の新機能群（F1〜F5・G・H）、および持ち越し **E1**（特定 3 本の動画のみ保存に失敗する原因）も未確認です。
- **Bilibili・Electron 連携の制約**:
  - PC 版オンライン再生は [media.cjs](../src/preloads/media.cjs) による DOM 監視（音量強制同期、360p 自動選択、タイトル取得）と公式プレイヤー強制フィットに依存しており、Bilibili 側の仕様変更に脆弱です。また PC 版オンライン再生ではラウドネス調整が効きません。
  - PC 版は `b23.tv` 短縮 URL 未対応（iOS 版は対応）。iOS 版オンライン再生は音声ストリームをローカル一時ファイルへ保存・検証してから再生するため、長尺動画では再生開始待ちと `Caches` 容量消費が発生します。
  - 配信先が返す制限・リスク制御（HTTP 401/412/429、コード `-101/-352/-412/-509`）・DRM・セグメント分割動画は回避せず停止する仕様（[bilibili-resolve.cjs](../src/core/bilibili-resolve.cjs)）のため、回線・アカウント状態の影響を直接受けます。
- **UI・操作性・OS 統合の弱点**:
  - Windows 版は Windows SMTC（ハードウェアメディアキー・OS 再生オーバーレイ）とグローバルショートカットに未対応です。タスクバー埋め込み（[taskbar-player.cjs](../src/core/taskbar-player.cjs)）もプライマリモニター横向きタスクバー前提で、環境によりフローティングミニプレイヤーへ退避し、シーク位置表示も行えません。
  - Windows 版は単一モーダル（`<dialog id="modal">`）設計のため、設定等を開いている間は Bilibili ブラウザからの追加やローカル画面からの画質変更要求が拒否されます。一覧での複数選択一括操作もなく、通常通知は単一の 7 秒トースト（`#toast`）で連続エラーが上書きされます。
  - iOS 版では曲名編集、プレイリストのカスタムアイコン設定、他リストへのコピー/移動、URL 一括追加、リスト自動ソートなど、PC 版にある編集機能の一部が未対応です。
- **アラーム・AltStore・外部サービス導入ハードル**:
  - アラーム機能は iOS 26 以降専用（iOS 16〜25 は利用不可）で、ランダムアラームは繰り返し発火後にアプリを開かないと次の曲へ抽選更新されません。
  - AltStore 運用では 7 日ごとの更新、App ID 上限（App Extension 追加不可）、複数 PC で更新した際の証明書失効懸念が未解決です。
  - Supabase 同期（個人プロジェクト構築・[schema.sql](../supabase/schema.sql) 手動再実行・無料枠 7 日非活動による自動休止）と Discord RPC（Developer Portal での Application ID・アセット登録、デスクトップ版 IPC 限定）は導入・復旧が利用者負担となっています。
  - お気に入り・ゴミ箱・レジューム・サムネイル選定は同期および ZIP 共有の対象外のため、端末間・機種変更時の引き継ぎが分断されています。

---

## 3. 音楽プレイヤーとして足りていない機能

既存の基盤機能（再生/一時停止/前後曲/シーク、お気に入り＋再生回数重み付きシャッフル、リピート、おやすみタイマー、前回の続きから再生、自動リスト 3 種、最近削除、音量の自動調整、アラーム、階層プレイリスト、Supabase 同期、暗号化 ZIP 共有）を踏まえ、不足している機能を 4 区分で整理します。

1. **再生制御の拡充**:
   - **再生速度変更**（0.5x〜2.0x：PC ローカル/保存済み再生・iOS `AVPlayer`・ロック画面 `MPNowPlayingInfoCenter` 連携）
   - **AB リピート（区間リピート）**（開始・終了点のワンタップ指定と解除）
   - **ギャップレス再生 / クロスフェード**（保存済み・ローカル曲のシームレスな曲つなぎ）
   - **イコライザー（EQ） / 音声出力デバイス選択**（PC の出力先切替など）
2. **キュー操作の高度化**:
   - **「次に再生（Play Next）」 / 「キューの最後に追加（Add to Queue）」**
   - **PC 版でのキュー並べ替え・任意位置ジャンプ**（[queue.cjs](../src/core/queue.cjs) に共通実装あり・UI 未接続）および **現在の再生キューをプレイリストとして保存**
3. **ライブラリ整理・発見・パーソナライズ**:
   - **プレイリスト内の曲ソート & 絞り込みフィルタ**（曲名・再生回数・追加日・曲長・お気に入り・保存状態・ローカル/Bilibili）
   - **再生履歴の永続化（最近聴いた曲）**（現在はキュー上のインメモリ 1,000 件のみ）
   - **自動リストのカスタマイズと「お気に入り」自動リスト**（F3 計画で未実装の件数・条件変更を含む）
   - **再生統計ダッシュボード**（[play-ledger.cjs](../src/core/play-ledger.cjs) が持つ月別台帳の可視化）
   - **メタデータ拡張（アーティスト・タグ・曲メモ／タイムスタンプ・歌詞表示）**（歌枠や長尺動画のチャプター頭出し含む）
   - **既存ライブラリ横断の重複整理・リンク切れ／破損メディア一括点検**
4. **OS 連携・取り込み効率**:
   - **Windows SMTC（メディアキー / OS オーバーレイ）＆グローバルホットキー**
   - **一覧での複数選択一括操作**（一括移動・コピー・削除・お気に入り・オフライン保存）
   - **ローカルフォルダ一括取り込みと埋め込みタグ（ID3 / MP4 メタデータ・アートワーク）自動読込**

---

## 4. ステップ単位の改善・開発計画（Step 0〜Step 7）

[AGENTS.md](../AGENTS.md) の方針（全面書き直し禁止、既存データ・メディア保護、共通 JS コア正本、作業ブランチでの Step 単位開発、自動テストと実機確認の分離）に沿った段階計画です。

### Step 0: 実機ベースライン確認・持ち越し原因特定・進捗資料の整理
- **目的**: 機能追加を続ける前に、未確認の実機挙動と持ち越し不具合の事実を確定させる。
- **主な作業内容**:
  - Windows 実機確認（旧版特に v0.6.6 からの `Patch.exe` 更新、実 GUI、FFmpeg ラウドネス実測、Bilibili 実再生・保存、Discord 実表示）。
  - iPhone 実機確認（iOS 26 AlarmKit 発火・消音/集中モード・CAF 音長上限・「曲を再生」AppIntent、F1〜F5・G・H の操作感と体感音量）。
  - 持ち越し **E1**（動画のみ保存失敗 3 本）の実通信診断ログ取得と原因切り分け（配信先の制限回避は行わない）。
  - [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) 冒頭の「現在地」記述を最新状態へ同期し、v0.7.0〜v0.7.2 の過去記録をアーカイブ文書へ分離して可読性を回復する。
- **検証・完了条件**: 実機確認結果に基づく要修正リストと E1 原因の確定、進捗文書が矛盾なく読める状態。

### Step 1: 確認済み内部バグ修正とテスト・I/O 健全化（低リスク・即効性）
- **目的**: コード監査とテスト実測で見つかった明確な欠陥とパフォーマンス地雷を解消する。
- **主な作業内容**:
  - **iOS 修正**: [PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift) の `switchVideo` へ `applyLeveling` 追加、`didBecomeActiveNotification` での `sleepTimer.tick()` 呼び出し、`NotificationCenter` オブザーバ解除（[SyncCoordinator.swift](../ios/FavecusPlayer/Sync/SyncCoordinator.swift) 含む）、[AutoLists.swift](../ios/FavecusPlayer/Library/AutoLists.swift) の二重リロード防止、[DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift) の `save()` 通信直列化解除・`reconcile()` 条件見直し、[AlarmService.swift](../ios/FavecusPlayer/Alarm/AlarmService.swift) `resync()` の安全な走査。
  - **PC 修正**: [main.cjs](../src/main.cjs) の曲長更新による `Store.Save()` のデバウンス/バッチ化、`officialPreferred` の軽量永続化、[loudness.cjs](../src/core/loudness.cjs) への FFmpeg 同時実行上限導入、保存失敗のサイレント握りつぶし（`catch {}` / `try?`）を診断ログ・通知へ改善。
  - **テスト基盤**: Windows 非特権環境の `symlinkSync` EPERM や `ffmpeg` / `python3` 不在テストをローカル時は明示スキップ（CI では必須維持）、[release-065.test.cjs](../test/release-065.test.cjs) と [core.test.cjs](../test/core.test.cjs) のタイミング依存・タイムアウトを安定化。
- **検証・完了条件**: [check.cjs](../scripts/check.cjs) 成功、Windows ローカル `node --test` 全件グリーン（環境依存スキップを明示）、iOS CI 全 XCTest 成功。

### Step 2: PC / iOS 間の仕様統一（E2 サムネイル・検索・キュー・キャッシュ）
- **目的**: 2 プラットフォーム間の体験差とデータ不整合を共通 JS コア基準で解消する。
- **主な作業内容**:
  - **E2 サムネイル統一**: 既定方針（表紙優先／場面優先／点数比較）を確定し、「選定種別＋秒数」の軽量同期または共通規則化を実装。iOS `ensureFrames` の `coverURL: nil` 欠落修正と Flat 判定基準の統一。
  - **iOS 検索の共通化**: iOS 検索を [library-search.js](../src/ui/library-search.js)（NFKC・ひらがな正規化・空白 AND・祖先経路・ページング）へ統合。
  - **PC キュー操作の接続**: [queue.cjs](../src/core/queue.cjs) の `Queue.Reorder` / `Queue.JumpTo` を Windows 版 IPC・UI に接続。
  - **iOS キャッシュ移行**: [FavoritesStore.swift](../ios/FavecusPlayer/Playback/FavoritesStore.swift) と `LoudnessCache`（[VolumeLeveling.swift](../ios/FavecusPlayer/Playback/VolumeLeveling.swift)）を `UserDefaults` から独立ファイル＋更新時刻順 LRU（メディアキー/相対識別基準）へ移行。
- **検証・完了条件**: [cases.json](../shared/fixtures/cases.json) へのテスト追加、Node・iOS CI の結果一致確認、UI プレビュー確認。

### Step 3: 巨大モジュールの段階分割と UI 基盤改善
- **目的**: 今後の機能追加でデグレを起こさない保守性と、大規模ライブラリ（最大 1 万曲）での応答性を確保する。
- **主な作業内容**:
  - **PC**: [main.cjs](../src/main.cjs) を再生制御・ウィンドウ/プロトコル・IPC 登録へ分割、[app.js](../src/ui/app.js) を一覧・再生バー・モーダル/設定へ分割、[media.cjs](../src/preloads/media.cjs) のショートカット判定を [keybindings.js](../src/ui/keybindings.js) と共通化。一覧描画の最適化/仮想化、サムネイルの独自プロトコル配信化（Base64 IPC 削減）、モーダル競合と単一トースト上書きの改善。
  - **iOS**: [LibraryViews.swift](../ios/FavecusPlayer/Library/LibraryViews.swift)・[DownloadService.swift](../ios/FavecusPlayer/Downloads/DownloadService.swift)・[PlaybackEngine.swift](../ios/FavecusPlayer/Playback/PlaybackEngine.swift)・[MiniPlayerView.swift](../ios/FavecusPlayer/Playback/MiniPlayerView.swift) の責務別分割、非推奨 `UIScreen.main`・固定 0.4 秒遅延スクロール・`nonisolated(unsafe)` の解消。
- **検証・完了条件**: 既存全テスト・iOS CI の通過、10,000 曲規模の模擬データでの描画・応答確認。

### Step 4: 音楽プレイヤー中核機能①（再生制御・キュー高度化・Windows OS 統合）
- **目的**: 日常の聴取体験で要望が出やすい再生操作と OS 連携を両端末へ揃える。
- **主な作業内容**:
  - **再生速度変更**（0.5x〜2.0x、PC ローカル/保存済み再生・iOS `AVPlayer`・ロック画面表示連携）。
  - **「次に再生（Play Next）」「キューの最後に追加」**（[queue.cjs](../src/core/queue.cjs) 拡張→PC/iOS 同時対応）および **現在のキューをプレイリスト保存**。
  - **AB リピート（区間リピート）**（開始・終了点のワンタップ設定/解除、アラーム範囲選択の知見を活用）。
  - **Windows SMTC（メディアキー / OS オーバーレイ）＆グローバルショートカット** の実装。
- **検証・完了条件**: キュー・再生速度・AB リピートの共通テスト、PC / iOS UI プレビュー、実機メディアキー・ロック画面動作確認。

### Step 5: 音楽プレイヤー中核機能②（整理・一括操作・履歴・統計・iOS 編集強化）
- **目的**: 曲数が増えたライブラリをストレスなく管理・発見できるようにする。
- **主な作業内容**:
  - **プレイリスト内の曲ソート & フィルタ**（曲名・再生回数・追加日・長さ・お気に入り・保存状態・ローカル/Bilibili）。
  - **一覧での複数選択一括操作**（一括移動・コピー・削除・お気に入り・保存）と **iOS 編集機能の拡充**（曲名編集・他リストへのコピー/移動・URL 一括追加・カスタムアイコン表示）。
  - **自動リスト拡充**: 「お気に入り」自動リスト追加、各自動リストの上限件数・条件カスタマイズ。
  - **再生履歴の永続化（最近聴いた曲）** と **再生統計ビュー**（[play-ledger.cjs](../src/core/play-ledger.cjs) の月別台帳を可視化）。
- **検証・完了条件**: 共通データ整合テスト、既存 v3 `library.json` 後方互換テスト、UI プレビュー確認。

### Step 6: メタデータ・音質・ライブラリ保守機能の強化
- **目的**: Bilibili 音源・ローカル音源の双方を本格プレイヤーとして仕上げる。
- **主な作業内容**:
  - **メタデータ・チャプター/メモ**: アーティスト・タグ・曲メモ・タイムスタンプ（長尺動画や歌枠の頭出し）、ローカルフォルダ一括取り込みと埋め込みタグ/アートワーク自動読込。
  - **再生品質**: 保存済み/ローカル曲向けのギャップレス再生・クロスフェード、PC 音声出力デバイス選択、イコライザー（負荷と実装方式を事前評価のうえ導入判断）。
  - **ライブラリ保守ツール**: 既存ライブラリ横断の重複整理、リンク切れ・破損ファイルの一括点検。
- **検証・完了条件**: 移行・取り込みのロールバック/破損耐性テスト、実再生での音切れ・音割れ確認。

### Step 7: 外部連携・同期・配布運用の洗練
- **目的**: 導入・長期運用時の摩擦を減らし、端末間の体験を一貫させる。
- **主な作業内容**:
  - **同期/バックアップの選択拡張**: お気に入り・サムネイル選定・基本設定の任意同期または ZIP 引き継ぎ（既存の非同期方針との整合を保ち、必要時は後方互換で拡張）。
  - **Supabase / Discord 導入・診断支援**: 接続診断画面、スキーマ版チェック、Supabase 自動休止時の具体的な復旧ガイド表示。
  - **Bilibili・アラーム・AltStore 改善**: PC 版 `b23.tv` 短縮 URL 対応、DOM 変化時の診断メッセージ強化、実機確認結果に基づくアラーム改善（iOS 16〜25 向け通知フォールバック可否、ランダム複数日予約の可否）、複数 PC での AltStore 更新手順検証。
- **検証・完了条件**: 偽 Supabase / モック通信テスト、旧版タグからの Patch 更新経路テスト、全体ビルド・リリース検証。

---

## 5. 未確認事項・前提

- 個別ソースのうち [sync-engine.cjs](../src/core/sync-engine.cjs)・[sync-state.cjs](../src/core/sync-state.cjs)・[sync-library.cjs](../src/core/sync-library.cjs)・[offline-cleanup.cjs](../src/core/offline-cleanup.cjs)・[offline-migration.cjs](../src/core/offline-migration.cjs)、`native/` 実装詳細、および一部の補助 Swift ファイル（[PlaylistSaveSheet.swift](../ios/FavecusPlayer/Library/PlaylistSaveSheet.swift), [MediaDownloader.swift](../ios/FavecusPlayer/Downloads/MediaDownloader.swift), [SyncCore.swift](../ios/FavecusPlayer/Sync/SyncCore.swift), [AlarmModel.swift](../ios/FavecusPlayer/Alarm/AlarmModel.swift) 等）の全文は精査していません。
- iOS ビルド・XCTest・Linux 上での Windows リリースビルドおよび実機・実通信の確認は本環境では実行していません。

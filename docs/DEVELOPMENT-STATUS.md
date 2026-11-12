# FavecusPlayer 開発状況

更新日：2026-11-13（日本時間）
対象：v0.7.0 / `release/v0.7.0`
現在地：Step0完了（ブランチ作成・全体計画の制定）。次はStep1（iOS版方針と共通データ仕様の確定）。
基準コミット：`79255411dfbcb240cbad064fa8d1ae0ca4e085d4`（`release/v0.6.7` 最新。配布済みv0.6.7 startup-hotfix-1を含む）。
v0.6.7の開発・検証記録は `docs/VALIDATION-067.md` に移しました。

## 役割分担

| 担当 | 範囲 |
| --- | --- |
| Claude | 設計、実装、テスト、検証、本ファイルとDESIGN.mdの更新。作業の分担・検証の手順はユーザー共通の開発方針に従う |
| ユーザー | Windows実機・iPhone実機・AltStore/AltServer・Supabaseアカウントの操作と確認、UIの理想の提示、秘密情報の管理 |

- 各Stepの指示・結果は本ファイル末尾の「現在の工程」に記載し、Step完了時に結果へ置き換えます。Step別の指示ファイルは作りません。
- 変更は同じ `release/v0.7.0` へコミットします。他者の未確認の変更を上書きしません。

## v0.7.0の目的と範囲

1. iPhone版FavecusPlayerの作成（個人利用。App Store公開・一般配布はしない）
2. Windows版・iPhone版が同じデータ仕様と共通処理を使い、片方の修正をもう片方へ反映しやすい構造の整備
3. プレイリストのクラウド同期（Supabaseを第一候補）とメディアのZIP共有
4. v0.6.7の機能改善（内容はユーザー指示を受けて追加）

iPhone版の画面の詳細は、スマホ版の画面作成工程でユーザーが提示するUIの理想を受けて決めます。それまでの工程では仮の最小画面のみを作ります。

## iPhone版の必須条件（2026-11-08 ユーザー提示の方針から）

- 既存Windows版を壊さない。全面的な書き直しをしない。ZIP入出力は削除せず、バックアップ・手動移行・メディア共有用に残す。
- プレイリスト階層を平坦化しない。任意の深さと並び順を保持する。
- ファイルパスを曲の識別子にしない。端末に依存しない識別子と、端末ごとの保存情報（DeviceMedia）を分ける。
- クラウドへ同期するのは構造・識別・最低限のメタデータ・更新日時・削除状態のみ。MP4/M4A等の実体、端末の絶対パス、一時ファイル、Bilibiliの認証情報は同期しない。
- 操作はローカルDBを先に更新し、同期キューを経て通信可能時に同期する。オフラインでも閲覧・編集・並び替え・保存済み再生ができる。
- 同期は変更単位で行い、削除はTombstoneで扱い、古い情報による復活を防ぐ。
- iOSではURLSession、AVFoundation/AVPlayer等のネイティブ機能を使う。Windows用FFmpeg.exeやElectronをiOSで動かさない。WKWebViewは必要な箇所だけに使う。
- 映像と音声の結合は再エンコードしないPassthroughを優先する。できない組み合わせでは、互換形式の選び直し・音声のみ保存・保存不可の表示で終える。
- 保存途中のデータを完成扱いにしない。状態（NotDownloaded/Preparing/Downloading/Processing/Validating/Completed/Failed/Cancelled）を明示し、再起動後も中途半端なファイルを完成と認識しない。サムネイルだけの失敗では本体を削除しない。
- バックグラウンドダウンロードは必ず続くと仮定しない。強制終了・OS判断・制限による停止を扱う。
- 認証情報は平文保存せず、Keychain等のOS標準の安全な保存先を使う。
- DRM解除、コピー保護解除、暗号鍵抽出、有料コンテンツの保護回避、アクセス・地域・ログイン制限の突破、Bilibiliの拒否応答の迂回、保存禁止状態の回避は実装しない。取得できない場合は「取得不可」として終える。ダウンロード済み動画を第三者へ配布する機能は作らない。
- 署名は無料Apple Account（Personal Team）とAltStore Classic＋AltServer（Windowsログイン時に自動起動）に任せる。FavecusPlayer本体は署名制限を回避する処理を持たず、AltStoreの内部状態も取得しない。iOSショートカットのPersonal Automationで毎日Refresh Appsを実行し、失敗しても翌日に再試行できる運用にする。SideStoreへの変更は、比較の根拠がそろった場合のみ検討する。

## 既存構造の調査結果と設計上の論点

Step1で確定する前提として、v0.6.7の実装から次を確認しました（詳細はDESIGN.md）。

| 項目 | 現状 | iPhone版・同期への影響 |
| --- | --- | --- |
| 親子構造 | `playlists[].childIds` と `rootPlaylistIds` による構造。同じ子リストを複数の親が持つ共有子リストがある | 単一の `ParentId` では共有子リストを表せず、情報が失われる。同期では「親→子の辺（並び順付き）」を単位にする必要がある |
| 曲の識別 | 登録曲 `id` と、メディア用のUUID `mediaId`（identityVersion 2）。照合キーは正規化URL＋パート、確認済みav/BVは `videoAliases` | mediaIdは端末ごとに付けたUUIDのため、同期で同じIDを共有する前提が必要。ZIPと端末間の照合には、BV＋パートを基本とする端末非依存のキーを併用する |
| CID | ライブラリには保存せず、DL時にAPIから取得 | MediaKeyはBV＋パートを基本とし、CIDは確認済みメタデータとして任意で保持する案が有力（Step1で確定） |
| 並び順 | 配列順で保持 | 同時編集の並び替えを変更単位で扱うため、同期用の並び順キーへの変換が必要 |
| DL保存 | `downloads/media/<動画ID>-p<パート>/`（layout 4）と `downloads/index.json` | 保存先はすでに曲名・所属から独立している。DeviceMediaの考え方と整合する |
| ZIP | FVPA0002の内側に `identity.json`、shareVersion 1、exportMode（information/media） | 既存形式を拡張してMediaKey入りのmanifestを加える。旧ZIPの読み込みを維持する |
| 共通処理 | library-data / library-tree / library-search / library-share / import-identity / queue / media-identity / urls 等は、Node APIやDOMなしのVMで動くことをテスト済み | iOSのJavaScriptCoreで同じJSを実行できる見込みがある |

### 共通処理の方針（Step1で確定、Step3で実証）

- 第一案：データ規則（構造検証、階層、識別、検索、共有形式、同期のマージ）は既存の端末非依存JSを正本にします。Windowsは従来どおり実行し、iOSはJavaScriptCore（iOS標準）で同じJSを実行します。保存・通信・再生・UIは各端末でネイティブに実装します。
- 両端末で同じ共通テストデータ（期待値付きJSON）を実行し、仕様のずれを検出します。
- 第一案の性能や制約に問題が出た場合の代替案は、Swiftで再実装し共通テストデータで一致を保証する方式です。

### ファイル配置案（Step1で確定）

```text
src/            既存Windows版（Electron）。移動しない
  core/         既存の共通処理とNode側処理
shared/         端末共通の仕様
  spec/         ライブラリ・同期レコード・メディアmanifestのスキーマ
  fixtures/     両端末で実行する共通テストデータ
ios/            iPhone版
  project.yml   XcodeGenのプロジェクト定義（Macなしで.pbxprojを直接編集しないため）
  FavecusPlayer/    アプリ本体（App / Features / Platform）
  FavecusPlayerTests/
.github/workflows/ios.yml   iOSのビルド・テスト・スクリーンショット・署名なしIPA
```

## 検証の区別

各Stepの報告では次を分けて記録し、未実施を成功と扱いません。

- Nodeテスト・構文検査（この開発環境で実行）
- iOSのシミュレーターでのビルド・テスト・スクリーンショット（GitHub ActionsのmacOS環境）
- iPhone実機での操作（AltStore経由の導入。ユーザーが確認）
- Windows実機・実Electron
- Bilibili実通信、Supabase実通信
- Windowsの全体ビルド・Patch生成（Step20・21のみ）

GitHub ActionsのmacOS環境は、非公開リポジトリでは無料枠の消費が大きいとされます（1分あたり10分換算との情報。公式ページは未確認）。iOS関連の変更があるときだけ実行し、実行時間を記録します。

## 全工程と完了条件

| 工程 | 状態 | 完了条件・範囲 |
| --- | --- | --- |
| Step0 開始と全体計画 | 完了 | `release/v0.7.0` 作成、v0.6.7記録の移動、全体計画・役割分担の記載 |
| Step1 iOS版方針と共通データ仕様 | 未着手 | 下記「Step1」の設計をDESIGN.mdへ確定。コードは変更しない |
| Step2 iOSビルド基盤の検証 | 未着手 | XcodeGenの最小SwiftUIアプリをCIでビルド・テストし、シミュレーターのスクリーンショットと署名なしIPAを取得。ユーザーがAltStoreで実機に導入できるか確認 |
| Step3 共通処理のiOS実行 | 未着手 | 共通JSの束ね方と読み込みを決め、共通テストデータをNodeとiOSシミュレーターの両方で実行。999リスト・10000登録での速度を確認 |
| Step4 MediaKeyと端末依存情報の分離 | 未着手 | 端末非依存のMediaKeyとDeviceMediaをWindows版へ導入。既存JSON・DLカタログ・ZIPの互換と移行時の原本保護を確認 |
| Step5 Windows版の改善 | 指示待ち | ユーザーが提示する改善項目。内容に応じてStep5-1、5-2…に分割し、他のStepの間へ挿入することもある |
| Step6 同期の共通基盤 | 未着手 | 変更レコード、親子の辺と並び順、Tombstone、競合解決、同期キューを共通JSで実装。SyncRepositoryの抽象とメモリ実装で、同時変更・オフライン編集・削除後の復活防止をテスト |
| Step7 Supabase接続 | 未着手 | テーブル・行単位のアクセス制御・認証の設計、SupabaseSyncRepository。Windows版の同期接続と、トークンの安全な保存 |
| Step8 iOS基本アプリとローカルDB | 未着手 | ローカルDB、プレイリスト階層の表示・編集・並び替え。画面はユーザーのUI案を受けて決定 |
| Step9 iOSローカル再生 | 未着手 | AVPlayerによる再生、ミニプレイヤー、バックグラウンド音声、ロック画面操作、再生順 |
| Step10 メディアZIPの取り込み・出力 | 未着手 | 既存ZIP形式の拡張、Windows出力→iPhone取り込み→iPhone出力→Windows取り込み、重複防止、Filesアプリ・共有シートからの選択 |
| Step11 iOS同期とWindows/iPhone間同期の検証 | 未着手 | iOS側の同期接続。双方向・同時変更・オフライン・再接続・深い階層・共有子リストを実通信で確認 |
| Step12 iOSのBilibiliログインとオンライン再生 | 未着手 | 必要な箇所だけWKWebView、認証情報はKeychain。通常の方法でアクセスできる配信のみ |
| Step13 iOSダウンロード | 未着手 | IOSMediaDownloadService、URLSession、状態管理、Passthrough結合と安全なフォールバック、検証、サムネイル |
| Step14 バックグラウンドダウンロード | 未着手 | background構成、中断・再開・キャンセル・通信切断・容量不足・アプリ再起動 |
| Step15 iOS画面の仕上げ | 未着手 | ユーザーのUI案に沿った再生画面・ダウンロード・設定・同期状態の画面 |
| Step16 AltStore実機導入手順 | 未着手 | AltServerの自動起動、同一Wi-Fi、信頼済み、必要なApple関連部品、Background Refreshの確認手順。アプリデータを保ったままのRefresh確認 |
| Step17 毎日の自動Refresh | 未着手 | ショートカットのPersonal Automationによる毎日のRefresh Apps、失敗・残り日数・手動更新方法の確認手順と、翌日の再試行の確認 |
| Step18 Windows版の同期・ZIP画面 | 未着手 | 同期状態・ログイン・ZIP出力の画面をWindows版へ接続し、操作プレビューで確認 |
| Step19 全体検証 | 未着手 | 全Nodeテスト、iOSテスト、共通テストデータ、実機・実通信の確認範囲の集約 |
| Step20 全体ビルド | 未着手 | Windowsの全体ビルドと版更新、iOSの署名なしIPA |
| Step21 最終出力 | 未着手 | Windows Patchと説明・検証情報、iOS IPAと導入・Refresh手順の出力 |

工程の順序は、前の工程の結果で入れ替えることがあります。その場合は理由を本ファイルに記録します。

### Step1で確定する設計

- MediaKeyの形式（BV＋パートを基本、av/BVの確認済み対応、CIDの扱い、ローカル取り込み曲の扱い）と、既存mediaIdとの関係
- 同期レコードの形（プレイリスト、親子の辺、登録曲、メディア情報）、並び順キー、更新日時と時計のずれの扱い、Tombstoneの保持期間、循環する移動の解決、削除されたリストの子の扱い
- 既存JSON（version 3 / identityVersion 2）と同期レコードの相互変換、移行時のバックアップ
- ZIPのmanifest拡張（既存identity.jsonとの関係、旧ZIPの読み込み）
- iOS側の層（App / Features / Domain / Platform）とJavaScriptCoreで実行する範囲
- DeviceMediaとダウンロード状態の定義（Windows・iOSで共通の意味）
- 認証情報の保存先（Windows：Electron safeStorage、iOS：Keychain）
- 各外部ツール（AltStore/AltServer/ショートカット）とFavecusPlayerの責務の境界
- Supabaseの無料枠の条件（一定期間使わない場合の一時停止など）は公式情報で確認してから採用する

## 現在の工程

Step1：iOS版方針と共通データ仕様の確定（Claude担当。文書のみ、コード変更なし）。完了後、Step2の指示をここへ記載します。

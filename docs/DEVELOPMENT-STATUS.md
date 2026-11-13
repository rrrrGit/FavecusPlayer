# FavecusPlayer 開発状況

更新日：2026-11-13（日本時間）
対象：v0.7.0 / `release/v0.7.0`
現在地：Step5（5-1〜5-3）完了。実Electron（Windows）で拡大・Esc・トレイ格納を確認済み。Bilibili実通信・実機の通常操作は未確認。次はStep6（同期の共通基盤）。
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

共通処理の方針（既存JSを正本としJavaScriptCoreで実行、代替はSwift再実装）とファイル配置は、Step1で確定し `docs/DESIGN.md` 冒頭「v0.7.0」節に記載しました。Step3で実証します。

## 検証の区別

各Stepの報告では次を分けて記録し、未実施を成功と扱いません。

- Nodeテスト・構文検査（この開発環境で実行）
- iOSのシミュレーターでのビルド・テスト・スクリーンショット（GitHub ActionsのmacOS環境）
- iPhone実機での操作（AltStore経由の導入。ユーザーが確認）
- Windows実機・実Electron
- Bilibili実通信、Supabase実通信
- Windowsの全体ビルド・Patch生成（Step20・21のみ）

GitHub ActionsのmacOS標準ランナーは公式ページで$0.062/分（Linux 2コアは$0.006/分）、GitHub Freeの含有利用は$12/月と確認しました。分数への換算（macOSで約194分）は公式値ではなく概算です。公式の「倍率」表記は見つかっていません。iOS関連の変更があるときだけ実行し、実行時間を記録します。

## 全工程と完了条件

| 工程 | 状態 | 完了条件・範囲 |
| --- | --- | --- |
| Step0 開始と全体計画 | 完了 | `release/v0.7.0` 作成、v0.6.7記録の移動、全体計画・役割分担の記載 |
| Step1 iOS版方針と共通データ仕様 | 完了 | 設計をDESIGN.md冒頭「v0.7.0」節へ確定（コード変更なし）。判断1〜3は確定済み |
| Step2 iOSビルド基盤の検証 | 完了 | XcodeGenの最小SwiftUIアプリをCIでビルド・テストし、署名なしIPAを取得。AltStore経由でiPhone 16e（iOS 26.7.2）へ導入し起動を確認 |
| Step3 共通処理のiOS実行 | 完了 | 共通JSの束ね方とJSContextでの実行を実装し、共通テストデータ116件をNodeとiOSシミュレーターの両方で全件一致。999リスト・約1万登録の速度をシミュレーターで計測 |
| Step4 MediaKeyと端末依存情報の分離 | 完了 | SyncMediaKey・DeviceMediaを共通JSとWindows版（読み取り専用の投影）へ導入。保存形式は変更せず、共通テストデータ158件で確認 |
| Step5 Windows版の改善 | 完了（実Electronで主要動作を確認） | ユーザー提示の8項目（`C:\Dev\v0.6.7改善点`）。5-1 ホーム・再生バー／5-2 ×でトレイ格納／5-3 オリジナルのプレイヤーUIと拡大。実Electron 44.2.0で、拡大・Esc・×のトレイ格納を確認（Bilibili実通信・Windowsの実キー操作・シャットダウンは未確認）。下記「Step5の計画」 |
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
| Step16 AltStore実機導入手順 | 未着手 | AltServerの自動起動、同一Wi-Fi、信頼済み、必要なApple関連部品、Background Refreshの確認手順。アプリデータを保ったままのRefresh確認。PCを再起動しないとRefreshできないのかを実機で確認 |
| Step17 毎日の自動Refresh | 未着手 | ショートカットのPersonal Automationによる毎日のRefresh Apps、失敗・残り日数・手動更新方法の確認手順と、翌日の再試行の確認。Refresh成否の確認はAltStoreの「My Apps」の残り日数（7日へ戻るか）、「View App IDs」の期限、ホーム画面ウィジェット（iOS 17以降）で行う。AltServer側の成功通知の有無は未確認 |
| Step18 Windows版の同期・ZIP画面 | 未着手 | 同期状態・ログイン・ZIP出力の画面をWindows版へ接続し、操作プレビューで確認 |
| Step19 全体検証 | 未着手 | 全Nodeテスト、iOSテスト、共通テストデータ、実機・実通信の確認範囲の集約 |
| Step20 全体ビルド | 未着手 | Windowsの全体ビルドと版更新、iOSの署名なしIPA |
| Step21 最終出力 | 未着手 | Windows Patchと説明・検証情報、iOS IPAと導入・Refresh手順の出力 |

工程の順序は、前の工程の結果で入れ替えることがあります。その場合は理由を本ファイルに記録します。

### Step1の結果

確定した設計は `docs/DESIGN.md` 冒頭「v0.7.0：iOS版・同期の方針と共通データ仕様」に集約しました（本書へ重複して書きません）。判断1〜3（Supabase採用、自端末間のvideoAliases同期、Tombstone 90日）は2026-11-13にユーザーが確定しました。iPhone画面はStep15でユーザーのUI案を受けて決定します。

公式ページ未確認の事項（Supabaseの自動停止後の復旧手順・「非活動」の定義、AltStoreの無料アカウント明記・Background RefreshとAltServerの関係、ショートカットの手順）は、該当工程の前に確認します。GitHub ActionsのmacOSは$0.062/分、Freeの含有は金額$12/月と確認しました（分数換算は概算）。

## 今後の懸念点（未確認・現工程の完了条件には含めない）

運用はAltStore（AltServer）を前提とする。以下は不明のまま残し、いずれ確認が必要な事項として記録する。
- 2台のPC（Aデスクトップ・Bノート）のどちらからでも、1台のiPhoneのAltStoreの期限更新ができるかは不明。Bで別途サインインすると、無料Apple Accountの開発用証明書の上限により、Aで作成した証明書が失効し、アプリが次のRefreshまで動かなくなる可能性がある（第三者資料のみ・公式未確認。証明書の上限数も未確認）。確認時は、Aで導入→Bでサインイン・更新→Aで再更新、アプリデータの保持、両PC同時起動時の挙動を見る。
- PCを7日以上起動できない場合は、AltStoreでは期限が切れる。SideStore（iPhone単体で更新できるとされる）は公式資料を取得できておらず未評価。

## IPAのGoogleドライブ出力（運用）

- 保存先：マイドライブの `FavecusPlayer/ios`（PCのGoogle Drive for desktopの同期フォルダー。Windowsでは `G:マイドライブFavecusPlayerios`）。ファイル名は `FavecusPlayer-<コミット7桁>-run<ID>.ipa`。
- 実行する場面：実機のiPhoneで検証が必要なStepで、iOSのCIが成功し署名なしIPAが生成されたごとに、Claudeが `node scripts/fetch-ipa.cjs` を実行して保存し、ユーザーへ知らせる（実機検証が不要なStepでは実行しない）。ユーザーはiPhoneの「ファイル」アプリでドライブのIPAを選び、AltStoreの `+` から導入する。
- 認証情報はGitHub（gh CLIの既存ログイン）とDriveのPC側サインインのみ。クラウドへのGoogle認証情報の保存・CIからのアップロードは行わない。同名のIPAがある場合は上書きしない。古いIPAは自動削除しない（ユーザーが整理する）。
- **導入は、iPhoneをUSBでPCにつないだ状態で行う**（2026-11-13にユーザーが確認。USBなしではAltServerが端末を見つけられず、エラー2003「AltServer could not find this device」になった。Wi-Fi経由には、iTunesのWi-Fi同期の有効化・iTunesHelperの常駐・PCのネットワークの種類（プライベート）・同一ネットワークが必要で、未達成）。
- 保存先が見つからないとき（Driveの未サインインなど）は `--dir` で指定する。Artifactの保持期間は14日。

## 現在の工程

Step4完了。次はStep5（Windows版の改善）です。Step5の内容はユーザーの指示を受けて決めます。指示がなければStep6（同期の共通基盤）へ進むこともできます。

### Step5-3の結果（⑤⑥）

- ユーザーの回答（2026-11-13）：DL済み動画の画質切替は **(a) 再ダウンロードで切替**。保存形式は変更しない。
- 範囲：ユーザーのスクリーンショットの操作画面（⋮メニューに「ダウンロード」「再生速度」「ピクチャーインピクチャー」）はChromiumの標準 `<video controls>` で、保存済み・ローカル再生の `local.html` が該当する。ここを独自UIに置き換えた。**オンラインのBilibili再生はBilibili自身のプレイヤーの操作のまま**（サードパーティのページの書き換えはしない。画質もBilibili側の設定）。標準の「ダウンロード」「再生速度」「PiP」のメニューは無くなる。
- 拡大（⑥）：状態を `main.cjs` の `videoFullscreen` が一元管理。入口は、下部の再生バーの拡大ボタン（`player:fullscreen`）、ローカル再生画面の拡大ボタン・動画のダブルクリック（`media:fullscreen`）、Bilibili自身の全画面ボタン（`enter-html-full-screen`）。入ると動画ビューをウィンドウ全体へ広げ、アプリ起点のときは `win.setFullScreen(true)` も行う。**出口**：Esc（動画側・メイン側の `before-input-event`）、`leave-html-full-screen`、ウィンドウの `leave-full-screen`・`hide`・`minimize`、動画ビューの入れ替え・停止（`CloseView`）、モーダル・曲モード・音声のみ・再生なし、画面側が動画を表示しないと報告したとき。動画が見えていないときは入らない（Bilibiliの全画面で入れない場合はHTML全画面を解除）。同じ再生画面のまま次の曲へ進むときは維持する。
- ローカル再生画面の独自UI（`local.html` / `local.js` / `style.css`）：再生・一時停止、再生位置、時間、拡大、保存済みの画質（例：720p）。カーソルが止まると隠れる。ボタンにフォーカスを残さない（Spaceの二重動作の防止）。音量は下部の再生バー（preloadが全体の音量を管理するため、ここでは持たない）。CSPのため、アイコンはインラインSVG、スタイルはクラスのみ。
- 画質（a）：`local.html` のURLに保存済みの形式と高さ（`kind` / `height`、検証済みの数値）を渡して表示。「別の画質で保存し直す…」は `media:quality` → mainが現在の曲だけを使って `change-quality` を通知 → 既存の「この動画のみをダウンロード」画面を開く。新しい画質は保存後の次の再生から。再生中のファイルは保持され、Step4-2の仕組みで後から整理される。
- セキュリティ：ページからmainへ送れるのは、`favecus://app/local.html` だけ（`media.cjs` のpreloadもこのページにだけ `favecusPlayer` を公開）。mainは送信元が現在の再生ビューのメインフレームで、URLが `local.html` であることを検証し、ページから引数を受け取らない。公式プレイヤー（player.bilibili.com）や他の送信元は拒否する。
- 下部の再生バーに拡大ボタンを追加（オンライン再生にもアプリ側のボタンがある）。
- 検証：`test/main-040.test.cjs` に6件（拡大の出入り・Esc・stale状態の防止・Bilibili全画面・IPCの送信元検証・画質URLと要求）、`test/ui-046.test.cjs` に1件、`SavedURL` の代用DOMを更新。全493件のうち、成功481・失敗9・スキップ3で、失敗9件は既知の環境起因とテスト名が一致。`node scripts/check.cjs`：123ファイル成功。
- 操作プレビュー（**模擬**）：一時的な確認ページで、模擬の長さ・位置・状態に `local.html` と `local.js` を動かし、操作部品・画質のメニューの見た目を確認した（動画・拡大・画質の実処理は含まない。確認用ページはGitに入れていない）。
- **実Electronでの確認（2026-11-13、Windows、electron 44.2.0、`npm ci` で導入）**：データは一時フォルダー（`FAVECUS_TEST_DIRECTORY`）だけを使い、ユーザーの実ライブラリには触れていない。テスト用のWebM（Electron自身で生成した動画＋音声）をローカル曲として再生し、本物の `main.cjs` を `NODE_OPTIONS=--require` の運転スクリプトで操作した（スクリプト・生成物はGit管理外）。確認できたこと：
  - ローカル再生画面で独自の操作が表示される（標準の `controls` は無効、`favecusPlayer` は `fullscreen`/`changeQuality` のみ公開、コンソールのエラー・CSP違反なし）。スクリーンショットで、再生・時間・再生位置・拡大の表示を確認。
  - 再生バーの拡大ボタン（renderer→main）：ウィンドウが全画面になり、動画ビューが全体（1920×1080）に広がる。Esc（動画側）で元の枠（584×600）に戻り、ウィンドウの全画面も解除される。
  - ローカル再生画面自身の拡大ボタン（`contextBridge`→`media:fullscreen`）：入る・戻るとも成功。
  - HTML全画面（Bilibili自身の全画面ボタンと同じ `requestFullscreen` の経路）：`WebContentsView` では動画ビューは自動では広がらないが、`enter-html-full-screen` を受けた `main` がビューを全体へ広げ、Escで `document.fullscreenElement` も窓の全画面も解除された。
  - ×ボタン（`win.close()`）：ウィンドウは破棄されず非表示になり、再表示できた（トレイのアイコンが作成されている）。
  - 確認中に、テスト動画（約6秒）の再生終了で再生ビューが閉じる動作に当たったが、これは通常動作（動画の入れ替え・停止で拡大が解除される）であり不具合ではない。
- **未確認**：Bilibili実通信（Bilibili自身のプレイヤーと全画面ボタン）、実際のキーボード・マウス操作（今回は `sendInputEvent` と `executeJavaScript`）、保存済み動画（`favecus://offline`）での画質チップと「別の画質で保存し直す」の実画面、ホームのカードのhoverとサムネイル（実Electron）、Windowsのシャットダウン・ログオフ・Patch実行、複数ディスプレイ・DPI。

### Step5-2の結果

- 対象：⑧「バツボタンを押したときにトレイにしまう。通知は都度出さない」。
- 実装（`src/main.cjs`）：メインウィンドウの `close` で `preventDefault` して `win.hide()`。通知は出さない。**次のときは通常どおり閉じる**：終了中（`before-quit`）、OSの終了要求（`query-session-end`／`session-end`）、トレイのアイコンが使えないとき（再表示できなくなるため。`MiniPlayer.CanHideToTray()`）。`query-session-end` は `preventDefault` せず、30秒間だけ閉じる側に倒す。終了は既存のトレイの右クリック「終了」、再表示はダブルクリックまたは「プレイヤーを開く」、再起動したアプリ（second-instance）でも既存の `mini.Restore()` で戻る。
- Electronの記述の確認（context7）：Windowsのシャットダウン・ログオフでは `before-quit` が発火しない。`session-end` の reasons に `close-app`（更新ツール等の終了要求）がある。このため、終了を妨げないよう `sessionEnding` を立てる。
- Patch：Patchは起動中のアプリを自動では止めない（手順は「アプリを終了してからPatchを実行」）。×ではプロセスが残るようになるため、GUIDE.md／GUIDE.htmlの更新手順と、`scripts/install-core.cjs` の旧名フォルダー変更失敗の案内に「通知領域のアイコンを右クリックして終了」を追記した。
- 設定項目は追加していない（保存データの形式は変更なし）。
- checker（Sonnet）の指摘を反映：`session-end` で30秒タイマーを解除（以後は戻さない）。「アプリを閉じてから」と案内する他の箇所（`native/main.c` のミューテックス検出時のエラー、`scripts/package-release.py` の説明文、アプリ内「バージョン更新」の注記）にも「×では通知領域に残る。通知領域のアイコンから終了」を追記した。**`native/main.c` はこの環境でコンパイルできず未確認**（文字列のみの変更。Windowsのビルドと検証はStep20で行う）。`package-release.py` もPython未導入のため未実行。
- 知っておく挙動：×で隠した状態は「前面から外れた」扱いのため、設定した時間（自動切り替えが有効な場合）の後に既存の仕組みで曲モードへ自動切替し、通知を出す。最小化と同じ既存動作で、今回は変更していない。Restart Manager（close-app）が隠れたプロセスへ閉じる要求を送るか、シャットダウン取消し時に `session-end` が発火するかは、実機で未確認。タスクマネージャーの「タスクの終了」（強制でない終了要求）は×と同じく閉じる要求が取り消され、アプリが残る（仕様上の割り切り）。
- 検証：`test/main-040.test.cjs` に4件（格納・終了中・OS終了要求・トレイなし）と、`test/update-030.test.cjs` に1件（`CanHideToTray`）。関連76件成功。全486件のうち、成功474・失敗9・スキップ3で、失敗9件は既知の環境起因とテスト名が一致。`node scripts/check.cjs`：123ファイル成功。
- 実Electronでの確認（5-3と同じ運転スクリプト）：×（close）でウィンドウが破棄されず非表示になり、再表示できた。未確認：トレイのアイコン操作（クリック・右クリックメニュー）、隠れている間の再生継続と曲モード自動切替（一定時間後）、実際のシャットダウン・ログオフ・Patch実行時の挙動、explorer再起動でトレイのアイコンが消えた場合（検出できない）。

### Step5-1の結果

- 対象：①プレイリスト画像設定の削除 ②ホームのサムネイル ③カードのhover操作と三点メニュー ④配置の参考 ⑦「DL済み」の高さ。
- ①：編集画面の画像設定、`choosePlaylistIcon`・`library:choose-icon`、左ツリーとホームでの表示を削除。**保存済みの `icon` は読み込み・保存で保持**（`library-data.cjs` / `playlist-icon-data.cjs` / `store.cjs` は変更なし。`playlist-properties` は `icon` キーが無ければ既存値を保持するため、ListMenuの保存で消えない）。`playlist-icon.cjs`（縮小処理）は未使用になったが、テスト・検証資料のために残した。
- ②：先頭曲＝リスト自身の先頭、なければ子孫を含む走査順（再生と同じ順）の先頭。取得は既存のListArtworkで、見えているカードだけ・同時2件。カードは正方形のため、128×72の既存の画像では拡大でぼやけるので、`library:thumbnail` の第4引数 `'cover'` で、中央を正方形に切り出した最大300pxのJPEG（`CoverImage`）を使う。種類ごとにキャッシュ。曲がない・取得できないときは音楽アイコン。
- ③：画像の左上にチェック（外しているリストは常に枠を表示）、右下に再生（曲がないリストは非表示）、右上に三点メニュー（再生・シャッフル再生・子リストを見る）。下の「子リスト N ›」は残した。メニューは外側のpointerdownとEscで閉じ、同時に1つだけ。シャッフル再生は既存の `shufflePlay` と同じく全体のシャッフル設定をオンにして、そのリストをシャッフルで再生する（カード単位の設定ではない）。配置はYouTube Musicの構成を参考にしただけで、素材・アイコンは使っていない。
- ⑦：バッジがタイトル行の中にあり、行の中心が10pxずれていた。`#now-saved` を `.now-copy` の外へ移し、1440・1280・980の幅で、バッジとシャッフルボタンの中心が一致することを実測した（模擬ブラウザー）。
- 検証：関連テスト133件成功（ホーム・ツリー・サムネイル・main・UI）。全481件のうち、成功469・失敗9・スキップ3で、失敗9件は既知の環境起因とテスト名が一致。`node scripts/check.cjs`：123ファイル成功。checker（Sonnet）の指摘（曲がないリストで `hidden` の再生ボタンがCSSで消えない）を修正し、Esc・外側クリック・メニューの同時1つ・再生ボタンの非表示のテストを追加。
- GUIDE.md/GUIDE.html：ホームのカードの説明を更新し、画像設定の記述を削除（`marked` が未導入のためGUIDE.htmlは同じ文面に手で更新）。
- 操作プレビュー（**模擬**）：`node scripts/preview.cjs --demo` を起動して `http://127.0.0.1:4187/?preview=1` を開く。実画面のコードに、階層・全体再生から外したリスト・空のリスト・長い名前のリストの模擬データと、生成したサムネイルを使う。外部通信なし。ホームのカード、hover、メニューの開閉、再生バーのバッジの位置を、模擬ブラウザーで確認した。
- 未確認：実Electron/Windowsでの表示、実際のBilibiliのサムネイルの見た目と取得（cover JPEGの大きさ、極端に高精細な画像での131072文字の上限）、実機でのキーボード操作・Tab移動。

### Step5の計画（2026-11-13、ユーザー提示 `C:\Dev\v0.6.7改善点\改善点 v0.6.7.txt`）

提示された項目と、割り当てる小工程です。バージョン番号は変更しません（Step20）。UI変更は操作プレビューで確認し、模擬と実Electronの確認を分けて記録します。

| 小工程 | 項目 | 方針 |
| --- | --- | --- |
| 5-1 ホーム・再生バー | ①プレイリスト画像設定の削除 ②ホームのサムネイルを先頭曲に ③ホームカードの hover操作と三点メニュー ④YouTube Music構成を参考 ⑦「DL済み」の高さ | ①はUIとIPCと表示だけを削除し、**保存済みの icon は読み込み・保存で保持**（library-data / ValidateIcon / playlist-icon-data は変更しない。変更すると起動時の保存でデータが消える、または初期化される）。②先頭曲＝リスト自身の先頭、なければ子孫を含む走査順（再生と同じ順）の先頭。空リストは音楽アイコン。③カード画像の左上にチェック、右下に再生、右上に三点（再生・シャッフル再生・子リストを見る）。下の「子リスト N ›」は残す。④は配置の参考のみで、素材・アイコンは流用しない |
| 5-2 トレイ格納 | ⑧×でトレイへ。毎回の通知は出さない | closeでhide（終了中は閉じる）、トレイの「終了」で終了。OSのシャットダウン・ログオフ時に隠れたウィンドウが妨げないこと、Patch/Setupの「アプリ停止」確認が引き続き働くことを確認 |
| 5-3 プレイヤーUI | ⑤オリジナルのプレイヤーUI（画質切替・拡大ボタン等）⑥動画モードで画面全体に拡大 | 着手前に設計を確定。拡大はアプリ側で動画ビューを画面全体に広げ、Escで戻す案 |

5-3の判断待ち（ユーザー）：保存済み動画は、現状は1つの動画・形式につき1つの画質しか保持しません（新しい画質を保存すると古い画質を整理）。「DL済みの画質からの切替」の実現方法を選んでください。(a) 保存済みの画質を表示し、切替は再ダウンロードで行う／(b) 1つの動画に複数の画質を保持する（カタログ形式の変更と移行、容量増）／(c) 画質の切替はオンライン再生のみ。5-1・5-2はこの回答を待たずに進めます。

### Step4の結果

- 設計は `docs/DESIGN.md` の「SyncMediaKeyとDeviceMedia（Step4で実装）」に記載しました（重複して書きません）。**保存形式は変更していません**（書き込みなし。移行・原本保護の対象なし）。
- 追加：`src/core/device-media.cjs`、`library-identity.cjs` に `LibrarySyncKey` / `LibrarySyncKeyForms` / `AuditIds` / `SYNC_KEY`、`OfflineLibrary.DeviceMedia()`（読み取り専用）、`test/sync-identity.test.cjs`（7件）、共通テストデータ42件（計158件）。共有JSの許可リストとiOSワークフローのpathsに `device-media.cjs` を追加し、`src/` の共有モジュールがpathsから漏れると失敗するテストを追加しました。
- Nodeの検証：新規9件と、更新した共通テストデータ158件（ECMAScriptのみのvm）が成功。`node scripts/check.cjs`：123ファイル成功。全478件のうち、成功466・失敗9・スキップ3（checker指摘の修正後に新規テスト2件を追加。失敗9件は同じ名前）。失敗9件は、Step3で記録した既知の環境起因（symlink権限・FFmpeg・ZIP64）と**テスト名が一致**することを確認しました。
- ID点検：過去版（v0.6.2以降）のIDは `randomUUID` で作られ、旧形式から移行するIDも検証時に再割当されるため、同期前のID付け替えは不要と判断しました（根拠はDESIGN.md）。
- iOSシミュレーター（CI run 43385142284、コミット 6db1e92）：成功。フィクスチャ158件が失敗0（Nodeと同じ結果）。計測は検証461ms・共有出力413ms・検索インデックス36ms・取り込み計画169ms（シミュレーター）。実機検証は不要なStepのため、IPAのドライブ保存は行いません。macOS実行は1回（約8分、概算$0.5）で、累計は約37分・概算$2.3です。
- checker（Sonnet）の指摘を反映：保存済みの videoId/part はURLの正規形と一致するときだけ使い、食い違えばURLを正にした（フィクスチャも修正）。投影と点検は不正な入力で例外を出さず、実体確認の例外は未保存扱いにした。
- 未確認：iPhoneのJavaScriptCoreでの結果はCI（シミュレーター）のみ。Step6で同期レコードとして使う際の、aliasの確認順序による昇格の扱い。

### Step3の結果

- 設計と判断は `docs/DESIGN.md` の「共通JSのiOS実行（Step3）」に記載しました（重複して書きません）。
- 追加：`scripts/build-shared-bundle.cjs`、`scripts/update-shared-fixtures.cjs`、`shared/runtime/`（prelude / fixture-runner）、`shared/fixtures/cases.json`（116件）、`test/shared-runtime.test.cjs`、`ios/FavecusPlayer/Core/SharedCore.swift`、`ios/FavecusPlayerTests/SharedCoreTests.swift`。画面に実機計測用の仮ボタンを追加。`shared/dist/` は生成物でGit管理外。Windows版の `src/` は変更していません。
- Nodeの検証：新規9件すべて成功（ECMAScriptのみのvmでの全フィクスチャ、Node本来のURLでの期待値の再現、約4万件のURL差分、atob 約2万件、999リストの計測）。`node scripts/check.cjs`：120ファイル成功。全テスト469件のうち、成功457・失敗9・スキップ3。失敗9件はこのWindows環境で symlink作成の権限(EPERM)がないこと、FFmpegの実行、ZIP64の別リーダー検証に起因するもので、変更前の木でも再現する2件を確認しました。残りは同じ原因と考えられますが、1件ずつの切り分けは未実施です（Step11はLinuxで458件成功）。
- iOSシミュレーター（CI run 43380258343、macos-15・Xcode 16.4）：成功。XCTest 2件（SharedCoreTests）を含め全件成功、フィクスチャ116件が失敗0。999リスト・9,990登録の計測（シミュレーター、Macの速度）：検証385ms、共有出力839ms、検索インデックス31ms、検索1ページ6ms、取り込み計画124ms。同じデータのNode（V8、JSContext相当環境）は検証約470ms、共有出力約440ms、検索インデックス27〜30ms、取り込み約130ms（3回計測）。
- 同じ検証の再実行（run 43381507980、検証ロジックの厳密化後）も成功し、フィクスチャ116件は失敗0でした。計測値はCIの共有ランナー上でばらつきが大きく、検証は385ms（1回目）と1,111ms（2回目）、取り込み計画は124msと264msでした。単発の値を性能の根拠にせず、実機の計測でも複数回の値を見ます。
- macOS実行時間：ジョブ全体で約9分（ビルド・テスト約8分）、概算$0.56（$0.062/分）。Step2と、Step3の2回の実行を合わせて約29分、概算$1.8（GitHub Free含有$12/月の約15%）。スクリーンショットは手動実行の選択制にしました。`paths` に共通JSの正本とshared/を追加し、共通処理の変更でiOS検証が必ず走ります。
- checkerによるStep2・3の確認：確定した欠陥は、非ASCIIホスト（全角など）をNodeが許可ホストへ正規化して受理する場合にpreludeが拒否する点の、コメントと分類基準の不正確さでした。コメントを事実に合わせ、divergenceケースを 'Invalid URL' による拒否に限定して検査するよう修正しました。この相違そのものは許容します（Windowsは受理・iOSは拒否）。ファズ約60万件の追加比較で、結果が異なる入力は見つかりませんでした。
- 未確認：`Intl.Collator` の順序差（Step8）、ローカルMacでのxcodegen。
- **実機（iPhone 16e、AltStore経由、2026-11-13、ユーザー）**：999リスト・9,990登録の4回の計測（ms、検証／共有出力／検索インデックス／検索1ページ／取り込み計画）。1回目 1095／1141／23／3／286、2回目 1026／1036／22／3／260、3回目 1077／1092／21／5／273、4回目 1097／1121／23／2／275。検証は約1.03〜1.10秒、共有出力は約1.04〜1.14秒、取り込み計画は約0.26〜0.29秒、検索は1ページ数ms（インデックス作成は約20ms）でばらつきは小さく、シミュレーター・Nodeの約2倍の1秒台で安定しています。実用範囲と判断します。JITの有無と電源状態（計測時のバッテリー約51〜54%、充電中の表示）の影響は未確認です。
- 実機への導入手順（参考）：GitHub Actionsの該当実行のArtifact `ios-outputs`（保持14日）から `FavecusPlayer-unsigned.ipa` を取得し、AltStoreで入れ直して（同じアプリの更新）、「共通処理の速度を計測」ボタンを押すと数値が表示されます。

### Step2の結果

- 追加：`ios/project.yml`（XcodeGen）、仮の最小SwiftUI画面（`ios/FavecusPlayer/`）、単体テスト2件（`ios/FavecusPlayerTests/`）、`.github/workflows/ios.yml`。`.pbxproj`・IPAはGitへ入れず、CIで生成します。Windows版・既存テスト・バージョン番号は変更していません。
- CI実行（macos-15、Xcode 16.4、run 43327091224）：成功。シミュレーターでのビルド・テスト（2件成功・失敗0）、スクリーンショット、署名なしIPA（約11KB）を取得し、Artifact `ios-outputs`（保持14日）に保存しました。スクリーンショットは画面の表示（FavecusPlayer 0.7.0）を目視確認しました。
- 実行条件：`release/v0.7.0` へのpushで `ios/**` またはworkflowが変わったときと、手動実行のみ。同一ブランチの古い実行は取り消します。
- macOS実行時間：ジョブ全体で約11分（ビルド・テスト約2分22秒、スクリーンショット約6分46秒＝シミュレーター起動待ちが大半、IPA約27秒）。$0.062/分で換算すると約$0.7（概算）で、GitHub Freeの含有$12/月の約6%。GitHub側の実際の課金表示は未確認です。起動待ちの短縮はStep3以降で検討します。
- **実機確認（2026-11-13、ユーザー）**：iPhone 16e（iOS 26.7.2）へAltStore経由で導入でき、起動して「FavecusPlayer 0.7.0」の画面が表示されました。AltStoreの「My Apps」ではAltStoreとFavecusPlayerがActiveで、どちらも期限7日、「8 App IDs Remaining」の表示でした。
- 未確認：AltStore自体が有効アプリ3枠を使うか（表示だけでは判断不可）、7日後のRefresh（Step16・17）、デベロッパモードの項目が現れた時点と有効化の操作（ユーザーの操作の詳細は未記録）。

### 実機導入の手順（Step2で確認。Step16で詳細化・整理）

前提：Windows PC、iPhone、USBケーブル、Apple Account（無料、個人利用）。パスワードと確認コードは本人だけが入力し、記録・共有しない。

1. **PCに部品を導入**（wingetで導入済み。いずれもApple・AltStore公式の配布物）：`Apple.iTunes`（Microsoft Store版ではない）、`Apple.iCloud`（Legacy 7.21、導入後にPC再起動）、`RileyTestut.AltServer`（1.8.00）。`winget install --id <ID> --exact --source winget --interactive` で、UACと使用許諾は本人が操作する。iCloudへのサインインは不要（求められたら「キャンセル」）。
2. **IPAの取得**：GitHubの該当Actions実行ページ下部のArtifact `ios-outputs` をダウンロード・展開し、`FavecusPlayer-unsigned.ipa` を得る。
3. **iPhoneをUSBでPCに接続**し、iPhone側で「このコンピュータを信頼」を選ぶ。iTunesがiPhoneを認識し、自動バックアップが始まるが、導入には不要（中止してよい）。
4. **iTunesで「Wi-Fi経由でこのiPhoneと同期」を有効にして適用**（USB接続だけの初回導入には必須ではないが、Refreshに必要）。
5. **AltServerを起動**（管理者として実行、プライベートネットワークの許可は「許可」）。タスクトレイのアイコンから「Install AltStore」を選び、iPhoneを選ぶ。Apple Accountのメールとパスワードを入力し、iPhoneに届く確認コードを、PCに出る入力画面へ入力する。入力画面が見えないときは、Alt+Tabやタスクバーで探す。時間切れのときはAltServerを終了して再起動し、やり直す。
6. **iPhoneで開発者を信頼**：AltStoreは入るが、初回起動時に「信頼されていないデベロッパ」と出て開けない。「設定 → 一般 → VPNとデバイス管理」の「デベロッパAPP」の自分のApple Accountを開き「信頼」を押す。
7. **デベロッパモード**：項目は導入前には表示されない。AltStore導入後に「設定 → プライバシーとセキュリティ」の一番下に現れる場合があり、求められたらオンにして再起動し、確認で有効化する。
8. **AltStoreを起動**し、Apple Accountでサインインする。
9. **FavecusPlayerのIPAを選ぶ**：IPAをiPhoneの「ファイル」アプリへ送る（今回はGoogleドライブにアップロードし、iPhoneのドライブアプリから「ファイルに保存」）。AltStoreの「My Apps」で `+` を押し、そのIPAを選ぶ。Apple Accountのパスワードを求められたら本人が入力する。
10. ホーム画面のFavecusPlayerを起動し、表示を確認する。

### PC再起動後の動作（確認済みの登録）

- 自動で起動する：`AltServer`（ユーザーのログオン時）、`iTunesHelper`、`iCloudServices`。いずれもスタートアップ（Run）に登録済み。AltServerは通常権限で起動する。
- 毎回の操作は不要。ただし、7日ごとのRefresh（AltStoreの「Refresh All」またはBackground Refresh）にはPCが起動していてAltServerが動き、iPhoneと同じWi-Fiにあることが必要（公式FAQの記載）。管理者権限でないと動作しない場合は、「管理者として実行」へ切り替える（Step16で確認）。

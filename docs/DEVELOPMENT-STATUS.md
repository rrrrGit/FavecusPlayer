# FavecusPlayer 開発状況

更新日：2026-11-13（日本時間）
対象：v0.7.0 / `release/v0.7.0`
現在地：Step3完了（共通JSのiOS実行をシミュレーターと実機で確認）。次はStep4（MediaKeyと端末依存情報の分離）。
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

Step3完了。次はStep4（MediaKeyと端末依存情報の分離）です。

### Step3の結果

- 設計と判断は `docs/DESIGN.md` の「共通JSのiOS実行（Step3）」に記載しました（重複して書きません）。
- 追加：`scripts/build-shared-bundle.cjs`、`scripts/update-shared-fixtures.cjs`、`shared/runtime/`（prelude / fixture-runner）、`shared/fixtures/cases.json`（116件）、`test/shared-runtime.test.cjs`、`ios/FavecusPlayer/Core/SharedCore.swift`、`ios/FavecusPlayerTests/SharedCoreTests.swift`。画面に実機計測用の仮ボタンを追加。`shared/dist/` は生成物でGit管理外。Windows版の `src/` は変更していません。
- Nodeの検証：新規9件すべて成功（ECMAScriptのみのvmでの全フィクスチャ、Node本来のURLでの期待値の再現、約4万件のURL差分、atob 約2万件、999リストの計測）。`node scripts/check.cjs`：120ファイル成功。全テスト469件のうち、成功457・失敗9・スキップ3。失敗9件はこのWindows環境で symlink作成の権限(EPERM)がないこと、FFmpegの実行、ZIP64の別リーダー検証に起因するもので、変更前の木でも再現する2件を確認しました。残りは同じ原因と考えられますが、1件ずつの切り分けは未実施です（Step11はLinuxで458件成功）。
- iOSシミュレーター（CI run 43380258343、macos-15・Xcode 16.4）：成功。XCTest 2件（SharedCoreTests）を含め全件成功、フィクスチャ116件が失敗0。999リスト・9,990登録の計測（シミュレーター、Macの速度）：検証385ms、共有出力839ms、検索インデックス31ms、検索1ページ6ms、取り込み計画124ms。同じデータのNode（V8、JSContext相当環境）は検証約470ms、共有出力約440ms、検索インデックス27〜30ms、取り込み約130ms（3回計測）。
- 同じ検証の再実行（run 43381507980、検証ロジックの厳密化後）も成功し、フィクスチャ116件は失敗0でした。計測値はCIの共有ランナー上でばらつきが大きく、検証は385ms（1回目）と1,111ms（2回目）、取り込み計画は124msと264msでした。単発の値を性能の根拠にせず、実機の計測でも複数回の値を見ます。
- macOS実行時間：ジョブ全体で約9分（ビルド・テスト約8分）、概算$0.56（$0.062/分）。Step2と、Step3の2回の実行を合わせて約29分、概算$1.8（GitHub Free含有$12/月の約15%）。スクリーンショットは手動実行の選択制にしました。`paths` に共通JSの正本とshared/を追加し、共通処理の変更でiOS検証が必ず走ります。
- checkerによるStep2・3の確認：確定した欠陥は、非ASCIIホスト（全角など）をNodeが許可ホストへ正規化して受理する場合にpreludeが拒否する点の、コメントと分類基準の不正確さでした。コメントを事実に合わせ、divergenceケースを 'Invalid URL' による拒否に限定して検査するよう修正しました。この相違そのものは許容します（Windowsは受理・iOSは拒否）。ファズ約60万件の追加比較で、結果が異なる入力は見つかりませんでした。
- 未確認：`Intl.Collator` の順序差（Step8）、ローカルMacでのxcodegen。
- **実機（iPhone 16e、AltStore経由、2026-11-13、ユーザー）**：999リスト・9,990登録で、検証1,095ms、共有出力1,141ms、検索インデックス23ms、検索1ページ3ms、取り込み計画286ms（1回の計測）。検証・共有はシミュレーター・Nodeより遅い（約2倍）が1秒台で、取り込み計画も含め実用範囲と判断します。検索は十分高速です。複数回の値、JITの有無、電源状態の影響は未確認です。
- 実機への導入手順（参考）：GitHub Actionsの該当実行のArtifact `ios-outputs`（保持14日）から `FavecusPlayer-unsigned.ipa` を取得し、AltStoreで入れ直して（同じアプリの更新）、「共通処理の速度を計測」ボタンを押すと数値が表示されます。

# 開発とWindows EXEの再生成

通常利用には配布済みSetup.exe／Patch.exeを使用します。ソースZIPは開発用です。ソースZIPだけをStart.cmdで実行しても、完成済みアプリのインストールにはなりません。

## アプリの開発

Node.js 24以上とnpmを用意した開発環境で実行します。この開発手順は利用者向けSetupの方式とは異なります。

```sh
npm ci
npm start
```

依存ファイルの取得にはインターネット接続が必要です。Electron 44は初回起動時にも本体を取得します。ソース起動でWMAを使う場合は、適切なFFmpeg本体をWindowsならruntime/ffmpeg/ffmpeg.exe、その他ではruntime/ffmpeg/ffmpegに置きます。今回のSetupはWindows用のFFmpegを自動配置します。

再生リスト等のコア処理は標準Nodeモジュールを使っているため、次の確認はnpm ci前でも実行できます。

```sh
node scripts/check.cjs
node --test --test-isolation=none --test-reporter=spec test/*.test.cjs
```

WMA変換とサムネイル抽出のテストは実行環境のffmpegを使用します。0.6.0のダウンロード検証では /usr/bin/ffmpeg が必須です。実際に生成したH.264/AACのストリームをMP4/M4Aへまとめ、圧縮パケットのSHA256が変わらないことを確認します。

## 配布したSetup／Patchの再生成

確認に用いた環境はLinux x86_64、Python 3、GCC、GNU ld（i386pep対応）、libarchiveです。Windowsの通常のコマンドプロンプトだけで完結するビルドではありません。WSL等の開発環境を使用する場合も、これらの依存関係が必要です。Build-Windows.cmdはこの手順書を開きます。

1. 提供されたnode-v24.20.0-x64.msi、またはこれを含む修正点ZIPからNode本体を抽出します。MSIはインストールしません。
2. ソースに含めたNodeのライセンスと抽出したNodeを指定してビルドします。
3. EXEの整合性を確認します。

```sh
python3 scripts/extract-node-msi.py /path/to/node-v24.20.0-x64.msi build-input/node.exe
python3 scripts/build-windows.py --node build-input/node.exe --node-license docs/NODE-LICENSE.txt --output dist/windows
python3 scripts/verify-windows.py dist/windows
python3 scripts/test-windows-startup.py dist/windows
```

Node本体は、添付MSIから検証した93,381,448バイト・SHA256 `5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5` に固定しています。違うバージョンへ更新する場合は抽出・検証・ピン情報も見直します。

生成物はFavecusPlayer.exe、FavecusPlayerTaskbar.exe、Setup.exe、Patch.exe、SHA256SUMS.txtです。埋め込み用ヘルパーはSetup／Patchのapp/buildへ同梱します。SetupとPatchは同じアプリ・Nodeを内包し、保存先選択と既存フォルダーの扱いが異なります。通常利用者にはSetupまたはPatchの一方を渡せば足ります。FavecusPlayer.exeだけでは初回の環境を構築できません。

Electron 44.2.0とFFmpeg 6.1.1の取得元・サイズ・SHA256はscripts/runtime-downloads.jsonに固定しています。Setupが展開先の専用runtimeへ取得し、全ファイルの取得確認後に新しいappフォルダーへ切り替えます。

Windowsの起動本体はruntime/electron-44.2.0/FavecusPlayer.exeです。brand-runtime.cjsがelectron.exeのコピーへ、検証済み同梱ランチャーのアイコン・製品表示を移します。元のelectron.exeと他のリソースは保持します。再利用は原本・ランチャー・出力のハッシュを確認します。Windows上での実更新は別途検証する必要があります。

- [ElectronのWindows配布・リブランド](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Windows UpdateResourceW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-updateresourcew)

## 従来のelectron-builder設定

package.jsonのbuild:win:legacy、build:portable:legacy、build:mac、build:linuxは別方式の開発用設定として残しています。今回配布したSetup／Patch／Maintenanceを生成するものではありません。FFmpegの同梱も別途必要で、今回の動作確認・配布対象には含みません。

## 検証とライセンス

verify-windows.pyはEXEの構造・内包データを調べるもので、Windows上でアプリを起動するテストではありません。配布前にWindows x64でのインストール、更新、修復、再生、ログイン、Discordの実確認を追加できる構成にしていますが、この作業環境では実施できていません。

アプリのコードはLICENSEに従います。Nodeの完全なライセンスはdocs/NODE-LICENSE.txtとruntime/node/NODE-LICENSE.txtに保持します。Electronの配布ライセンスは展開先に保持し、FFmpegのLICENSEとREADMEも本体と併せてダウンロードします。取得元は以下です。

- [Node.js v24.20.0 LICENSE](https://github.com/nodejs/node/blob/v24.20.0/LICENSE)
- [Electron v44.2.0](https://github.com/electron/electron/releases/tag/v44.2.0)
- [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)

## EXE起動入口の追加検証

Linux x64とGCCで次を実行できます。自作EXE専用の検証で、WindowsでのGUI動作テストではありません。

```sh
python3 scripts/test-windows-startup.py dist/windows
```

## バージョンの更新

今回のリリースは0.6.6。以後の小修正はパッチ番号を増やし、package.json、package-lock.jsonのルートとpackages[""].version、src/ui/index.htmlの初期表示、配布ファイル名を同じ番号にする。EXEのバージョン情報はpackage.jsonから自動生成される。

## 説明書HTMLの再生成

GUIDE.md、BUILD.md、DISCORD.md、TASKBAR.mdを編集した場合は、Node.js用Markdownパーサーmarkedを利用できる開発環境で `node scripts/render-guides.cjs` を実行する。完成済みHTMLを同梱するため、通常のインストールや再生ではmarkedは不要。

## タスクバー用ヘルパー

native/taskbar.cを同じWindows x64向けビルドでコンパイルします。新たな外部ライブラリやランタイムを追加ダウンロードする必要はありません。src/core/taskbar-player.cjsが子プロセスとして起動し、標準入出力のパイプで状態と許可済み操作を交換します。

ソースからnpm startで試す場合は、Windows向けビルドで生成したFavecusPlayerTaskbar.exeをbuild/FavecusPlayerTaskbar.exeへコピーします。ヘルパーがない場合は独立した小型画面へフォールバックします。従来のelectron-builder設定ではヘルパーの配置・ASAR外への展開を別途設計する必要があり、今回の配布対象ではありません。

Linux x64とGCCで次のネイティブロジック検証を実行できます。

```sh
python3 scripts/test-taskbar-native.py
```

この検証は実装本体へ模擬Win32 APIを接続します。WindowsのExplorer、GDI描画、実際のパイプ継承やマウス操作は検証できません。詳細な対応範囲はTASKBAR.mdを参照してください。

0.4.3以降の配布方式は固定appフォルダーを使う。ネイティブランチャーとインストーラーを同じ版で生成し、片側だけを配布しない。test-taskbar-native.pyは固定app／旧形式の起動先判定も実装本体で検証する。ソースZIPのStart.cmdは開発用で、通常利用者にはPatch／Setupを配布する。

## 0.4.7の確認範囲

自動テスト137件、失敗0・スキップ0。JavaScript56ファイルの構文を確認した。bilibili-browserはログイン・信頼したローカル画面だけのIPC・選択パート・古い取得結果の破棄、player-recoveryは20秒の期限・一時停止中の準備完了・古い復旧の破棄を検証する。queue-045は次曲予告と実際の再生順の一致・周の境目での追加も確認する。

ui-046は実rendererを模擬DOMで動かし、通常再生でも曲を先頭へスクロールすること、手動スクロール・ドラッグ・検索・設定画面の優先、次曲表示、既存の追加・重複確認への引き継ぎを確認する。main-040の追加ケースは実クラスと模擬Electronを接続し、検索から追加するまでと再生画面の作り直しを検証する。media preloadの準備完了通知も確認した。

既存の保存・持ち出し・タイトル整理・Discord・インストーラー・タスクバーの確認も通過している。これらはブラウザーやWindows実機の表示テストではない。映像停止の再現・解消、実Bilibili・Discordの確認は未実施。

0.4.7ではmain-040で再読み込み後の表示モード・パート・キューの維持と、自動復旧が一度で止まることを確認した。list-artworkは表示中のみの取得、同時2件の上限、古い行への反映防止、画像の縮小、キャッシュの上限を検証する。ui-046はBILIと再生ボタンの間への配置と、画像を取得しても再生操作が起きないことを確認する。library:thumbnailは保存済みのリストID・曲IDだけを受け付ける。

## 0.5.0の追加事項

依存パッケージを増やさず、Node.js標準のcrypto・zlib・fsでZIPと暗号化を実装しています。JSONはリスト単位です。src/ui/library-tree.jsはメインと画面で共有します。テストには階層・アーカイブ・全リスト再生のケースを追加しました。現在の検証結果はDEVELOPMENT-STATUS.md、v0.6.7の検証はVALIDATION-067.md、旧版の検証はVALIDATION-064.mdを参照してください。

## 0.5.1の変更

旧名のフォルダーはインストーラーとdata-migration.cjsで新名へ移行します。移行用の旧名文字列だけは検出処理に残します。新規のファイル、EXE、IPC公開名、プロトコル、AppUserModelIDは新名です。

FVPA0002はランダムなキーを自動生成して同梱し、出力と取り込みの入力をなくしました。秘密保護用の形式ではありません。旧FVPA0001はUIからの取り込み対象外で、旧JSONは読み込めます。

配布物の梱包は `python3 scripts/package-release.py --windows dist/windows-064 --verification ../verification --output ../output` で行います。検証結果はrelease-validationに同梱します。

## 0.5.2の変更

展開状態は画面内の参照経路ごとに管理し、保存済みの階層・再生順とは分離します。window.blurではツールチップだけを抑え、inertはダイアログ表示中だけに使います。曲変更の前面状態同期と明示再生時の追従再開は、それぞれmainとQueueFollowerが担当します。

## 0.5.3の変更

parent-picker.jsは親を単一選択する専用画面です。通常は閉じた階層を表示し、検索中だけ一致する名前への経路を展開します。検索前の開閉状態と実際の選択は別に保持します。library-tree.jsのPathは次曲の所有者とキューのスコープから実際の名前の経路を求め、rendererが次曲欄へ表示します。0.5.2の再生キューとフォーカス・スクロールの処理は維持しています。

## 0.6.0の検証追加

new-core-060は回数記録・重み付き順序・進行監視・画像・Discordデータを、downloads-054は配信選択・通信失敗・中止・カタログ保護・実FFmpegのストリームコピーを検証します。main-040へ前面キー・再生途中の復旧・av/BV照合・保存済み再生を、ui-046へ検索・全一覧・名前編集・確認・履歴・キー設定を追加しました。media-060は360p・手動画質の尊重・公式プレイヤーの位置復元を確認します。過去の変更説明の復旧回数・シャッフル方式は当時の仕様であり、現在はDESIGN.mdの0.6.6仕様を使います。

## 0.6.1の検証追加

fixes-061は保存専用通信・Cookieの送信先・サムネイル補完・保存データの別名解決・一覧順序・Discordの画像とリンクを確認する。main-040では破棄中の同期focusと失効frame、再試行終了後の再読み込み、保存メディアと画像のネット不要再生・Range配信を確認する。revisionは0.6.0の最上位設定からruntime/configへの移行と切り替え後の失敗復元を確認する。実機の警告文は未取得で、特定のクラッシュを再現できたとは扱わない。

0.6.2の修復EXEの配置はruntime/config/Maintenance.exeです。通常の配布フォルダー直下はapp、downloads、runtime、FavecusPlayer.exeとします。

release-066とui-046で階層取り込み、位置指定ドロップ、保存開始と容量推計を検証する。前版の検証範囲はVALIDATION-066.md、v0.6.7の検証はVALIDATION-067.mdを参照する。

## v0.6.7の工程と確認範囲

Step11では、旧版/新機能を含む全Nodeテスト、構文・UI参照・版の整合性、模擬Win32のネイティブ処理、検証用Windows EXEの構造・内包ハッシュ・起動入口を確認します。ビルドスクリプトはSetup/Patchも一緒に生成しますが、この段階では検証用です。配布用Patchの最終再生成・梱包・出力はStep12で行います。

共通データ検証/共有/検索/ID計画/再生順/PNG検証は、NodeやDOMを与えないVMでも確認します。保存と実際の画像縮小、暗号学的乱数の生成などは端末側から接続します。Windows GUI・実通信・Discord実表示は模擬検証と分け、v0.6.7時点の結果はVALIDATION-067.mdに記録しています。旧版のrelease-validationは上書きしません。

## 更新用Patchの梱包

Step11で検証したソースをコミットし、変更のない作業ツリーから最終ビルドとPE/起動入口検査を行います。検証結果を揃えてから、更新用の梱包を実行します。

```sh
python3 scripts/package-release.py --windows /path/to/windows --verification /path/to/verification --output /path/to/output --profile patch --platform windows-x64
```

patchプロファイルは、更新用Patch、単独で読める使い方、現在版の変更内容、検証JSON、SHA256チェックサムと、それらをまとめたZIPを生成します。新規導入用SetupやソースZIPは含めません。従来の全出力は、既定のfullプロファイルで維持します。Git管理されたソースではコミット/ツリーSHAと版・変更履歴を同じ検証情報へ記録し、未コミット変更があれば停止します。Git情報のないソースZIPからも従来どおり梱包できますが、生成元SHAは「Git情報なし」となります。

配布先は現在windows-x64のみです。版と変更履歴の読み取りを共通にし、将来の端末別生成もこの情報へ接続できる形にしています。スマホ版の配布物は生成しません。配布前にはZIP内の全ファイルと、別配布するPatchのハッシュが一致することを確認します。

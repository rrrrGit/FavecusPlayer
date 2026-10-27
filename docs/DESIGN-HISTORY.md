# Favecus Player 0.4.7 の構造

## 責務

| ファイル | 役割 |
| --- | --- |
| src/main.cjs | ウィンドウ、メディア画面、狭いIPC窓口、再生と音量の状態をつなぐ |
| src/core/store.cjs | データ検証・保存・旧形式移行・一括追加・リスト間移動・持ち出し |
| src/core/library-json.cjs | BOM付きJSONの厳密な文字コード読み込み、ASCII表記での書き出し |
| src/core/thumbnail.cjs | Bilibili表紙の取得、ローカル画像の抽出とサイズ・件数制限 |
| src/core/windows-identity.cjs | タスクバーのAppID、再起動コマンド、ショートカットの同一性 |
| src/core/urls.cjs | 共有文のURL抽出、Bilibili URL検証、パート番号保持 |
| src/core/bilibili.cjs | 同一ログイン状態でプロフィール・收藏夹・全パート・合集・系列を取得 |
| src/core/bilibili-browser.cjs | ログイン確認、アプリ内検索ウィンドウ、表示中の動画の追加下書き |
| src/core/player-recovery.cjs | 埋め込み再生の準備待ちと、古い操作を破棄する復旧タイマー |
| src/ui/queue-follow.js | 前面・手動操作を考慮した再生行へのスクロール |
| src/core/playback.cjs | 再生情報を検証し、時刻や文字列を正規化 |
| src/core/queue.cjs | 再生順、シャッフル、リピート、前後移動 |
| src/core/discord.cjs | ローカルIPCでDiscordへListening/Detailsのアクティビティを送信 |
| src/core/mini-player.cjs | 埋め込みと小型ウィンドウの切り替え・復帰・トレイ・専用IPC |
| src/core/taskbar-player.cjs | ヘルパー起動、1024バイトの状態送信、操作検証、接続待ちと診断 |
| native/taskbar.c | Windowsタスクバーの子ウィンドウ、GDI描画、再生操作と音量 |
| native/taskbar-model.h | 固定長通信構造、数値制限、タスクバー内の配置計算 |
| src/core/window-placement.cjs | 小型ウィンドウをモニターの作業領域に収める |
| src/core/files.cjs | ローカル音声・映像のRange配信 |
| src/core/audio-import.cjs | WMAのFLAC変換。元ファイルを保持 |
| src/preloads/ui.cjs | 通常画面から許可した操作だけを公開 |
| src/preloads/mini.cjs | 小型画面に状態・再生・前後移動・停止・音量・画面復帰だけを公開 |
| src/preloads/media.cjs | 再生ページの状態監視、音量、再生・シーク操作 |
| src/ui/app.js | 通常画面の描画、モーダル、選択追加 |
| src/ui/playlist-reader.js | 全ページ取得、重複検出、上限・中断・途中失敗の扱い |
| src/ui/mini.js | 小型画面の表示とホバー音量の操作 |
| native/main.c | Windows GUIランチャー、Setup、Patch、Maintenance |
| scripts/install-core.cjs | ハッシュ検証、配置、失敗時の起動設定復元 |
| scripts/build-windows.py | ネイティブEXE・アイコン・バージョン・内包ZIPの生成 |

## 保存形式とYouTubeの廃止

新しい保存形式のversionは2。アプリのリリース番号0.4.5とは別の値である。登録対象をbilibiliとlocalに限定し、旧version1に含まれるyoutube項目を除外する。変更前のJSONを別名保存することで、削除したURLや旧設定も元データから確認できる。バックアップ作成に失敗した場合は保存せず起動エラーとする。

YouTube用セッションの読み出し・外部ブラウザー連携サーバー・拡張フォルダーは新しいアプリに含まれない。旧ブラウザー側の拡張や古いインストールフォルダーは更新プログラムから削除しない。

## 共有文と再生リスト取得

共有文から1つのhttps URLを抽出してホストを検証する。Bilibiliのp番号を正規URLへ残し、追跡パラメーターを保存しない。文字列はtextContentで表示する。

動画詳細のpagesから全パート、ugc_seasonから合集を判別する。合集の全エピソードが詳細に含まれている場合はその順序を使い、不足時や一覧URLからの取得にはページ付きのAPIを使用する。收藏夹・系列も一覧URLのIDから取得する。任意の保存リストへの所属を単体動画のURLだけから推測しない。

UIは全ページを取得してから追加を許可する。追加自体はprepare-addで検証と重複確認を行い、commit-addで一度だけ保存するため、途中取得の失敗では一部の項目が追加されない。中断・閉じる・取得元変更は識別番号で管理し、古い非同期応答が新しいダイアログを変更しないようにする。

BilibiliのAPIは公式サービスのWeb用エンドポイントだが、外部アプリ向けの安定した契約ではない。実アカウントでの確認は残る。HTTP 412等に対して制限を回避せず、ログイン確認・再取得の案内を出す。

## 音量と小型画面

通常画面・設定・小型画面はmainにある同じ音量を変更する。変更時に各メディア画面とUIへ通知し、保存を短くまとめる。終了時に未保存の音量を保存する。

ネイティブの最小化・最大化・閉じる操作はtitleBarOverlayで保持する。下向き矢印はtitlebar-areaの安全領域の右端に置く。小型画面の読み込みが成功してから通常画面を隠し、再生用WebContentsViewは保持する。再生ページと通常画面はbackgroundThrottlingを無効にし、非表示中も再生情報を更新する。

0.4.2ではWindows用ヘルパーでタスクバーへの埋め込みを先に試す。無効化・初回接続失敗時の小型画面は独立した透明ウィンドウで、タスクバー付近に配置する。音量表示時に高さを増やし、底辺をできるだけ固定する。座標はElectronのDIPで扱い、複数モニター・負座標・表示範囲変更を考慮する。

小型画面のIPCはそのmainFrameと完全一致のURLを確認する。通常のライブラリ操作やアカウント操作は公開しない。通常画面への復帰ボタンとトレイメニューを用意する。

## Windows配布と確認

アプリ専用NodeをSetup/Patchに同梱する。Electron・FFmpegは固定URL・サイズ・SHA256で取得する。新アプリの配置後、active.txtを最後に切り替える。インストーラーが失敗した場合は元の起動設定を戻す。AppData内のメディアは削除しない。

0.2.0で修正したIAT配置は、COFFシンボルの位置から計算する方式を維持する。verify-windows.pyでコンパイルされた呼び出し先と照合し、test-windows-startup.pyで実際の起動入口の機械語を模擬Win32 APIへ接続して実行する。Windows実機でGUIを起動した確認とは区別する。

## 参照

- [Electron: Custom Title Bar](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [Electron: Tray](https://www.electronjs.org/docs/latest/api/tray)
- [Microsoft: Windows 11の機能変更](https://www.microsoft.com/en-us/windows/windows-11-specifications)
- [Microsoft: PE形式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)
- [Discord: Activity](https://docs.discord.com/developers/events/gateway-events#activity-object)

## 0.4.0で追加した責務と理由

- リスト間の移動はStore.Transferが移動先すべてを検証し、重複を除いて一度だけ保存する。保存失敗時はメモリーの変更も戻す。ローカル曲の追加先は同じメディアを参照し、音声ファイルを複製しない。
- mainは再生中の曲を移動した際、所属IDと再生順だけを差し替える。WebContentsViewを作り直さないため再生が中断されない。
- サムネイルへの切り替えはViewの可視状態だけを変更する。Bilibili画像は許可したCDNのHTTPS URLに限定し、認証情報を付けない。取得・抽出は最大2件同時、1画像3MiB、キャッシュ8件。古い曲の取得結果を現在の曲へ適用しない。
- 初期再生位置はプレイヤー用preload引数を渡した画面だけで0へ戻す。サイトが遅れて履歴位置を復元する場合に備え、最初のplayingから1.5秒間だけ進行時刻を超えたシークを補正する。ユーザーの明示的なシーク後は補正を終了し、アカウント画面には適用しない。
- Discordはassets.large_imageに登録済み画像キーを送る。停止中はtimestampsを外して位置と長さをstate文字列へ入れる。停止フラグのないDiscord標準時間バーに架空の時刻を与えない。
- 小型画面はmovable:falseとno-dragを組み合わせて固定する。次・前の専用IPCを追加し、通常画面の同じCommandへ渡す。
- Windowsはアプリ共通のAppUserModelIDと、更新されても場所が変わらないFavecusPlayer.exeへのrelaunchCommandを設定する。スタートメニューと既存の自分のデスクトップショートカットを同じIDに揃える。タスクバーのピンを自動追加・削除する処理は持たない。

追加参照: [Electron BrowserWindow.setAppDetails](https://www.electronjs.org/docs/latest/api/browser-window)、[ShortcutDetails](https://www.electronjs.org/docs/latest/api/structures/shortcut-details)、[Discord RPC](https://docs.discord.com/developers/topics/rpc)。

## 0.4.2の埋め込み

- Shell_TrayWndと直接の子TrayNotifyWndを検出し、通知領域の左へ配置する。親のクライアント座標とDPIで計算し、横向きのプライマリータスクバーだけを対象とする。タスクボタンの使用範囲は検出せず、既存ウィンドウのサイズ・位置を変更しないため、混雑時の重なりは残る。
- ヘルパーのスレッドだけを親のDPIコンテキストに合わせてから作成する。WS_POPUPを外してWS_CHILDを設定し、SetParentの戻り値だけで成功を判断せずGetParentを照合する。SetWindowPos後にも確認する。
- 親子関係の変更は別プロセスの専用ウィンドウへ限定する。ElectronのDPI設定を変えず、ExplorerへのDLL注入・タスクボタン移動・レジストリー変更はしない。
- ヘルパーは親のPIDを受け取り、同期用プロセスハンドルとstdinの生存を監視する。アプリはcloseフレームで終了を依頼し、2秒で終了しない自分のヘルパーだけを停止する。
- 状態フレームはリトルエンディアン1024バイト。FPB1、サイズ、opcode、flags、音量、幅、左移動量、予約値を32バイトへ収め、titleはUTF-16 180要素、artistは100要素、残りは予約領域とする。終端・flags・数値範囲を受信時にも検証し、分割受信を組み立てる。
- ヘルパーからは1行JSONで状態・許可済み再生操作・0〜100の音量のみを送る。Node側は親ハンドル・配置寸法に加え、rendered=true・visible=true・hitCount=3を確認するまで操作を受け付けない。未知コマンドは実行せず、不正な応答は接続失敗として扱う。曲名はシェルの引数に入れない。
- Showの世代番号で復帰・終了後の遅い接続完了を無効化し、メイン画面が遅れて隠れないようにする。初回は約8秒、表示中のタスクバー消失は約15秒で復帰判定する。
- 診断はuserData/taskbar.logへ書き、256KiB超で前回分を.oldへ移す。URL、Cookie、曲名は診断出力へ渡さない。

親子関係・DPI・再接続のテストは模擬APIであり、実際のWindowsタスクバーとの相互運用を保証しない。根拠資料と制約はTASKBAR.mdに保持する。

## 0.4.2の描画と案内

- native/taskbar-render.hが上から下へ並ぶ32ビットDIBへ描き、GdiFlush後にRGBのアルファ値を補う。四隅のみ透明にし、UpdateLayeredWindowで専用のWS_EX_LAYERED子ウィンドウへ渡す。画像5を基にした暗い角丸枠、曲名と再生元、薄紫の丸い再生ボタン、前後・停止・音量・復帰ボタンをタスクバーの高さに収める。
- SetWindowPosで自身の子ウィンドウを兄弟ウィンドウの手前へ置く。GetParent・寸法・可視フラグに加え、WindowFromPointで左右と中央が自身を指すことを確認してattachedを返す。これはAPIによる確認であり、Windows実機での目視確認ではない。タスクバーの別の子に3秒以上覆われた場合はoccludedとし、初回失敗／表示中失敗の復帰経路を使う。他アプリに覆われた場合はそのエラーにせず表示を待つ。
- GUI専用ヘルパーをwindowsHide=falseで起動し、初回ウィンドウを隠す指定を渡さない。幅の変更時は位置と描画用DIBを更新する。新規設定の幅は500、保存済み設定は変更しない。
- 診断へ描画の成否、可視フラグ、3点の一致数、画面座標、前面ウィンドウの識別値・クラス名を追加。0.4.1のparentだけのattachedは成功扱いしない。
- ElectronのWebContentsViewはメインDOMのz-indexでは覆えないため、案内をplayer-slotの後ろにある同じflex列へ配置する。表示・消去直後とResizeObserverで表示領域を送り直す。Native Viewの左上は切り上げ、右下は切り下げて案内側へのはみ出しを防ぐ。
- 曲／動画ボタンは既存のthumbnailModeを明示的に設定する。選択側をaria-pressedで伝え、Viewの読み直しや音声の停止は行わない。

## 0.4.3の変更

- native/volume-panel.hが音量パネルの描画、座標から音量への変換、キー操作を担当する。ネイティブの標準トラックバーを除き、暗い背景、薄紫のレールと丸いハンドル、数値をGDIで描く。マウスキャプチャを失った時とボタンを離した時にドラッグを終える。
- BarProcのクリックは押下・解放位置のボタン番号を照合する。番号0の曲名・アイコン・余白は無操作とし、通常画面へ戻すのは番号6のボタン。前後・再生・停止・ミュートはそれぞれの操作だけを送る。
- インストーラーは固定appフォルダーへ新本体を配置する。旧appはruntimeの一時領域へ退避し、失敗時は本体・起動情報を戻す。戻せなければ退避領域を削除せずパスを記録する。成功時に旧app-版-日時と古い.backupsを、名前・package・製品情報から確認できた範囲だけ整理する。旧ソースやAppData、関係のないファイルは対象外。既存ランチャーのSafeNameに固定appを追加し、旧形式も読み込める。
- BilibiliAccount.Partsは選んだ動画のDetails/pagesから子の全パートを返す。投稿者や同じ合集内の別動画を、最初に貼った動画IDへ取り違えない。通常動画・一覧の取得は既存のBilibiliセッションとAPI制限を継続する。
- PlaylistBrowserは取得中の状態、親の履歴、全階層の選択を管理する。子の取得完了後だけ階層を切り替え、失敗・中断・古い応答では親と選択を維持する。UIはtextContentと独立したパートボタンを用い、パートを開く操作でチェックを切り替えない。別のURLを検索すると選択をクリアする。

## 0.4.4の複数リスト追加とタイトル整理

- Store.Targetsが追加先をすべて検証し、AddItemsが対象ごとの正規URL・パートまたはローカルfileNameで重複を省く。全リスト合計10000件を事前確認し、独立UUIDで一括保存する。失敗時はメモリー状態を戻す。
- add/add-videosは従来のplaylistIdまたは新しいdestinationIdsを受け付ける。add-existingはplaylistId/entryIdの参照だけを受け取り、実データをStoreから引く。元のエントリーは削除しない。
- AddFilesは1回取り込んだファイルを複数の追加先で共有する。全ファイルの取得完了後に一括登録し、途中失敗時は今回作ったファイルのみ除く。既存メディアは除かない。
- title-cleanup.cjsは最大200個・各80文字の語句を検証し、正規表現の特殊文字をエスケープする。長い語句を先に、英字の大小を区別せず、登録語句全体を照合する。括弧記号は独立した語句。消去結果は空白を整え、再適用で変わらないよう安定するまで処理する。
- 初期語句はニコカラ・純k投屏・角括弧類。旧保存データでは初期語句を導入して整理する。空配列は無効化として保持し、再起動で初期語句を復活させない。語句変更と全リストの再整理は1回の保存で行い、失敗時は双方を戻す。語句を外しても整理前のタイトルへ自動復元はしない。
- 初回メディア情報・手動編集・持ち出しの再取り込みにも同じ整理処理を使う。再生中のtitle変更はcurrent-update/playbackとDiscord・ミニプレイヤーへ通知する。WebContentsViewや再生位置を作り直さない。schemaは2を保持する。
- UIのAddDestinationsは現在リストを初期選択し、追加フロー共通のチェック欄を返す。ExistingTracksはリスト・検索切り替えを超えて曲の選択を保持する。
- 設定トップは音量・アカウントの直接表示と、語句・Discord・タスクバーの順のボタン。後の機能は配列末尾へ追加する。詳細画面の戻る／保存はその項目だけ保存し、×で閉じた後の遅い応答は詳細を開き直さない。語句は追加・削除時に即時保存する。
- test/update-044.test.cjs、ui-044.test.cjs、main-040.test.cjsの追加ケースで保存・失敗時の復元・選択保持・設定画面遷移・再生中のタイトル更新を確認する。DOMイベントとWin32は模擬環境であり、実際のWindowsの見た目を検証するテストではない。

## 0.4.5のシャッフル・表示・追加確認

- Queueは登録行IDで順序と再生済み集合を保持。Syncは削除を反映し、新曲を未再生部分へ混ぜる。再生中の並べ替え等で既存の抽選をやり直さない。全曲リピートの新しい周は直前の最後のIDを全候補から除いて再抽選する（1曲なら自身）。除外IDもseenへ記録し、編集時の再挿入を防ぐ。過去の周は最大3つ保持し、前後移動をたどれるようにする。
- player:shuffleは全曲を最初から抽選する。ファイル存在の検証後だけキューを採用し、1曲リピートを解除する。次曲もキューを複製して検証してから採用する。失敗した開始で直前の再生キューを破壊しない。
- BackgroundModeはBrowserWindowのblur/hide/minimizeとfocus/show/restoreから経過時間を管理。既定5分、整数1〜120分。前面へ戻すとキャンセル。期限・設定・再生対象の変更を識別し、古いタイマーを無効化する。autoThumbnailEnabled/MinutesはStoreの同じsettingsへ保存する。
- 自動切り替えは手動と同じthumbnailModeを保存し、同じViewを非表示にして音声を維持する。動画復帰ではViewを表示し、webContents.invalidateとrefresh-displayで再描画と現在状態の報告だけを要求する。ページ再読み込み、pause/play、シークは追加しない。実サイト・GPU・通信の停止を検出して復旧する実装ではない。
- Electronの[Page Visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)ではbackgroundThrottling=false時にDOMのvisibilityStateが前面状態を示さないため、ネイティブの[blur](https://www.electronjs.org/docs/latest/api/browser-window#event-blur)を利用する。再描画は[webContents.invalidate](https://www.electronjs.org/docs/latest/api/web-contents#contentsinvalidate)を使用する。
- duplicates.cjsは正規URL・パートまたは既存fileNameを比較し、名前はNFKC・英字小文字・記号空白化、字幕接頭語と空白付きハイフン以降の付記を除いた完全語句で候補判定する。ナツノヒの語句はナツノヒグラフに部分一致させない。同じ音声かどうかの判定ではない。
- AdditionReviewは確認内容をメインプロセスへ保持する。rendererは準備されたidとチェックIDだけを確定へ送る。ローカルパスはOSのファイル選択からのみ受け取る。既存曲参照はStoreから検証して解決する。
- 同時保持は最大3件、期限30分、1操作10000件（曲数×追加先数）。タイトル未取得のURLは最大3並列で照会し、失敗時はURLのみ確認した件数を返す。タイトル整理後の曲名を既存曲と今回追加内で比較する。
- プレイリストと整理語句のハッシュを確認時と確定時に比較。無関係な音量・表示変更は有効性へ影響しない。確認内容が変わった場合は確定せず再準備を求める。
- Commitは重複でない項目とチェック済み候補だけを一度の保存で追加する。同一URLの意図的な重複も独立UUIDで登録する。既存の曲は変えない。Fileのコピー・変換は選択後に1回だけ行い、複数リストで参照を共有。途中キャンセル・保存失敗は今回のファイルとメモリー変更を戻す。従来のStore.AddItems/Transferの重複省略は互換経路と「移動」で保持する。
- ReviewAdditionは画面の世代番号を比較し、閉じた後の準備完了はキャンセルする。候補の初期チェックはなし。×と中止は通常候補も含め追加全体を取りやめる。DOMテストは実rendererと実Store/AdditionReviewを接続するが、Windows描画の確認ではない。

## 0.4.6のアプリ内検索・再生復旧・表示追従

- BilibiliBrowserはローカルのbrowse.htmlを信頼した操作面とし、y=116より下へ公式サイトのWebContentsViewを置く。タイトルバー40px、検索欄46px、状態欄30px。ローカル画面だけに追加・検索・ウィンドウ操作のIPCを許可し、リモートのWebContentsは呼び出せない。全画面操作用のボタンはapp-region:no-dragにする。
- 検索専用の許可範囲にsearch.bilibili.comを追加し、既存の再生側のホスト許可は広げない。HTTP・認証情報付きURL・外部ポップアップを拒否する。公式ページの別ウィンドウは許可されたURLだけを同じ検索Viewへ開く。前後移動はnavigationHistoryを使う。
- 検索Viewはpersist:favecus-bilibiliを共有し、既存のmedia preloadで音量を扱う。検索側は初めはミュートで、明示的な試聴操作を設ける。非表示・最小化で一時停止とミュートを行い、検索を閉じたときはWebContentsを破棄する。再生リスト本体のcurrentやQueueは検索に連動させない。
- 開く時と追加時にプロフィールを再確認する。Accountsは同時照会をまとめ、前面復帰時の表示更新には30秒のキャッシュを許すが、開く・追加は新しい確認を要求する。サイトが確認できない時はログインを推測して許可しない。
- AddCurrentは現在URLをParseBilibiliで正規化し、pを保持してDetailsのパート名を選ぶ。照会後にWebContents・URL・ナビゲーション世代を照合する。追加先の保存は行わず、信頼したmain画面の既存AddURLへ下書きを渡す。既存モーダルは上書きしない。AdditionReviewと複数追加・自動消去を引き続き利用する。
- PlayerRecoveryはLoadEntryの世代ごとに埋め込みだけ20秒を監視する。media:healthは要素がない時も報告し、readyState>=2かつ正の有限duration、エラーなしを準備完了とする。準備済みの一時停止をタイムアウトしない。準備中のエラー2〜4または期限で、同じURL・パートの公式ページを新しいViewで一度だけ読み込む。停止・別曲・公式ページ表示で古いタイマーと遅い復旧を無効化する。
- 手動の再読み込みも旧WebContentsを破棄して公式ページへ読み込む。キューは保持するが、既存の先頭再生処理により位置は0からとなる。通常の曲／動画モード切り替えは0.4.5と同じView・再生位置を保持する。途中で固まった映像の原因を画像から自動判定する処理ではない。
- Queue.Peekは再生位置を動かさず、周の境目では次の周を一度だけ準備する。Moveは同じ結果を採用し、表示のたびの再抽選を防ぐ。次の周の除外元anchorを保持し、曲追加で現在の周の末尾が変わった場合は未再生の予告だけを作り直す。最大3周の履歴は保持する。QueueStateは元の番号・曲名を渡し、変更後の予告を更新する。
- QueueFollowerは通常・シャッフルの区別なくcurrentイベントで動く。foregroundはBrowserWindowのネイティブ状態から取得し、DOM visibilityStateには依存しない。ホイール・タッチ・スクロールキーから1.5秒以内、スクロールバーを保持中、曲をドラッグ中、モーダル表示中は要求を捨てる。requestAnimationFrameの前にも世代と条件を再確認し、手動操作後の遅れた移動を防ぐ。
- rendererは現在と表示中のplaylistIdが同じ時だけdata-entry-idで行を探し、表示座標からscrollToする。Storeの並び順を変えない。末尾スペーサーを表示高に合わせ、最後の行も上へ動かせるようにする。再描画は以前のscrollTopを復元する。検索で隠れた行や別のリストは変更しない。
- ui-046、bilibili-browser、player-recoveryとmain/preload/queueの追加ケースで検証する。実DOM・Windows・実サービスの確認ではない。

実装の参照元はElectron公式の[ナビゲーションイベント](https://www.electronjs.org/docs/latest/api/web-contents)、[navigationHistory](https://www.electronjs.org/docs/latest/api/navigation-history)、[ウィンドウのドラッグ領域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、Bilibili公式の[外部プレイヤーのパラメーター](https://player.bilibili.com/)。「你感兴趣的视频都在B站」の画像だけを特定エラーの根拠にはしない。

## 0.4.7の再読み込みと一覧サムネイル

- 再読み込みはcurrent.pageModeをLoadEntryへ渡し、表示選択を維持する。自動復旧はpageMode=falseで同じ埋め込みを再構築し、allowRecovery=falseで復旧の連鎖を防ぐ。新しい曲・手動再読み込み・明示的なプレイヤー表示には一度の復旧を許す。
- library:thumbnailは信頼したmain画面からリストID・登録曲IDだけを受け取る。URL・ファイルパスはStoreから取り、選択中のリストと曲の存在を再確認する。取得で再生キューやcurrentを変更しない。
- ListArtworkはIntersectionObserverで一覧の可視範囲と上下80pxを監視。同時2件までAPIへ送る。リスト再描画で監視を解除し、以前の画像要素の応答を捨てる。背景では新しい取得を止める。画面外のimgは共通画像へ戻し、デコード済み画像を保持し続けない。
- Thumbnails.GetPreviewは従来の安全な画像取得を共有し、nativeImageで縦横比を保った最大128×72のPNGへ変換する。元画像8件と別に縮小画像96件をメモリーに保持し、最近使われない小画像から除く。取得失敗は60秒だけ保持する。独自のディスクキャッシュは作らない。
- Getの待機解除後もキャッシュ・同一キーの処理中状態・有効性を確認し、待ち行列から重複した取得が起動しないようにする。Promiseをpendingへ登録してから取得を始め、同期的な失敗でもpendingを残さない。
- CSSの列を番号・種別・画像・再生・曲名・状態・編集へ変更。狭い幅では状態を隠す既存動作を維持し、画像枠を48×30にする。装飾用の画像はalt空、ドラッグ・クリック対象外。曲名の幅はminmax(0,1fr)で残りに収める。

参照はElectron公式の[nativeImage](https://www.electronjs.org/docs/latest/api/native-image)とMDNの[Intersection Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)。実装本体と模擬DOM・Electronを検証し、Windowsの描画を確認したとは扱わない。


## 0.5.0

- 保存形式v3。playlistsは各リストの一意の所有レコード、childIdsは順序付きの参照、rootPlaylistIdsは最上位の表示順。共有参照を許すDAGを使用する。移動は旧参照を外し、参照取り込みは残す。全更新を事前スナップショットで保護し、循環・存在しない参照・孤立を検証してから保存する。旧v1/v2は原本をバックアップした後、全リストを最上位へ移行する。
- 共通library-tree.jsが親の曲→子孫という深さ優先順を定義する。所有者playlistIdとキューのscopeを分離し、親／全体の曲送りでも正しい所有リストの曲を再生する。全体scopeは同じ正規化URL・fileNameを一度にする。シャッフルはFisher–Yates、各入れ替えの整数はcrypto.randomInt。既存の周末除外と履歴維持を継承。
- ビューのTreeViewは名前・件数・展開矢印、チェック選択、三本線ドラッグを共通化。上端／下端は同じ階層の並べ替え、中央は親変更の確認。プレイリスト作成の小ダイアログを親の追加画面と別に保持し、入力中の値と選択を失わない。
- URLの解析はBilibiliAccount.Resolveに集約し、単体・複数単体・一覧URLを返す。単体に関連する全パート・合集は追加候補として示し、PlaylistBrowserを再利用して辿る。検索画面はURLとanalyzeフラグを共通画面へ渡す。
- 使い方は外部ブラウザーを使わず、sandbox付きのアプリ内ウィンドウで許可した3つの同梱HTMLだけを開く。モーダルと別ウィンドウの表示中は背面をinertにし、ネイティブtitleを退避してツールチップを止める。
- LibraryArchiveは各リストを別JSONとしてZIPにまとめ、scrypt(N=32768,r=8,p=1)でパスワード鍵を作りAES-256-GCMで暗号化する。ランダムsalt16・nonce12、固定headerをAAD、tag16。専用FVPAにはJSONだけを入れる。外側ZIPにはFVPAとmediaを入れ、mediaは従来の持ち出し互換のため平文。秘密情報やアプリ設定を出力しない。
- ZIPは4GB未満の標準ZIP。外側はストリーム書き込み、読み取りは中央ディレクトリとCRC、サイズ、パス、重複名を検証する。取り込み時に展開先をアーカイブのパスから組み立てず、生成したUUIDのファイル名だけを使う。選択確定までは永続データに書き込まない。失敗時は新規媒体ファイルを消し、Storeのデータを元へ戻す。同名は別名、新しいIDを採番し、未選択参照は外す。
- パッケージ名・APP_ID・persist:favecus-bilibili・保存先を維持し、ユーザー向け名称とショートカットを変更。FavecusPlayer.exeを追加し、FavecusPlayer.exeを互換用に同梱する。セットアップのロールバックは新旧両ランチャーを含む。

参照: [Node.js crypto](https://nodejs.org/api/crypto.html)、[Electron app](https://www.electronjs.org/docs/latest/api/app)、[HTML inert](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert)。確認範囲はVALIDATION-050.mdに記載する。

## 0.5.1の修正理由

曲の表示用リストと再生キューを分けた。画面には直属の子と親自身の曲を表示し、キューは従来の深さ優先展開を維持するため、折りたたみは再生を制限しない。

曲送り時は全DOMの再生成と全サムネイル監視の初期化を避け、保持した行から再生中の表示を更新する。追加先は無効化表示ではなく元リストを非表示にし、子は独立した候補として残す。

旧名の保存先を維持した0.5.0の方針を変更し、新名へ移す。ディレクトリの上書き・混合は行わず、インストーラーの失敗時は旧名へ戻す。旧名文字列は移行元の識別にだけ必要となる。セッション保存先は初期化前に指定する。[Electron app](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path)、[Electron session](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)。

入力不要のアーカイブは専用形式の版を2へ上げ、復号キーを内包する。パスワード付き旧版の秘密性を自動形式の説明と混同しない。

曲送りで埋め込みBilibiliから埋め込みBilibiliへ移るときは、WebContentsViewを再利用する。プレイヤーの公開されていない内部APIには依存せず、同じWebContentsへ次のURLを読み込む。手動再読み込み・復旧・公式ページ表示・ローカルとの切り替えでは作り直し、故障した画面や異なる権限の画面を使い回さない。

再利用時も世代を進め、復旧タイマーを取り消し、旧画面を一時停止・ミュートして進行中のナビゲーションを中断する。新しいURLのDOM準備まではメディア通知を受け付けず、その後も曲URLを照合する。遅れて戻る旧loadURLの失敗は世代で、did-fail-loadは読み込み対象URLで除外する。音量操作で準備中の旧画面がミュート解除されないようにし、新しいDOMで現在の音量を適用する。

起動時に埋め込みプレイヤーとAPIの2つのオリジンへ各1ソケットだけpreconnectする。失敗しても通常の読み込みを続ける。先読み用の別プレイヤーや動画の二重再生は作らない。これらはアプリ側の初期化・接続の負担を減らす変更であり、Bilibili側の読み込み時間の実測結果ではない。

参照: [Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents)、[Electron session.preconnect](https://www.electronjs.org/docs/latest/api/session#sespreconnectoptions)。

## 0.5.2の展開表示とフォーカス

一覧のwindow.blurは、アプリ全体が背面になったことを意味しない。埋め込み動画へフォーカスが移る場合にも起きるため、blurに連動して一覧・操作欄をinertにすると、ユーザーのクリックや手動スクロールまで阻害する。inertはダイアログ表示中だけに限定し、ツールチップの抑制とは分けた。

前面状態は引き続きBrowserWindowの表示・最小化・フォーカスから求める。曲のcurrent通知の直前と、UI・動画のWebContentsのfocus時、読み込みのDOM準備時に同期する。WebContentsのfocusを無条件に前面扱いせず、実際のウィンドウが背面ならfalseを通知する。ElectronもWebContentsのfocus/blurは同一ウィンドウ内のフォーカス移動を扱うものとして説明している。[Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents#event-focus)

手動スクロール後の1.5秒の待機は自動曲送りに適用する。ユーザーが再生・シャッフル・前後送りを押した場合は、その操作を新しい再生位置への追従の意思として扱い、待機を解除する。フォーカス移動でpointerupが届かなくても保持判定を解除し、以後の曲送りを止めない。

子プレイリストの展開状態は、表示スコープと参照経路をキーに画面内だけで保持する。保存されたchildIdsやQueueを変更せず、初期状態は閉じる。同じ子が複数の親に共有されても開閉を経路ごとに扱える。展開した曲には所有者playlistIdを付け、編集・並べ替え・画像取得はその所有者に対して行う。再生キューは親または全体スコープを維持し、全体で重複した曲を押した場合は同じ媒体の既存キュー項目へ解決する。

今回の回帰テストは以前省略していたUIのフォーカスイベントと背景要素のinertも扱う。旧実装で失敗するケースを確認した上で修正し、Windows実機の確認とは区別する。

## 0.5.3の親選択と所属階層

親の単一選択はparent-picker.jsで行う。検索はNFKCと大文字小文字を正規化した名前の部分一致で、一覧を絞り込まず、該当リストまでの祖先を展開する。紫の一致表示と緑の選択表示を分け、検索・結果移動では保存予定の親を変更しない。開閉状態は参照経路ごと、選択はリストIDで保持する。検索を消すと検索前の開閉へ戻る。

一致箇所へのスクロールは選択欄自身のscrollTopだけを更新し、検索入力のフォーカス、モーダルや再生リストのスクロールは動かさない。IME変換確定のEnterでは結果移動を行わない。移動時の親候補からは自分と子孫を除外する。

次曲の所有者はメイン処理が返すqueue.next.playlistIdを使い、現在画面で閲覧中のリストには依存しない。Pathは実際の最上位から所有者までの経路を返し、複数の参照経路がある場合は再生スコープを通るものを優先する。全体再生ではEntriesと同じ根・子の順序で探索する。名称変更はstate通知で再計算する。抽象的な「マイライブラリ」「最上位（親なし）」は経路に含めない。

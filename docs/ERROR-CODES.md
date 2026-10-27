# エラーコードと診断記録

## 保存の失敗

保存画面のFP-DOWNLOADコードと記録IDを、runtime/logs/download-diagnostics.jsonlと照合する。処理段階、HTTP/API状態、許可したネイティブコードを保持する。生の例外文・Cookie・署名付きURLを含めず、2MiBを超えたら.previousへ退避する。

| コード | 原因の分類 |
| --- | --- |
| FP-DOWNLOAD-CONNECTION | サーバー切断、接続・名前解決の失敗 |
| FP-DOWNLOAD-TIMEOUT | 通信が進まない、接続の時間超過 |
| FP-DOWNLOAD-INCOMPLETE | 空・途中までのデータ、サイズ不一致 |
| FP-DOWNLOAD-AUTH | ログインが必要 |
| FP-DOWNLOAD-LIMIT | HTTP 412/429など配信元の利用制限 |
| FP-DOWNLOAD-HTTP | その他のHTTPエラー |
| FP-DOWNLOAD-NOSPACE | 空き容量不足 |
| FP-DOWNLOAD-PERMISSION | 書き込み権限、使用中・読み取り専用 |
| FP-DOWNLOAD-PATH | 長い・無効なパス、ファイルが見つからない |
| FP-DOWNLOAD-METADATA | パート・公開範囲・配信情報の取得 |
| FP-DOWNLOAD-FORMAT | 結合・形式・再生時間の確認 |
| FP-DOWNLOAD-COVER | サムネイル取得・保存 |
| FP-DOWNLOAD-LAYOUT | フォルダーの整理・登録 |
| FP-DOWNLOAD-UNKNOWN | 上記に分類できない保存の失敗 |

中止操作はエラーとして記録しない。FP-DOWNLOAD-LAYOUTでは登録更新が成功しなければ元のデータを保持する。画像だけの失敗では完成した動画・音声を利用できる。

コードは分類と実際の終了値を保存し、原因の決めつけを避ける。配布版はruntime/logs、ソース起動はuserData内へ記録する。

| コード | 発行元・調べる箇所 |
| --- | --- |
| FP-LAUNCH-XXXXXXXX | native/main.cのRunでCreateProcessWが失敗。末尾はGetLastErrorの8桁16進数 |
| FP-EXIT-XXXXXXXX | 起動したElectronのDWORD終了コード。符号付きへ変換しない |
| FP-EXIT-80000003 | ブレークポイント／内部チェック停止。コードだけでは一意に決まらないため、同じ起動のダンプを照合する |
| FP-EXIT-FFFF7003 | Crashpad未登録のクライアントのダンプ要求。元の例外を示すコードではない |
| FP-EXIT-FFFF7001 | Crashpadハンドラーが応答せず、プロセスが自ら終了 |
| FP-EXIT-FFFF7002 | Crashpadの状態取得に失敗し、本来の終了コードを取得できなかった |
| FP-PLAYER-DIAGNOSTICS-START | ローカルCrashpadの開始結果。started・error・Electron／Chromium版・メモリー使用量を確認 |
| FP-PLAYER-VIEW-DESTROYED | 現在のWebContentsが予期せず破棄された。続く復旧または停止を確認 |
| FP-PLAYER-APP-START | main.cjsのStart初期化例外 |
| FP-PLAYER-LOAD-ERROR | did-fail-load。Chromiumのcodeとdescriptionを確認 |
| FP-PLAYER-NAVIGATION-ERROR | loadURLの拒否。ERR_ABORTEDは通常の切り替えとして除外 |
| FP-PLAYER-RENDERER-EXITED | render-process-gone。exitReason・exitCodeを確認 |
| FP-PLAYER-CHILD-PROCESS-EXITED | child-process-gone。processTypeでGPU等を判別 |
| FP-PLAYER-UNRESPONSIVE | 現在の再生WebContentsの応答停止 |
| FP-PLAYER-RECOVERY | 自動復旧。trigger・nextAttemptを確認 |
| FP-PLAYER-RECOVERY-EXHAUSTED | 復旧上限到達。直前の2回の結果と照合 |
| FP-PLAYER-MEDIA-ERROR | メディアpreloadからのエラー通知 |
| FP-PLAYER-SEND-FAILED / DETACH-FAILED / CLOSE-FAILED | 再生Viewの通信・切り離し・終了処理 |
| FP-PLAYER-UNCAUGHT-EXCEPTION | メインの例外監視。例外名、メッセージ、先頭8行のスタック。既定の終了処理は抑止しない |
| FP-PLAYER-NAVIGATION-START | 次の文書のloadURL直前。送信停止中 |
| FP-PLAYER-DOCUMENT-READY | 要求URLのdom-ready後。メディアIPCの送信再開 |
| FP-PLAYER-TRACK-CHANGE | 直前の曲変更。正常イベントでありエラーではない |

launcher.logのrunと、player-diagnostics.jsonlのrunIdを照合する。プレイヤー側は日時、アプリ版、世代、曲ID・パート、再生元、保存済みか、直前の再生コマンド、公式プレイヤー使用、復旧回数を保持する。署名付きストリームURLやCookieを診断項目へ追加しない。

警告のスクリーンショットだけでは記録ID・終了コードを確認できる。完全な原因調査には同じ起動回のログも使う。ネイティブクラッシュのすべてをJavaScriptログで捕捉できるわけではなく、同じ終了コードに複数の原因があり得る。

## ネイティブの異常終了

画面を作る前にCrashpadを起動し、記録をruntime/logs/crashesへ保存する。uploadToServerはfalseで外部へ送らない。electron.logはChromium側の警告・エラーを保存し、起動時に4MiBを超えていれば.oldへ退避する。player-diagnostics.jsonlにはメモリー使用量と実行基盤の版も記録する。

FFFF7003だけからメモリー不足、GPU障害、画面破棄の競合などを選び分けることはできない。診断の開始結果と同じ起動IDの記録を調べる。元の障害が修正されたかの判断にはWindows実機での再生確認が必要。


今回受領した80000003の分析はCRASH-064.mdを参照。ダンプのfavecus_operationにはload-url、media:command:volume等の直前操作を追加した。操作名のみで、Cookieや署名付きURLは含めない。

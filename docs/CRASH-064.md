# FP-EXIT-80000003の調査と修正

## 受領記録で確認したこと

- launcher.log、player-diagnostics.jsonl、electron.log、8件のminidumpを照合した。
- 8件ともElectron 44.2.0 / Windows x64のbrowserプロセス、例外0x80000003、electron.exeのRVA 0x3570558で停止していた。ダンプ内の直前イベントは曲変更で、再生元は保存済みのlocalだった。JSONログにはオンラインでの曲変更後の異常終了もあるが、そのすべてに対応するダンプがあるわけではない。
- ダンプ内のCodeView識別子に一致する公式PDBを使用した。GUID 92C8AABB-5F0D-C1D6-4C4C-44205044422E、age 1。別の版のシンボルは使用していない。
- 停止命令は `electron::api::WebFrameMain::WebFrameMain + 0x1b8`。命令バイトはint3に続くud2。直前に登録済みのポインターが非nullかを検査し、この停止命令へ分岐する。対応するElectronソースには同じFrameTreeNodeの二重登録を禁止する `CHECK(!it->second)` がある。
- メインプロセスの記録はおおむねRSS 130〜220MB。これだけでメモリー不足やGPU障害とは判断しない。electron.logのSPDY警告も、この停止箇所の原因を証明しない。

## アプリ側の再現条件と対策

前版はWebContentsの生存確認をしていたが、曲のloadURL中にもフォーカス・レイアウト・音量変更からsendを呼んでいた。sendは内部でmainFrameを参照するため、フレーム切り替え中に上記の生成処理へ入る経路が残っていた。ネイティブCHECKによる終了はJavaScriptのtry/catchで回復できない。

MediaChannelで文書の準備前とナビゲーション中の送信を禁止する。読み込み中のミュートはネイティブ操作のみで実施し、文書準備後に最新の音量・キー設定・表示状態を反映する。破棄・停止・別曲要求では旧画面への送信と保留操作を無効化する。検索とアカウント画面にも同じ制御を使う。

遅延ナビゲーションを持つ模擬Electronで、オンライン・ローカル・画面側からのナビゲーションを検証した。同じ3テストは0.6.3のmain.cjsでは失敗し、修正版では成功する。試験では切り替え中のmainFrame参照回数が0であること、読み込み後の音量・キー設定、保留中の停止も確認する。これはアプリ側の危険な呼び出しの再現であり、Windowsのネイティブクラッシュそのものを再現した試験ではない。

## 診断の追加

- FP-PLAYER-NAVIGATION-START: 新しい文書の読み込み直前。
- FP-PLAYER-DOCUMENT-READY: 要求した文書の準備完了。
- ダンプのfavecus_operation: load-url、media:command:volume等の直前の操作名。

新しいログにもCookieや署名付きストリームURLは追加しない。受領したダンプや個人の曲情報を配布物へ含めない。

## 検証の限界

同じ例外コードでも停止箇所は異なり得る。今回の8件について停止箇所を特定し、その経路を避ける修正を行った。Windows実機での連続再生・実際のBilibili接続は未検証で、あらゆる80000003やフリーズの解消を保証するものではない。Electronのバージョンやセキュリティ設定は変更していない。

参照: [Electron公式シンボルサーバー](https://www.electronjs.org/docs/latest/development/debugging-with-symbol-server)、[Electron 44.2.0 WebFrameMain](https://github.com/electron/electron/blob/v44.2.0/shell/browser/api/electron_api_web_frame_main.cc)、[LLVM PDB構造](https://llvm.org/docs/PDB/DbiStream.html)。

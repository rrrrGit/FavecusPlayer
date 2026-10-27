> 0.2.0時点の記録です。この修正は0.3.0にも引き継いでいます。現在の起動・更新手順はGUIDE.mdを参照してください。

# 0.2.0 EXE起動不具合の修正

Setup.exeが画面を出す前に停止する不備を修正しました。アプリのバージョンは0.2.0のままです。

## 原因

EXE生成時に、Windowsが機能の呼び出し先を書き込む表（IAT）の配置位置を誤っていました。リンカーが先頭へ追加した24バイトを考慮せず、コードの参照先と表の位置がずれていました。

旧SetupではLoadLibraryWの呼び出しが参照するRVAは0x12058でしたが、表は0x12040から配置され、その参照先は0でした。そのため最初のWindows機能呼び出しで異常終了します。Nodeの展開やダウンロードより前の不具合です。

## 修正

- scripts/build-windows.pyで、リンク済みシンボルの位置を読み取ってから表を配置。
- scripts/verify-windows.pyで、コード側の呼び出し先と表の位置も照合。
- test/native-startup.cとscripts/test-windows-startup.pyを追加。生成したEXEの機械語をLinux x64上で実行し、Windows APIを模擬関数へ接続して起動入口とAPI初期化を検証。
- 同じ生成処理を使うSetup、Patch、FavecusPlayerをすべて再生成。

旧方式は追加した検証で異常終了を再現。修正版3種類は起動入口と47件のAPI初期化を通過しました。これはWindows実機のウィンドウ表示・インストール・サービス接続を検証したものではありません。

前回の25件のテストは主にアプリの保存・再生モデル・通信等を確認しており、このEXEの呼び出し先のずれを検出できていませんでした。

## 使用するファイル

以前ダウンロードしたものではなく、今回の修正版Setupを使用します。既存の0.1.0を更新する場合は修正版Patchを使用し、Start.cmdとpackage.jsonがある最上位フォルダーを選びます。インストールされるFavecusPlayer.exeも修正版です。

技術資料：[Microsoft PE形式・Import Address Table](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#import-address-table)

> これは0.1.0の起動処理に関する過去の記録です。0.2.0のSetup／Patchはnpmによる初回取得を使用しません。現在の手順はGUIDE.mdを参照してください。

# 起動処理の修正（launcher revision 2）

## 原因

Electron 44.2.0は、開発時に最初に起動する際、必要な実行ファイルを取得します。
旧Start.cmdはnpm ciの直後、まだ取得していないelectron.exeの有無を確認して終了していたため、本来の取得処理に到達できませんでした。こちらの起動ファイルの不備です。

公式資料: https://www.electronjs.org/docs/latest/tutorial/installation#binary-download-step
公式ソース: https://github.com/electron/electron/blob/v44.2.0/npm/package.json

## 修正内容

- npmのElectronパッケージと起動コマンドがあれば、そのままnpm startへ進みます。
- 必要な依存パッケージがない場合だけnpm ciを実行します。
- Electronの初回起動に備わっている取得処理を使用します。
- ダウンロードや起動が実際に失敗した場合は、元のエラーを表示したまま止めます。
- Start.cmdとBuild-Windows.cmdはASCII・CRLFに統一し、日本語行の文字化けによる誤解釈を避けます。

## 今のフォルダーに適用する

1. 開いているエラー画面を閉じます。
2. ダウンロードしたStart.cmdを、既存のStart.cmdへ上書きします。
3. 上書きしたStart.cmdをダブルクリックします。
4. Electron本体の初回ダウンロードが始まったら、終了まで待ちます。

この問題の解消のためにNode.jsやnpmを更新したり、npmのスクリプトを一括許可する必要はありません。
表示されているelectron-winstallerの承認警告は、Electron本体の欠落を判定して終了した今回の直接原因ではありません。
非推奨依存パッケージの警告は将来の依存関係見直しの対象ですが、今回の停止原因とは分けて扱います。

## 確認範囲

バッチファイルのASCII文字・CRLF改行・分岐先の存在、起動前にelectron.exeの有無で終了しないことを確認しています。
Windows実機での起動・動画再生の確認は未実施です。

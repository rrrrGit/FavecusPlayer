# Favecus Player 0.7.3

Bilibiliとローカルの音楽・動画を、階層プレイリストで再生するWindows向けアプリです。iPhone版（個人利用・AltStore経由）と、プレイリストの同期に対応しました。

- 自分のSupabaseプロジェクトで、プレイリストの構成と曲の登録情報をWindows版・iPhone版で同期できます（任意。設定 → プレイリストの同期）。
- iPhone版との間で、プレイリスト情報とローカルメディアをZIPで受け渡せます。
- 動画リンク・パート単位で動画/音声/サムネイルを共用し、重複ダウンロードを防ぎます。
- 旧配置の保存データを再取得せず移行し、参照や使用が残るデータを保護します。
- 動画編集画面から、その動画・パートだけをダウンロードできます。
- プレイリスト情報のみ（主にPC・スマホ間）とDLデータ付き（主にPC間）の出力を選べます。
- 階層と選択不可の行を保ったリスト選択、合計999リストに対応します。
- ホームのプレイリストカードと全登録曲検索から、所属を確認して開く/再生を選べます。
- 再生バーに所属経路と、動画/音声の保存状態を表示します。

最大3曲の並列保存、再圧縮しない保存、既存の再生・ショートカット・クラッシュ対策を維持しています。iPhone版は個人利用向けで、AltStoreで導入します（導入・更新の手順は開発状況の資料にあります）。

Windows x64向け更新用Patchの作成対象ブランチです。更新ファイル名はFavecus-Player-0.7.3-Patch.exeです。アプリを終了し、Patchは更新対象フォルダーの外から実行して、FavecusPlayer.exe・app・runtimeがある最上位フォルダーを選びます。標準の直下はapp・downloads・runtime・FavecusPlayer.exeです。

- [操作ガイド](docs/GUIDE.html)
- [開発・配布](docs/BUILD.md)
- [設計](docs/DESIGN.md)
- [変更履歴](docs/CHANGELOG.md)
- [現在の検証・進捗](docs/DEVELOPMENT-STATUS.md)
- [前版の検証記録](docs/VALIDATION-066.md)
- [エラーコード](docs/ERROR-CODES.md)

Windows実機でのGUI・長時間再生、Bilibiliの実通信・保存、Discordの実表示は未確認です。ネイティブクラッシュの完全解消は断定しません。

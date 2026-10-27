# Favecus Player 0.6.6

Bilibiliとローカルの音楽・動画を、階層プレイリストで再生するWindows向けアプリです。

- [x] 元の親子関係を保つ取り込み先の親選択、検索、すべて取り込むボタン。
- [x] 子だけの取り込みでも空の祖先を保持し、関係のない曲を含めない。
- [x] 展開した別リストの曲の前・後へ、確認後に追加・移動。
- [x] ホームへ名称変更し、子を独立した最上位として重複表示しない。
- [x] 容量の確認中でも保存を開始し、処理と並行して全体の容量・時間を推計。
- [x] Google Driveの更新設定と操作ガイドを更新。

最大3曲の並列保存、親・子・曲ごとの保存先、保存済みデータとサムネイルの再利用、再圧縮しない保存、従来の再生・クラッシュ対策は継続します。新しいデバイス間共有方式とGitHub公開は保留しています。

更新はFavecus-Player-0.6.6-Patch.exe、新規導入はSetup.exeを使用します。アプリを終了し、Patchは更新対象フォルダーの外から実行して、FavecusPlayer.exe・app・runtimeがある最上位フォルダーを選びます。標準の直下はapp・downloads・runtime・FavecusPlayer.exeです。

- [操作ガイド](docs/GUIDE.html)
- [開発・配布](docs/BUILD.md)
- [設計](docs/DESIGN.md)
- [変更履歴](docs/CHANGELOG.md)
- [検証記録](docs/VALIDATION-066.md)
- [エラーコード](docs/ERROR-CODES.md)

Windows実機でのGUI・長時間再生、Bilibiliの実通信・保存、Discordの実表示は未確認です。ネイティブクラッシュの完全解消は断定しません。

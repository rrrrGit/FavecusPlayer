# FavecusPlayer 開発ルール

## 基本方針・進捗管理

- 日本語で説明する。既存データ、設定、プレイリスト階層、並び順、保存メディアを保持し、アプリ全体の作り直しは行わない。
- 作業開始時は対象ブランチ（`release/vX.Y.Z`）の最新HEAD、`main` との差分、未反映変更、完了範囲と `docs/DEVELOPMENT-STATUS.md`・関連仕様（設計正本: `docs/DESIGN.md`、ビルド: `docs/BUILD.md`）を確認する。他者の変更を上書きせず、完了済み工程を再実装しない。
- 開発中の計画・進捗・検証結果・次工程は `docs/DEVELOPMENT-STATUS.md` の1件へ集約し、Step別報告や重複仕様を増やさない。旧検証資料とライセンスは保持する。
- 大きな工程は調査・実装・検証・保存が可能な小工程に分割し、実行中の重要な保存・更新処理を時間だけで強制中断しない。

## Git・機密・リリース運用

- `release/vX.Y.Z` へStep単位でCommit＋Pushし、GitHub反映（コミットSHA）を確認する。競合時は再取得して統合する。
- 禁止事項: `main` への直接開発、強制Push、既存タグ付け替え、公開範囲変更、Cookie・認証情報・個人データのコミット、アプリ非管理メディアの一律削除。
- Release公開後の `main` 統合と作業ブランチ削除は、**ユーザー指示時に限り** `.agents/rules/release-merge.md` の手順で行う。

## 検証・UI・報告

- 各Stepでは変更範囲に合う軽量な検証と差分確認を行う。全体ビルド・最終Patch工程は `docs/DEVELOPMENT-STATUS.md` の工程表に従う。
- 自動テストと実GUI・Bilibili実通信・Discord実表示・iOSシミュレーター/実機を区別し、未検証を成功と報告しない。
- UI変更時は触れるプレビューを提示する。確認用HTML・ログ・診断JSONは一時領域で扱い、毎StepのGit資産として蓄積しない。
- 報告は変更点・影響範囲・検証結果・未検証事項・残課題・SHA・次工程を簡潔にまとめる。コード全文や調査ログの重複掲載、文書のみ変更時の不要な全体ビルドは避ける。

## 領域別ルール（該当作業時のみ参照）

- iPhone版（`ios/`）・同期・`shared/`: [ios-and-sync.md](.agents/rules/ios-and-sync.md)
- 保存・移行・並行処理・外部サービス・配布資産・Setup/Patch: [data-and-release-safety.md](.agents/rules/data-and-release-safety.md)
- Release後の `main` 統合・ブランチ削除手順: [release-merge.md](.agents/rules/release-merge.md)

# FavecusPlayer 今後の計画

現在の実装計画（`docs/DEVELOPMENT-STATUS.md`）の範囲外の構想を記録する。具体的な設計・仕様は、着手時に決める。

## AltServer導入exe（別リポジトリでの作成を想定）

- 目的：まっさらなWindows PCでこのexeを起動し、iPhoneを接続するだけで、AltServerの更新（Refresh）に必要なアプリをすべて取得・導入し、以後そのPCを起動するたびにAltServerによる期限更新が行われる状態にする。
- 状態：構想のみ。実装・検証は未着手。
- 範囲：FavecusPlayer本体のリポジトリには含めない想定。具体的な要素（取得元、導入方法、権限、認証情報の扱い等）は、別リポジトリでの着手時に決める。

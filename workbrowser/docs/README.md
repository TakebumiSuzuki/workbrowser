# Workbrowser 日本語ドキュメント

最終更新: 2026-11-16。実装状況はこのリポジトリのコードを基準に記載する。

Workbrowserは、Chromeのサイドパネルから自然言語で調査・スクレーピング・情報抽出・要約を依頼する拡張機能。UIは英語に統一し、指示と回答にはモデルが対応する任意の言語を使える。

## 最初に読む資料

| 資料 | 内容 |
| --- | --- |
| [概要・基本仕様](overview.md) | 目的、画面、ReActループ、拡張とサーバーの役割、データ、制約、実装状況 |
| [Workstationsで開発を再開する](workstations-setup.md) | Workstationsへの移行、会社PCのChromeとの接続、認証、ビルド、確認手順 |
| [会社PCでローカル開発する](company-setup.md) | Chromeと開発サーバーを同じPC、または接続済みDev Containerで使う手順 |
| [本番環境へ移行する](cloud-migration.md) | IAP・Cloud Run・サービスアカウント・共有設定・配布に必要な追加実装と確認事項 |
| [設計と決定事項](design.md) | エージェント、データ送信、ポリシーなどの技術的な決定事項 |
| [検証記録](validation.md) | 実行済みの検証、模擬モデルで確認した範囲、会社環境で未確認の範囲 |

## 開発と本番の区別

- 開発: Chrome拡張 → ローカル開発サーバー → Vertex AI上のGemini。
- Workstationsでの開発: 会社PCのChrome拡張 → 会社PCのlocalhostへ転送 → Workstations上の開発サーバー → Gemini。
- 本番の目標: Chrome拡張 → IAP → Cloud Runサーバー → 実行用サービスアカウントでGeminiへ接続。

ローカルサーバーとReActループのコードは実装済み。本番用のIAPログイン、Cloud Run起動・共有ストアは追加実装が必要。MCPやCloud SQLへの保存機能も未実装。開発環境の移行と本番公開を別々の作業として扱う。

## Geminiなどへ開発を引き継ぐ場合

まず `overview.md`、次に移行先に応じて `workstations-setup.md` または `company-setup.md` を読む。本番対応に着手するときは `cloud-migration.md` の実装箇所と完了条件を確認する。

引継ぎ時の前提:

- ReActループを固定の模擬プランに戻さない。Offline demoは独立した確認モードとして残す。
- UIの言語切替は削除済み。多言語の指示・回答は維持する。
- ブラウザ操作とループは拡張内、AI認証とモデル通信はサーバー側が担当する。
- ページ観察、操作、モデルへの送信に対する既存のサイト制限を維持する。
- 実際の会社モデル・Chrome・ネットワークでの確認結果を、模擬モデルによるテスト結果と分けて記録する。
- この資料の作成時点では、会社環境への接続・デプロイ・IAM設定変更は行っていない。

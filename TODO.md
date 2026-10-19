# 今後の課題

現在の構成と判断理由は [設計判断](docs/DECISIONS.md)、開発手順は [開発ガイド](docs/DEVELOPMENT.md) を参照。

- [ ] 公開用ライセンス・配布 API を決定
- [ ] ネイティブアプリの独立ビルド・インストーラ配布を整備
- [ ] Windows・物理 2 画面で検証
- [ ] Slive の拡大描画変更後、利用環境でスライド切り替え時の一瞬のぼけが解消するか確認
- [ ] 実 Cloudflare / Access ホストで受入検証
- [ ] オブジェクトストレージへの直接配置を公開ジョブへ接続するイベントアダプターを検討
- [ ] Slidock の標準 Web コンポーネントと Slive の UI・UX を改善
- [ ] AWS（ECS、S3、PostgreSQL）および GCP（Cloud Run、GCS、PostgreSQL）の実環境における受け入れ検証
- [ ] npm パッケージおよびサーバー成果物の正式な配布への対応

実装済み機能の検証範囲は [検証記録](docs/results/README.md)、完了済み計画は [アーカイブ](docs/archive/README.md) を参照。

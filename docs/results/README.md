# 検証記録

各JSONは実施時点の検証範囲・結果・制限事項を保存したものです。日付が新しい記録も、その対象外の機能や現在の作業ツリー全体の成功を保証しません。実行手順は [開発ガイド](../DEVELOPMENT.md) を参照してください。

`baseCommit` は検証対象の基点、`baselinePushed` は変更前の基点です。いずれも未コミット差分まで特定する識別子ではありません。記載のない対象コミットは推定せず、各記録のコマンド・証跡・制限事項を確認してください。

| 日付 | 対象と記録 | 記録内のコミット情報 |
| --- | --- | --- |
| 2026-11-24 | [描画 ACK の競合修正と CI 検証の監査](ci-stability.md)・[実行結果](ci-stability.json) | 基点 `4f9f476`＋共有ツリーの未コミット差分 |
| 2026-11-24 | [CI native の検証前提修正と実ウィンドウ回帰](ci-native.json) | 基点 `b317dfb`＋未コミット差分 |
| 2026-11-24 | [CI 公開ジョブの再試行コマンド表示](ci-publication-jobs.json) | 基点 `fd32006`＋未コミット差分 |
| 2026-11-24 | [CI framework の開発監視の起動時競合](ci-framework-dev-scan.json) | 基点 `123254b`＋未コミット差分 |
| 2026-11-24 | [portable の CSS 検査修正と全段階検証](portable-ci-fix.json) | 基点 `a5c2e96`＋未コミット差分 |
| 2026-11-24 | [公式テーマのローカル画像・frontmatter の相対画像](relative-frontmatter-images.json) | 未コミット差分 |
| 2026-10-22 | [Slive ランチャー上の大きさ・見た目の中心](slive-icon-optical.json) | 未コミット差分 |
| 2026-10-22 | [Slive 原本形状に復元・透明背景と全体拡大](slive-icon-original.json) | 未コミット差分 |
| 2026-10-22 | [Slive 下部バーだけ中央揃え・拡幅](slive-icon-bar.json) | 未コミット差分 |
| 2026-10-22 | [Slive 透明背景・青いパーツの中央揃えと拡幅](slive-icon-wide.json) | 未コミット差分 |
| 2026-10-22 | [Slive アイコン内マーク拡大](slive-icon-enlarged.json) | 未コミット差分 |
| 2026-10-21 | [Slive 起動時の投影表示・白い角丸アイコン](slive-startup-icon.json) | 未コミット差分 |
| 2026-10-20 | [自動 Vue ホーム・サブパス配信](pages-subpath.json) | 基点 `d685290`＋未コミット差分 |
| 2026-10-19 | [Slidock フレームワーク・配布と利用側検証](framework-v01.json) | 基点 `d685290`＋未コミット差分 |
| 2026-10-19 | [フレームワークの位置づけ・文書整理とローカルcheck](repository-organization.json) | 基点 `f102220`＋未コミット差分 |
| 2026-10-16 | [Sliveの拡大描画](slive-sharpness.json) | 記載なし |
| 2026-10-16 | [OS用アイコンの余白](slive-icon-size.json) | 記載なし |
| 2026-10-16 | [投影画面のEsc](slive-escape.json) | 記載なし |
| 2026-10-15 | [Sliveの接続先と外観設定](slive-settings.json) | 記載なし |
| 2026-10-15 | [Sliveのサイドバーとデスクトップ識別](slive-shell.json) | 記載なし |
| 2026-10-15 | [Sliveの一覧と戻る操作](slive-navigation.json) | 記載なし |
| 2026-10-13 | [ブランドアイコン](brand-icons.json) | 記載なし |
| 2026-10-13 | [Vueコンポーネント・useCatalog](vue-frontend.json) | 記載なし |
| 2026-10-13 | [Slidev・Vueの開発時ホット更新](hot-reload.json) | 変更前 `f102220` |
| 2026-10-13 | [標準ホーム・公式テーマの利用例](slidock-home.json) | 記載なし |
| 2026-10-12 | [名称・ディレクトリ・CLIの統一](slidock-slive-rename.json) | 記載なし |
| 2026-10-11 | [Sliveの資料一覧・操作UI](native-library-ui.json) | 記載なし |
| 2026-10-10 | [リビジョンごとのランタイム固定](runtime-pinning.json) | 記載なし |
| 2026-10-10 | [非同期公開ジョブ・CLI・進捗画面](publication-jobs.json) | 基点 `2d96e53` |
| 2026-10-10 | [公開ジョブ履歴の自動整理](publication-jobs-auto-retention.json) | 記載なし |
| 2026-10-10 | [旧文書・比較ハーネスの整理](cleanup.json) | 記載なし |
| 2026-10-10 | [当時のNode・Rust・ネイティブ全量回帰](final-regression.json) | 基点 `0104954` |
| 2026-10-10 | [公開ジョブ修正・手動整理・コンテナ検証](publication-jobs-followup.json) | 基点 `ae0448c` |
| 2026-10-10 | [共通サーバー・各プロバイダーのローカル検証](platform-portability.json) | 記載なし |

- `final-regression.json` は2026-10-10の履歴です。後続のVue API・ホット更新・Slive改善はそれぞれの記録を参照してください。
- Sliveの一瞬のぼけは利用環境での確認が残ります。Escの記録は物理キー入力後のOS全画面状態まで検証したものではありません。
- クラウド実環境・Windows・物理2画面の未検証事項は [TODO.md](../../TODO.md) に残しています。ローカル実測とCIの成功は区別します。
- 過去の名称・パスは当時の証跡として保持します。生ログ・スクリーンショットはGit管理外の `artifacts/` にあります。

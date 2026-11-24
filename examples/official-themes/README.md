# Slidev公式テーマのサンプル

このディレクトリは Slidock フレームワークの利用例です。公式デモは `pnpm dev:slidock` で `localhost:4174` に起動し、スライドとホームをホット更新します。静的ビルドは `pnpm build:slidock`、その配信は `pnpm preview:slidock` です。ホーム画面は `examples/official-themes/App.vue` で編集します。`home.ts` は Vue のマウントと CSS の読み込みを行うエントリーです。ルートの `build:slidock:fixtures` および `verify:slidock:fixtures` は従来の回帰テスト用フィクスチャのビルドと検証として個別に維持されており、`verify:slidock` は新しいデモのブラウザ検証を実行します。

サンプルのファイル内容は、`https://github.com/slidevjs/themes` のコミット `6bb2889af4c66c1fbab4c1beb2e8d962a3b55648` における `packages/theme-{name}/example.md` を元にしています。Default・Seriph・Apple Basic の外部画像参照は、自作の抽象背景画像 `slides/assets/abstract-background.svg` への相対パスに変更しています。それ以外の本文は上流のままです。テーマのバージョンは `Default`、`Seriph`、`Shibainu`、`Bricks` が 0.25.0、`Apple Basic` が 0.25.1 です。`examples/official-themes/sources.json` でバージョン、上流パス、リポジトリ内のサンプルの SHA256 ハッシュを追跡します。静的ビルドはハッシュとバージョンを検証し、フロントマターの `theme: ./` を書き換えずにテーマプロファイルを渡します。指定したコミットはサンプルに適用され、固定された npm パッケージのバージョンはテーマ自体に適用されます。

コードは MIT ライセンスです。上流の規定に基づき画像やアセットには CC BY-NC-SA 4.0 が適用され、複製された上流のライセンス情報は `examples/official-themes/LICENSE` に配置されています（参照: `https://github.com/slidevjs/themes#license`）。追加した抽象背景画像は Slidock 本体と同じ MIT ライセンスです。サンプルの背景画像を表示するための外部画像サービスへの接続は不要です。


開発中は本文の編集を許可するため、ソースのハッシュ一致を要求しません。公式デモの静的ビルドでは引き続き一致を要求します。デッキ一覧・テーマプロファイルの変更後は開発サーバーを再起動してください。

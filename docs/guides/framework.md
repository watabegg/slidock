# Slidock フレームワーク利用ガイド

Slidock は、複数の Slidev プレゼンテーションをまとめて管理・配信するためのフレームワークです。互換性のあるスライド同士で静的バンドルを共有して配信を効率化し、開発環境ではスライドごとに独立した Slidev ランタイムを起動して作業を進められます。

静的サイトの生成と閲覧に必要な直接の依存パッケージはメインパッケージの `@slidock/slidock` のみであり、静的配信用の常駐サーバーや Rust、Slive は不要です。また、既定のライフサイクルにおいて Chromium などのブラウザを用意する必要もありません。

本フレームワークは現在実装中であり、本書では規定された API の仕様（コントラクト）を説明します。現時点で一般公開や完全な検証完了を保証するものではありません。

> **パッケージの公開状況に関する注意**  
> `@slidock/slidock`（MIT ライセンス、Node.js 24.15.0 以上が必要）の npm レジストリへの公開はまだ行われていません。本ガイドに記載されているインストール手順は、正式公開後、または隔離されたローカルのパックレジストリなどで検証環境を整えた場合に利用できます。現時点では本パッケージ自体の公開を行っておらず、公開レジストリからのインストールが成功する状態にはありません。

---

## 導入と基本操作

既存の空フォルダに導入するか、新しいディレクトリを作成して開始します。

### 既存の空フォルダに導入する場合

既存のフォルダで作業する場合は、パッケージを追加した後に `npx` 経由で初期化と開発サーバーの起動を行います。

```bash
npm install -D @slidock/slidock
npx slidock create .
npx slidock dev
```

この操作では既存の `package.json` が保持され、スクリプト（`scripts`）の自動追加や書き換えは行われません。そのため、コマンドの実行には `npx` を使用します。

### 新しいディレクトリを作成する場合

新しいディレクトリ名を指定して `create` を実行すると、ディレクトリ内に厳密な依存関係と実行用スクリプトを含んだ `package.json` が生成されます。

```bash
npm exec --package=@slidock/slidock -- slidock create my-slides
cd my-slides
npm install
npm run dev
```

新しく作成されたディレクトリへ移動した上で、依存パッケージのインストールを実行してください。

なお、`create` コマンドが依存関係の自動インストールや外部ネットワークとの通信を行ったり、既存ファイルを断りなく上書きしたりすることはありません。

### CLI コマンド一覧

日常の開発やビルドには以下のコマンドを使用します。

- `npx slidock dev`: 開発サーバーを起動します。
- `npx slidock check`: スライドの配置や設定の整合性を検証します。
- `npx slidock build`: 静的配信用ファイルを `dist` ディレクトリへ出力します。
- `npx slidock preview`: `dist` に出力された静的サイトをプレビューします。ビルド後に元のスライドファイルを削除した場合でも、`dist` 内のファイルを読み込んで表示します。

#### コマンドオプション

- 開発サーバー（`dev`）およびプレビュー（`preview`）は、既定で `127.0.0.1:4174` で起動します。
- `--port <番号>`: 待ち受けポート番号を変更します。
- `--config <パス>`: 設定ファイルのパスを明示的に指定します。
- `preview --host <アドレス>`: プレビューサーバーの待ち受けアドレス（例: `0.0.0.0`）を指定し、外部からのアクセスを許可します。
- `--json`: 実行結果を JSON 形式で出力します。

---

## 設定ファイル（slidock.config.ts）

プロジェクトのルートに `slidock.config.ts` を配置して動作をカスタマイズします。`@slidock/slidock` から `defineConfig` をインポートし、設定オブジェクトを既定でエクスポートします。

```ts
import { defineConfig } from '@slidock/slidock'

export default defineConfig({
  sourceRoot: './slides',
  outDir: './dist',
  include: ['**/slides.md'],
  exclude: ['**/archive/**'],
  home: {
    title: '資料一覧',
    description: '公開資料'
  },
  deckOptions: {
    welcome: {
      id: 'getting-started',
      title: 'はじめに',
      order: 1
    },
    second: {
      draft: true
    }
  }
})
```

Node.js 24 の型情報除去機能（Type Stripping）により、TypeScript ファイルは事前の変換処理を挟まずローカルの実行可能コードとして直接読み込まれます。

### 既定値と探索規則

設定項目を省略した場合、以下の既定値が適用されます。

- `offline`: `false`
- `thumbnails`: `'none'`
- `compatibilityGroups`: `true`
- `allowEmpty`: `true`（スライドが 1 件も存在しない場合でも空のホーム画面を表示します）

設定ファイルは、プロジェクトルートから以下の順序で探索されます。

1. `slidock.config.ts`
2. `slidock.config.mjs`
3. `slidock.config.js`
4. `slidock.config.json`
5. `hub.config.json`

設定ファイル内のパス指定は、その設定ファイルが置かれている場所からの相対パスとして解決されます。過去の互換性のために残されている `hub.config.json` を使用した場合、旧来の動作設定である `offline: true` および `thumbnails: 'auto'` が維持されます。

なお、設定ファイル内で外部ヘルパー関数などを読み込んでいる場合、それらの関数に対する変更は開発時のホットリロードが保証されません。

---

## スライドファイルの管理と動作

スライドファイルは `sourceRoot` で指定したディレクトリ（既定では `./slides`）の下に配置します。

### ディレクトリ構造とスライド ID

各スライドは、専用のサブディレクトリ内に `slides.md` を配置して作成します。

```text
slides/
  welcome/
    slides.md
  architecture/
    slides.md
```

例えば `slides/welcome/slides.md` を配置すると、ディレクトリ名からスライド ID が `welcome` として自動検出されます。開発サーバーの起動中にフォルダを追加または削除すると、一覧（カタログ）が自動的に更新されます。

### 表示と並び順の制御

- **下書きの除外**: `deckOptions` で `draft: true` を指定したスライドは、静的ビルドの出力対象から除外されます。
- **表示順序（order）**: 一覧画面では、まず `order` に指定された数値の昇順で並び、その後にスライド ID 順で並びます。
- **ID の上書き**: `deckOptions` の設定キーには、上書き後の ID ではなく「ディレクトリ名から自動検出された元の ID」を指定します。上書きを適用した結果として最終的な ID が重複した場合はエラーになります。

### 表紙画像（cover）とサムネイル

スライドの表紙画像は、設定ファイルからの相対パスで `png`、`jpeg`、`webp`、`svg` 形式の画像ファイルを指定できます。リモート URL の指定には対応していません。

サムネイル設定の既定値 `thumbnails: 'none'` ではプレースホルダー画像が使用されます。`thumbnails: 'auto'` を使用する場合は、環境に対応する Playwright ブラウザがインストールされている必要があります。なお、`playwright-core` 自体は依存関係に含まれますが、ブラウザバイナリは任意導入であり自動インストールコマンド等は用意されていません。利用可能なブラウザがある場合は設定で `chromiumExecutable` に実行可能ファイルのパスを指定できます。プロジェクト README 等に記載されている既存のセットアップ手順は、本フレームワーク全体ではなく開発リポジトリ固有のコンテキストである点に留意してください。

### 編集時の挙動

- **スライドの更新**: Markdown ファイルを編集すると、Slidev のホットモジュール置換（HMR）によってブラウザ側の表示が即座に更新されます。
- **設定エラー時の保護**: 設定ファイルに不正な記述を行った場合でも、直前まで動いていた安全な開発状態が維持されます。エラーを修正して保存すると、画面のエラー表示（オーバーレイ）から自動で復旧します。
- **静的ビルドの反映**: 静的ビルドの成果物（`dist`）は、ビルドコマンド（`npx slidock build`）を再実行したときにのみ更新されます。

---

## 静的サイトの配信（デプロイ）

生成された静的サイトは、ルートパスまたは設定した `basePath` に配置して配信します。

### 配布の制約事項

- **サブパス配信**: Web 配信では `basePath` を指定できます。配置とフォールバックの設定は [自動 Vue ホームとサブパス配信](pages-subpath.md) を参照してください。
- **共有グループの決定要因**: スライド間で共通の静的バンドルをまとめるグループ化は、Slidev のバージョン、使用テーマ、セットアップ、コンパイル設定の一致に依存します。単に同じテーマを使っているという理由だけで、必ず共通バンドルにまとまるわけではありません。
- **ビルド結果の表示**: ビルド完了時に出力される `groups` の結果は、容量の削減率（パーセンテージ）ではなく、実際に生成されたグループの構成内容を報告します。

---

## フロントエンドのカスタマイズ

ホーム画面の見た目や構造は、要件に応じて段階的に変更できます。

1. **設定値の変更**: `slidock.config.ts` の `home` 項目（タイトルや説明文など）を書き換えます。
2. **コンポーネントとスロットの活用**: 提供されている Vue コンポーネントを配置し、スロットを使って一部分の表示を差し替えます。
3. **ヘッドレス（独自 UI の構築）**: データ取得用の関数のみを利用し、画面表示をすべて独自に実装します。

### 自動ホームと独自エントリーポイント

`pages/index.vue` を置くと自動的にホーム画面になります。`main.ts` や `createApp` は不要です。詳細は [自動 Vue ホーム](pages-subpath.md) を参照してください。

表示を大きくカスタマイズしたい場合は、設定ファイルの `frontendEntry` に独自のエントリーファイルのパス（設定ファイルからの相対パスまたは絶対パス）を指定して Vite のエントリーポイントを差し替えます。

ブラウザ側で動作するクライアントコードは Node.js 環境に依存しません。フレームワークが提供する CSS はホスト側のグローバルスタイルを汚染しないよう設計されていますが、ページ全体のリセットを行いたい場合は任意で `frontend/site.css` を読み込むことができます。また、従来の `--hub-*` から始まる CSS カスタムプロパティも引き続き利用可能です。

### Vue API とコンポーネントの仕様

`@slidock/slidock/frontend` から UI コンポーネントとデータ取得関数をインポートして利用します。

- `useCatalog()`: カタログ情報を取得します。返り値は `{ catalog, pending, error, reload }` です。
  - `catalog`: `shallowRef<Catalog | null>` 型のリアクティブな参照です。
  - `pending`: 読み込み中かどうかを示す `Ref<boolean>` 型のリアクティブな参照です。
  - `error`: 取得失敗時のエラー情報を保持する `ShallowRef<unknown>` 型のリアクティブな参照です（初期値は `null`）。
  - `reload`: カタログ情報を再取得するための関数です。
- `<SlidockHome />`: カタログ表示用の標準コンポーネントです。
  - スライド一覧を渡すプロパティ名は `:catalog="catalog"` です（`:decks` ではありません）。
  - `controls`: `false` を指定すると標準の操作ツールバーを非表示にできます。
  - `v-model`: `query`（検索語句）、`category`（選択カテゴリ）、`tag`（選択タグ）、`sort`（並び順）を双方向にバインドできます。
  - スロット: `toolbar`（操作部全体）や `card`（スライドカード個別）の表示を差し替えられます。

#### 実装例

以下は、カスタムエントリーからマウントする Vue コンポーネントの実装例です。本番環境での画面表示に合わせて、読み込み中（`pending`）やエラー時（`error`）の処理、再読み込みボタン（`reload`）を適切に配置します。

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { SlidockHome, useCatalog } from '@slidock/slidock/frontend'


const { catalog, pending, error, reload } = useCatalog()
const query = ref('')
</script>

<template>
  <main>
    <div v-if="pending">資料一覧を読み込んでいます...</div>

    <div v-else-if="error">
      <p>情報の取得中にエラーが発生しました。</p>
      <button type="button" @click="reload">再試行</button>
    </div>

    <SlidockHome
      v-else-if="catalog"
      :catalog="catalog"
      v-model:query="query"
    >
      <template #card="{ deck, href }">
        <a :href="href" class="custom-card">
          {{ deck.title }}
        </a>
      </template>
    </SlidockHome>
  </main>
</template>
```

アプリケーションのエントリーポイント（JavaScript/TypeScript）側では、スタイルのインポートとマウントを行います。

```ts
import { createApp } from 'vue'
import App from './App.vue'
import '@slidock/slidock/frontend/style.css'

createApp(App).mount('#app')
```

> **注意**: 提供されている SFC（Single File Component）を利用するには、利用側のプロジェクト環境で Vue および Vite が正しく動作している必要があります。フレームワークに依存しない事前構築済みの HTML 出力コンポーネントではないため、Vue のコンパイル環境が必要です。

### データの検索と並び替え（selectCatalogDecks）

画面側で独自にスライドの絞り込みや並び替えを行いたい場合は、`@slidock/slidock/client` からエクスポートされている純粋関数 `selectCatalogDecks` を利用できます。

```ts
import { selectCatalogDecks } from '@slidock/slidock/client'

const filteredDecks = selectCatalogDecks(decks, {
  query: 'Vue',
  tag: 'intro',
  sort: 'title'
})
```

この関数は以下の条件に基づいて動作します。

- **検索語句（`query`）**: タイトル（`title`）、説明文（`description`）、著者（`author`）、タグ（`tags`）を対象に、前後の空白を除去し、大文字・小文字を区別せず部分一致で検索します。
- **カテゴリ（`category`）**: 指定したカテゴリに属するスライドだけでなく、その子孫階層のカテゴリに含まれるスライドも対象とします。
- **タグ（`tag`）**: 完全一致で判定します。
- **条件の結合**: 指定された複数の絞り込み条件はすべて論理積（AND）で組み合わされます。
- **並び順（`sort`）**:
  - `'catalog'`: 設定ファイルで定義された順序をそのまま保持します。
  - `'title'`: タイトルの辞書順で並べ、同一の場合はスライド ID 順で並べます。
  - `'date'`: 有効な日付を持つスライドを最新順で先頭に配置し、無効な日付や日付のないスライドを末尾にまとめます（同順位は元の順序を維持）。
なお、この関数は元の配列を変更せず、新しい配列を返します。

---

## 補足仕様と現在の検証範囲

- **Node.js API の互換性**: 以前のバージョンで提供されていた `buildHub` および `devHub` API は互換性のために維持されています。これらに加え、新しいインターフェースとして `defineConfig` および `loadProject` が追加されています。
- **独立機能**: 高度な操作を行うリモート CLI や Slive といったツールは、本コアフレームワークとは切り離された個別のオプション機能です。
- **検証環境の範囲**: 本フレームワークの動作確認は Linux 環境を対象に実施されており、その結果は個別の資料に記録されています。Windows、macOS、各種クラウド環境、または各プラットフォームの独自環境での動作については、現時点で動作保証を公表していません。外部への公開も未実施です。

# CI 検証の安定化 検証記録

> 前半の原因調査と実行結果は初回対応時の記録です。候補 8 件の追加対応は下表と「追加安定化の検証（2026-11-24）」に記載しています。

`verify-remote` 検証をローカルで再現して特定した原因は、Vue のページ再入場トランジションに伴う一時的な非表示状態で bridge が誤って失敗を返していたこと、および検証スクリプト側が失敗通知を待機条件に含めず ACK だけを待ち続けていたことにある。成功したチェック数や操作、エラーのスタックトレースが一致することから、CI 上の HTTP タイムアウトでも同じ競合が起きたと考えられる。12 秒の期限内で過渡的な透明状態を許容して再待機するように bridge を修正し、検証スクリプトも失敗通知の受信や実際の DOM 条件を待つように改めた結果、修正対象の各検証が直列 3 回連続で成功することを確認した。あわせて CI 関連スクリプトおよびテストファイル 53 件を監査し、今回は変更しない 8 件の候補と据え置きの理由を整理した。

## 対象と制約

本記録は 2026-11-24 時点の `main` ブランチ（基点コミット `4f9f4763199486dd2b1944e69dd17fe0cbe43ebb` ＋未コミット差分）に対する修正と検証の結果をまとめたものである。対象は remote 検証における HTTP タイムアウトの原因修正、CI スクリプトの監査、および修正後の 3 回以上の検証実行である。

- **共有作業ツリー**: 他作業者が [checks.yml](../../.github/workflows/checks.yml)、[package.json](../../package.json) の scripts、および [verify-portable.mjs](../../scripts/verify-portable.mjs) を変更中のため、今回の担当はこれらを編集していない。他作業者による [ci-changes.mjs](../../scripts/ci-changes.mjs) と [ci-changes.test.mjs](../../scripts/ci-changes.test.mjs) も差分に含まれており、`pnpm check` などの実測はこの共有ツリー全体に対する結果である。コミットと push は行っていない。
- **実行環境**: Node v24.22.1、pnpm 12.3.4、Chromium 153.0.8010.12、Linux 上で実行した。GitHub Actions 上の全量 CI やクリーンコンテナでの実行ではない。

## 原因の証拠と切り分け

### CI ログとローカル再現の事実

GitHub Actions の run `45363069940`（attempt 1）における `portable` ジョブ（ID: `138337729255`）のログを以下のコマンドで取得し、[ci-attempt-1.log](../../artifacts/ci-stability/ci-attempt-1.log) に保存した。

```bash
gh api --allow-escape-sequences repos/watabegg/slidock/actions/jobs/138337729255/logs
```

ログによると、HTTP 検証で 9 件のチェックが成功したあと、`verify`（修正前コードの旧 201 行目）から呼び出された `setState` 内の `page.waitForFunction`（修正前の旧 88 行目、18000ms タイムアウト）でタイムアウトして失敗し、後続の HTTPS 検証は 33 件すべて成功していた。当時の `setState` は、`nativeRendered` の `deckId`・`page`・`clickIndex`・`sessionRevision` のすべてが送信した状態と一致することだけを待機条件としており、bridge 側の失敗通知を待機対象に含めていなかった。

修正前の `node apps/slive/scripts/verify-remote.mjs` をローカルで 1 回実行したところ、終了コード 1 で失敗し、CI と同じ「HTTP 9 件成功後にタイムアウト、HTTPS 33 件成功」の症状が再現した（[remote-baseline.log](../../artifacts/ci-stability/remote-baseline.log)、[baseline-result.json](../../artifacts/ci-stability/baseline-result.json)、[baseline-failure.png](../../artifacts/ci-stability/baseline-failure.png)）。このとき `hostState.errors` には `Error: rendered route differs from Rust state` が記録されていた。

### ローカルトレースから判明した競合メカニズム

調査用の一時的なトレース版（追跡コードは `artifacts` 配下のみ）を実行したところ、通常の最初のトレース試行（[trace.log](../../artifacts/ci-stability/trace.log)）は終了コード 0 で成功し、別の試行では終了コード 1 で同じ「HTTP 9 件成功後に失敗・HTTPS 33 件成功」が再現した（[trace-1.log](../../artifacts/ci-stability/trace-1.log)、[trace-1.json](../../artifacts/ci-stability/trace-1.json)）。トレースが記録した状態遷移は「初期表示 → `1:0` → `2:0` → `2:1` → `2:2` → `3:0` → `1:0`」であり、失敗したのは最後の同じ資料（1 ページ目）へ戻る操作（`sessionRevision: 6`、`page: 1`、`click: 0`）だった。

この戻り操作における DOM とルーターの経過は次のとおりである。

1. **893.1ms**: 1 ページ目は直前の離脱トランジション（`fade-leave-active` / `fade-leave-to`）の途中にあり、`opacity` が `3.41335e-11`（0 より大きい極小の正数）だった。
2. **895.8ms**: `router.replace('/1')` が完了し、ルートは `/1`、`clicks` は `0` になった。一方、DOM は `fade-enter-from` / `fade-enter-active` へ切り替わった。
3. **904.4ms**: DOM の `opacity` が `0` になり、次の `requestAnimationFrame`（rAF）の時点でも `0` だった。
4. **921.6ms**: `enter-to` へ移行しても、その時点では `opacity` が `0` だった。

修正前の `currentSlide` は `opacity != 0` であれば表示済みと判定していた。そのため、`router.replace('/1')` 完了後の最初の判定でも、残っていた極小の正数の `opacity` によって表示済み扱いとして先に進み、画像・フォントの待機と 2 回の rAF を経て 1 度だけ再検査した。その再検査時に `opacity` が `0` になっていたため `!slide`（表示中のスライドが存在しない）と判定され、`rendered route differs from Rust state` を送出した。実際にはルートも `/1`、クリック数も `0` に到達していたため、このエラーメッセージ自体は原因を正しく表していなかった。

すなわち原因は、メッセージやイベントリスナーの取りこぼしではなく、Vue の再入場トランジションと bridge 側の「2 rAF 後に 1 回だけ検査する」処理の順序競合である。さらに、`nativeFailure` はホストへ届いていたにもかかわらず、`verify-remote` がそれを参照せず ACK を待ち続けたため 18000ms のタイムアウトとなった。

### 事実と推論の境界

CI 実行時には各時点の DOM 状態や `hostState` を保存していないため、CI 上でローカルと完全に同じ順序の割り込み（interleaving）が起きたとまでは断定できない。しかし、成功したチェック数、操作内容、エラーのスタックトレースが一致し、ローカルでも同じ症状を再現できたことから、CI でも同じ競合が起きたと考える。HTTP の場合だけ発生する実装上の差異は見つかっておらず、HTTPS が成功した差もタイミングによるものと推定する。また、CPU 負荷が唯一の原因であるとも断言しない。

## 実施した変更

タイムアウト原因の解消と他の固定時間待機の置き換えとして、以下の 5 ファイルを変更・追加した。

- **[deck-bridge.ts](../../packages/protocol/src/bridge/deck-bridge.ts#L208-L242)**: 同じ 12 秒の期限内で「可視性確認 → 画像・フォント待機 → 2 rAF → 可視性再検査」を実行し、いったん非表示（透明）になった場合は即座に失敗させず待機ループを継続するように変更した。期限まで透明のままなら期限切れとして失敗し、待機中に最新の state へ変化した場合は古い状態を捨てる。ワイヤー形式、Rust 側の状態権威、通常の Web 操作、および各タイムアウト値は維持しており、本体の挙動変更は「一時的な `opacity: 0` を即エラーにしない」点だけである。継続的な非表示、画像エラー、route や click の不一致は引き続き失敗する。
- **[bridge.test.mjs](../../packages/protocol/tests/bridge.test.mjs)（新規作成）**: rAF と `opacity` を手動で制御し、`opacity` が `0` から復帰して ACK を返すケース、非表示のまま 12 秒が経過して failure になるケース、新しい state が待機中の state を置き換えるケースの 3 テストを追加した。
- **[verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs#L79-L132)**: `setState` が対応する ACK または新規の host error を待つように変更し、エラーを受けた場合は即座に `assert` へ渡すようにした。返す report は対象の `sessionRevision` で選択する。18 秒のタイムアウト値は変更していない。
- **[verify.mjs](../../apps/slidock-worker/scripts/verify.mjs#L194)**: クリック後の 350ms 固定 sleep を、`query.clicks=1` および対象要素の visibility と `opacity` を確認する条件待ちへ置き換えた。
- **[verify-library.mjs](../../packages/slidock/scripts/verify-library.mjs#L66-L75)**: 2.5 秒の固定 sleep を操作バーの実際の `opacity` が `0` になるまで待つ条件待ちへ変更した。従来の viewport（`1440x1000`）では Slidev の `isScreenVertical = height - width / aspect > 120` により `persistNav=true` が有効になり、「バーが隠れても home link が残る」という検査本来の目的を確認できていなかったため、スライド表示前に viewport を `1440x810` へ変更して常時表示を解除した。最初の条件待ち試行は旧 viewport のままだったため 30 秒で終了コード 1 となったが、viewport を修正した最終検証では 3 回成功している（[library-1.log](../../artifacts/ci-stability/library-1.log) は最終成功結果で上書き済み）。

## 実行結果

繰り返し検証はすべて直列で実行し、終了コードが 0 のものだけを成功として扱った。

| 実行コマンド | 状態・回数 | 終了コード | 結果の概要 | 記録ファイル |
| :--- | :--- | :--- | :--- | :--- |
| `node apps/slive/scripts/verify-remote.mjs` | 修正前・1 回 | 1 | HTTP 9 成功後タイムアウト、HTTPS 33 成功 | [remote-baseline.log](../../artifacts/ci-stability/remote-baseline.log) |
| `node --test artifacts/ci-stability/bridge-before.test.mjs` | 修正前・1 回 | 1 | HEAD の旧 bridge で新規 3 テストが全失敗 | [bridge-before-test.log](../../artifacts/ci-stability/bridge-before-test.log) |
| `pnpm --filter @slidock/protocol test` | 修正後・1 回 | 0 | 16 tests 成功 | [protocol-test.log](../../artifacts/ci-stability/protocol-test.log) |
| `pnpm build:slidock:fixtures` | 修正後・1 回 | 0 | 4 資料を再生成 | [build-fixtures.log](../../artifacts/ci-stability/build-fixtures.log) |
| `taskset -c 0 node apps/slive/scripts/verify-remote.mjs` | 修正後・3 回 | 0, 0, 0 | 1 CPU 制限下で毎回 HTTP 33 + HTTPS 33 成功 | [remote-fixed-1.log](../../artifacts/ci-stability/remote-fixed-1.log)〜[3.log](../../artifacts/ci-stability/remote-fixed-3.log)（各 `.json` 含む） |
| `pnpm build:workers` | 修正後・1 回 | 0 | worker ビルド成功 | [build-workers.log](../../artifacts/ci-stability/build-workers.log) |
| `pnpm --filter @slidock/workers verify` | 修正後・3 回 | 0, 0, 0 | 各回 39 checks 成功 | [workers-1.log](../../artifacts/ci-stability/workers-1.log)〜[3.log](../../artifacts/ci-stability/workers-3.log) |
| `pnpm --filter @slidock/slidock verify:library` | 修正後・3 回 | 0, 0, 0 | 3 回成功（最終結果 JSON は [result.json](../../packages/slidock/artifacts/browser-library/result.json)） | [library-1.log](../../artifacts/ci-stability/library-1.log)〜[3.log](../../artifacts/ci-stability/library-3.log) |
| `node --test packages/protocol/tests/bridge.test.mjs` | 修正後・3 回 | 0, 0, 0 | 毎回 3 tests 成功 | [bridge-fixed-1.log](../../artifacts/ci-stability/bridge-fixed-1.log)〜[3.log](../../artifacts/ci-stability/bridge-fixed-3.log) |
| `pnpm lint` | 最終差分・1 回 | 0 | lint 成功 | [lint.log](../../artifacts/ci-stability/lint.log) |
| `pnpm format:check` | 最終差分・1 回 | 0 | format 検証成功 | [format-check.log](../../artifacts/ci-stability/format-check.log) |
| `pnpm check` | 最終差分・1 回 | 0 | 425 tests（416 pass、0 fail、9 skipped） | [check.log](../../artifacts/ci-stability/check.log) |

各実行結果の補足は次のとおりである。

- **旧 bridge との対比**: [bridge-before.test.mjs](../../artifacts/ci-stability/bridge-before.test.mjs) では、作業ツリーや生成済み `dist` を上書きせずに HEAD 時点の旧 bridge を別ファイルへ bundle して新規 3 テストを実行し、修正前コードでは全件失敗することを確認した。
- **1 CPU 制限下での再現確認**: `taskset -c 0` により Node と Chromium 子プロセス全体を 1 CPU に制限した状態で `verify-remote.mjs` を 3 回実行し、いずれも HTTP 33 件・HTTPS 33 件が成功した（[remote-fixed-1.log](../../artifacts/ci-stability/remote-fixed-1.log) / [1.json](../../artifacts/ci-stability/remote-fixed-1.json)、[remote-fixed-2.log](../../artifacts/ci-stability/remote-fixed-2.log) / [2.json](../../artifacts/ci-stability/remote-fixed-2.json)、[remote-fixed-3.log](../../artifacts/ci-stability/remote-fixed-3.log) / [3.json](../../artifacts/ci-stability/remote-fixed-3.json)）。
- **共有ツリー全体の `pnpm check`**: 並行担当者の新しい CI 判定テストを含む共有ツリー全体に対して `lint`・`format`・`typecheck`・`test`・`boundaries` を完了した。`boundaries` は 0 違反・0 移行例外だった。425 テストのうち 9 件は `HUB_TEST_DATABASE_URL` が未設定である PostgreSQL 統合テストのためスキップされている。また、Wrangler 型生成では既定のホーム配下ログ出力先が sandbox の読み取り専用領域にあたるため `EROFS` が表示されたが、型生成自体と `pnpm check` の終了コードは 0 だった。これを typecheck の失敗扱いにも無警告の成功扱いにも変えず、事実のまま記録する。

## CI スクリプト監査と未修正候補

`scripts/`、`apps/*/scripts/`、`packages/*/scripts/`、および `packages/*/tests/`（追加した `bridge.test.mjs` を含む共有ツリー時点で 53 テストファイル）を対象に、待機、タイムアウト、HTTP 要求、ポートの listen、および依存順序を読み取って調査し、現行の workflow と `package.json` の scripts へ照合した。URL 文字列としての `.example`・`.test`・`.invalid` や `Request` オブジェクトの生成は実通信と区別した。

現行の CI workflow は `check`、`portable` 配下、`packed-cli`、`server`（`packed-server`・`server`・`publication-jobs` と DO 検証）、`framework`（`packed-framework`・`frontend`・`pages`）、および `native`（`workers-slive`・`slive`）へ到達する。一方、`verify-runtime-upgrade`、`verify-native-rendering`、`verify-dev-server`、`verify-vue-frontend` は現行 workflow から直接到達しない。

調査で見つかった処理のうち、`publication` や `worker` の 50〜300ms の遅延などは条件ポーリングの間隔、`verify-flicker` の sleep は意図的なドキュメント遅延や観測サンプリング、`native` の 180 秒は QA 期限、5 秒は SIGTERM の猶予であり、いずれも固定の起動完了待ちではない。`portable` の子コマンドは直列実行であり、runtime・package・fixture の前提を組む現行の依存順序に新しい欠落は見つからなかった。なお、検証用アプリの listen ポートは port 0 を使用しており、下記の再 bind 以外の固定アプリポートは検出されなかった。ただし、同一成果物ディレクトリを複数検証から同時実行する安全性は未実測である。また、外部の画像・フォント・CDN への新しい直接要求は監査範囲で見つからなかったものの、すべての生成資産の完全な通信トレースを取得したわけではなく、依存取得やオフライン資産準備のビルド段階については完全オフライン保証ではない。

初回監査で据え置いていた 8 件の未修正候補に対し、同日追加で検証側の安定化対応を実施し、7 件を修正して 1 件を据え置きとしました。修正にあたっては成功時の経路に固定時間の待機を入れず、条件付き待機のタイムアウト上限の延長と失敗時のリトライによって不安定さを抑えています。完全なオフライン化は行っておらず、処理時間の短縮効果は未計測であり、厳密に所要時間が変わらないことも保証しません。変更は検証側のコード・設定・結果文書のみにとどまり、製品ソースコードの変更、`DECISIONS` への追加、`.env` および `.env.*` の操作は行っていません（変更は `main` 作業ツリー上のみで、コミットやプッシュは未実施です）。

| 対象箇所 | 挙動とリスク | 今回の対応・見送り理由 |
| :--- | :--- | :--- |
| [scripts/verify-packed-framework.mjs](../../scripts/verify-packed-framework.mjs)<br>（[.github/workflows/checks.yml](../../.github/workflows/checks.yml) の `framework` ジョブ含む） | `@slidock` のみ一時ローカルレジストリ、それ以外は実 npm レジストリを参照するため、通信の一時失敗やキャッシュ未活用で依存導入が失敗するリスクがある。 | 既存のレジストリ構成を維持したまま、[scripts/consumer-install.mjs](../../scripts/consumer-install.mjs) の共通設定（`fetch-retries=4`、`fetch-retry-mintimeout=1000ms`、`fetch-retry-maxtimeout=10000ms`、`prefer-offline`）を `npm`・`pnpm` およびフロントエンドの `npm install` に適用し、未取得の依存パッケージはレジストリから取得するようにした。`pnpm` には `configureInstallRetries` により一時コンシューマーの `pnpm-workspace.yaml` へ `fetchRetries: 4`・`fetchRetryMintimeout: 1000`・`fetchRetryMaxtimeout: 10000` を追記して CLI 引数は返さず（[pnpm のネットワーク設定](https://pnpm.io/settings/network)）、`npm` には `--fetch-retries=4` などの CLI 引数形式で渡す（`pnpm` 12 では CLI 形式が受理されても期待どおりの再試行を確認できず、YAML 設定への変更後に HTTP 503 を越えて導入に成功した）。`framework` ジョブには `npm config get cache` で得る実キャッシュパス向けの `actions/cache` を追加し、既存の pnpm store キャッシュも維持した。 |
| [scripts/verify-packed-cli.mjs](../../scripts/verify-packed-cli.mjs) /<br>[scripts/verify-packed-server.mjs](../../scripts/verify-packed-server.mjs) | 一時的なレジストリ通信障害やキャッシュ未活用により、依存導入が失敗して検証が中断するリスクがある。 | 同じ要求単位のリトライ設定と `prefer-offline` を導入し、`ignore-scripts` を維持した。CLI の既存 tarball 隔離・リポジトリ symlink 不使用および server の HTTP 公開検査は維持している。リトライ上限を超えた失敗を成功扱いするコードはなく、再試行の対象は `install` 全体ではなくレジストリ要求のみに限定している。 |
| [apps/slidock-worker/scripts/verify-publication-jobs.mjs](../../apps/slidock-worker/scripts/verify-publication-jobs.mjs) | `findFreePort` で空きポートを取得して閉じた後に再バインドするため、起動までの間に別プロセスへポートを奪われる競合リスクがある。 | `findFreePort` を削除し、`startHubServer` でポート `0` の listener を先にバインドしてオリジンを確定させたうえで、`fetch` を後から構成した `application.server` へ委譲する構成へ変更した。同じ listener を保持して `publicOrigin` に設定するためクローズと再バインド自体がなくなり、構成失敗時は listener を閉じ、終了時は listener とアプリケーションの双方を閉じる。製品の adapter 側には変更を加えていない。 |
| [apps/slive/scripts/verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs)<br>（固定待機・状態検査） | `waitForTimeout(100)` を 3 か所で固定待機として使っており、不安定さや不正状態・異常遷移の見逃しにつながるリスクがある。 | `waitForTimeout(100)` を 3 か所とも削除した。キーの down/up 後は同じ親から `ArrowLeft` を sentinel として FIFO 送信し、host 側の `previous` 通知まで待って入力列が正確に `next,previous` であることと `route`・`reports`・`token` が変化しないことを検査する。不正状態の送信後は現在と同じ `page` と `clickIndex` を保持したまま `sessionRevision` だけを増やした状態を送信して ACK を待ち、ACK の増加数が正確に 1 件であることを確認する（高 revision の不正状態が受理された場合は後続の正 revision の ACK が返らず失敗する）。また、`router.afterEach` で中間ルートも観測して異常遷移が後の正しい状態で上書きされ隠蔽されるのを防ぎ、Vue Router の URL エンコード表記差（`:` と `%3A` 等）は値を正規化して比較する。なお、無期限に未来の不発までを保証する検査ではない。 |
| [apps/slive/scripts/verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs)<br>（クリック CSS 条件待ち） | クリック対象の CSS 条件待ち上限が `3000ms` と短く、高負荷時に条件成立前にタイムアウトするリスクがある。 | クリックの CSS 条件待ち上限を `3000ms` から `30000ms` へ延長した。既存の描画ブリッジ待ち（12 秒）と ACK 待ち（18 秒）の上限は維持している。 |
| [packages/cli/tests/cli.test.mjs](../../packages/cli/tests/cli.test.mjs) /<br>[packages/slidock/tests/project.test.mjs](../../packages/slidock/tests/project.test.mjs) | `cli.test.mjs` の `spawnSync`（20 秒）と `serve` 起動出力待ち（10 秒）、および `project.test.mjs` の `preview` 起動出力待ち（10 秒）の上限が短く、負荷時にタイムアウトするリスクがある。 | `cli.test.mjs` では `spawnSync` を 20 秒から 60 秒、`serve` 起動出力待ちを 10 秒から 60 秒へ延長し、`project.test.mjs` では `preview` 起動出力待ちを 10 秒から 60 秒へ延長した。`ready` テストには `node:test` 全体のタイムアウト 90 秒と終了時の子プロセス後始末を追加した。`project.test.mjs` の `spawnSync`（30 秒）は今回の対象外として維持し、成功時の固定待ちは追加していない。 |
| [packages/renderer-playwright/tests/renderer.test.mjs](../../packages/renderer-playwright/tests/renderer.test.mjs) | wall 上限（`5000ms`）および `node:test` 全体上限（`20000ms`）がレンダラーの設定タイムアウト（`timeoutMs` `4000ms`）に対して狭く、スケジューラ遅延時に検査が打ち切られるリスクがある。 | レンダラーの設定タイムアウト `4000ms`、実行中（`active`）・キュー待ち（`queued`）両方の要求が `timed out` エラーになる確認、およびキュー待ち要求がナビゲーションを起こさない確認を維持しつつ、wall 上限を `5000ms` から `30000ms`、`node:test` 全体を `20000ms` から `60000ms` へ延長した。無限待ちは許さず、スケジューラの余裕のみを広げている。 |
| [.github/workflows/checks.yml](../../.github/workflows/checks.yml)<br>（PostgreSQL ポート `5432` / `55461`） | 固定ポート `5432` および `55461` を使用しており、同一ホストでの並行実行時に競合するリスクがある。 | 据え置きとした。GitHub-hosted ランナーはジョブ専用の VM とサービスコンテナで動くためジョブ間のホストポート競合は起きず、publication 検証にも専用の `127.0.0.1:55461/hub_jobs` による誤接続防止があるため不要な上書きを追加しない。ローカル環境で同時起動した場合の競合は制限事項として残る。 |

## 初回対応時の設計判断

`verify-remote` の表示同期タイムアウトに対しては、通信のワイヤー形式・Rust 側の状態権威・既存の 12 秒と 18 秒のタイムアウト値を維持したまま、`deck-bridge` が 12 秒の期限内で一時的な `opacity: 0` を即エラーにせず再待機ループを継続し、`verify-remote` が ACK と新規 host error の双方を待つ方針を採用した。これにより Vue の再入場トランジションに伴う過渡的な透明状態で誤失敗せず、非表示が継続して表示へ至らない状態は `deck-bridge` 側の 12 秒の描画期限で失敗とし、検証側は失敗通知を受けた時点で 18 秒の ACK 待ちタイムアウトを待たずに検出できる。あわせて `verify` と `verify-library` の固定 sleep を実 DOM 条件や `opacity` の待機へ置き換え、常時表示設定を回避する viewport（`1440x810`）へ是正した。一方、実 registry を参照する packaged consumer 検証、タイムアウト契約テスト、否定観測用の短時間待機、および未再現のポート再 bind 競合などは、検査目的そのものを損なわないことと根拠のない延長・変更を避けることから今回は据え置いた。

## 初回対応時の未検証事項

- GitHub Actions 上での再実行、全量 `portable`、packed consumer、publication-jobs、`native` 回帰、およびクリーンコンテナ環境は未実行である。
- Rust・Tauri・WebKit、物理 2 画面構成、Windows、および外部クラウド環境は未検証であり、Chromium 上での protocol シミュレーション成功とは区別する必要がある。
- `pnpm check` でスキップされた PostgreSQL 統合テスト 9 件は成功扱いしない。
- 負荷試験は 1 CPU 制限下での `verify-remote.mjs` 3 回実行にとどまるため、CPU が CI 障害の唯一の要因であるとは断言できない。

## 追加安定化の検証（2026-11-24）

上記の 8 項目に加え、追加監査として次の 3 点にも対応しました。まず、[scripts/verify-packed-cli.mjs](../../scripts/verify-packed-cli.mjs) における `serve` 起動準備の条件待ち上限を `15000ms` から `60000ms` へ延長しています。次に、[scripts/verify-packed-framework.mjs](../../scripts/verify-packed-framework.mjs) が生成する検証用コンシューマーの `packageManager` を `pnpm@12.3.4` に固定しました。以前は `packageManager` の記載がなく、ローカル環境の shim によって別バージョンの `pnpm` が選ばれる場合があったため、CI と同じバージョンで検証できるようにしています。

さらに、リトライ挙動を手動で検証するスクリプトとして [scripts/verify-install-retries.mjs](../../scripts/verify-install-retries.mjs) を新規作成しました。このスクリプトは `npm` と `pnpm` のそれぞれに対し、固有名の最小パッケージを一時的なローカルレジストリから導入させます。メタデータ取得には最初の 3 回、tarball 取得には最初の 1 回だけ HTTP 503 を返し、メタデータ 4 回以上・tarball 2 回以上の要求で導入に成功すること、および正しいパッケージが導入されたこと（`installed.name === name`）をアサートします（実装に依存する追加の確認要求を許容しており、実測では `npm` がメタデータ 4 回・tarball 2 回、`pnpm` がメタデータ 5 回・tarball 3 回でした）。共有キャッシュを使用しつつ `npm pack` による tarball キャッシュの予熱を避けるため `tar` でテスト用パッケージを生成し、外部の `packageManager` 解決を妨げないようスコープ付きレジストリを設定しています。通常の CI には組み込まず手動検証のみに用いるため、正常時の CI 実行時間に負担を増やしません。

### 変更ファイル一覧

今回の追加安定化における作業ツリー上の変更ファイルは全 12 ファイルです。

- [.github/workflows/checks.yml](../../.github/workflows/checks.yml)
- [scripts/consumer-install.mjs](../../scripts/consumer-install.mjs)（新規）
- [scripts/verify-install-retries.mjs](../../scripts/verify-install-retries.mjs)（新規）
- [scripts/verify-packed-framework.mjs](../../scripts/verify-packed-framework.mjs)
- [scripts/verify-packed-cli.mjs](../../scripts/verify-packed-cli.mjs)
- [scripts/verify-packed-server.mjs](../../scripts/verify-packed-server.mjs)
- [apps/slidock-worker/scripts/verify-publication-jobs.mjs](../../apps/slidock-worker/scripts/verify-publication-jobs.mjs)
- [apps/slive/scripts/verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs)
- [packages/cli/tests/cli.test.mjs](../../packages/cli/tests/cli.test.mjs)
- [packages/slidock/tests/project.test.mjs](../../packages/slidock/tests/project.test.mjs)
- [packages/renderer-playwright/tests/renderer.test.mjs](../../packages/renderer-playwright/tests/renderer.test.mjs)
- [docs/results/ci-stability.md](./ci-stability.md)

### 検証表

| 検証コマンド | 結果 | 条件・補足 | ログ |
| :--- | :--- | :--- | :--- |
| `pnpm build:packages` | 終了コード `0` | パッケージビルド | [build-packages.log](../../artifacts/ci-stability-followup/build-packages.log) |
| `SLIDOCK_PACKAGES_BUILT=1 pnpm build:workers` | 終了コード `0` | ワーカービルド | [build-workers.log](../../artifacts/ci-stability-followup/build-workers.log) |
| `SLIDOCK_PACKAGES_BUILT=1 pnpm verify:packed-cli` | 終了コード `0` | packed CLI 検証 | [packed-cli.log](../../artifacts/ci-stability-followup/packed-cli.log) |
| `SLIDOCK_PACKAGES_BUILT=1 pnpm verify:packed-server` | 終了コード `0` | packed server 検証 | [packed-server.log](../../artifacts/ci-stability-followup/packed-server.log) |
| `SLIDOCK_PACKAGES_BUILT=1 pnpm verify:packed-framework` | 終了コード `0` | packed framework 検証 | [packed-framework.log](../../artifacts/ci-stability-followup/packed-framework.log) |
| `HUB_TEST_DATABASE_URL=postgres://hub:local-test-only@127.0.0.1:55461/hub_jobs node apps/slidock-worker/scripts/verify-publication-jobs.mjs` | 終了コード `0`（16 passed / 0 failed） | イメージ `postgres:17-alpine` の使い捨て専用コンテナ `slidock-ci-stability-jobs` のみを使用して実行（既存 DB は不使用、DB テストと publication 実行の終了後に `docker stop` 終了コード `0` で破棄済み） | [publication-jobs.log](../../artifacts/ci-stability-followup/publication-jobs.log) |
| `node --test packages/cli/tests/cli.test.mjs packages/slidock/tests/project.test.mjs packages/renderer-playwright/tests/renderer.test.mjs` | 終了コード `0`（27 tests / 27 pass / 0 skip） | 変更対象テストの一括実行 | [changed-tests.log](../../artifacts/ci-stability-followup/changed-tests.log) |
| `taskset -c 0 node apps/slive/scripts/verify-remote.mjs`（3 回実行） | 終了コード `0` / `0` / `0`（毎回 HTTP 33 + HTTPS 33 checks） | 単一 CPU コア固定で 3 回実行。JSON 出力も `../../artifacts/ci-stability-followup/` 配下に保存 | [remote-1.log](../../artifacts/ci-stability-followup/remote-1.log) / [remote-2.log](../../artifacts/ci-stability-followup/remote-2.log) / [remote-3.log](../../artifacts/ci-stability-followup/remote-3.log) |
| `pnpm lint` | 終了コード `0` | リント検査 | [lint.log](../../artifacts/ci-stability-followup/lint.log) |
| `pnpm format:check` | 終了コード `0` | フォーマット検査 | [format-check.log](../../artifacts/ci-stability-followup/format-check.log) |
| `node scripts/verify-install-retries.mjs` | 終了コード `0`（`npm`: メタデータ 4 回 / tarball 2 回、`pnpm`: メタデータ 5 回 / tarball 3 回） | ローカルレジストリのメタデータ HTTP 503×3・tarball HTTP 503×1 を越えて導入を確認 | [install-retries.log](../../artifacts/ci-stability-followup/install-retries.log) |
| `SLIDOCK_PACKAGES_BUILT=1 HUB_TEST_DATABASE_URL=postgres://hub:local-test-only@127.0.0.1:55461/hub WRANGLER_LOG_PATH=/home/watabegg/slidock/artifacts/ci-stability-followup/wrangler pnpm check` | 終了コード `0`（425 tests / 425 pass / 0 fail / 0 skip） | `remote` 等の終了後に PostgreSQL 専用コンテナ内 `hub` DB を使用して直列で再実行。事前の通常ビルド付き `pnpm check` も終了コード `0`（ただし network helper 変更前のため、最終コードの検証は記載の環境変数を用いたこの結果） | [check.log](../../artifacts/ci-stability-followup/check.log) |

### 失敗した試行と制限事項

作業中に発生した初回試行の失敗と、それに対する修正内容・未検証の範囲は次のとおりです。

- **`pnpm install` のリトライフラグ形式誤り**: 旧来の `fetch-retries` フラグ形式を `pnpm install` へ直接渡したことで終了コード `1` となりました。その後 `pnpm` 12 の `--config` 形式へ切り替えたところ引数自体は受理されたものの、HTTP 503 が 3 回連続する導入検証に失敗したため、最終的に `pnpm-workspace.yaml` へ設定を書き出す方式へ修正して成功しています。
- **リトライ検証用パッケージ生成によるキャッシュ予熱**: `npm pack` でテスト用パッケージを生成したところ共有キャッシュに tarball が登録され、tarball 取得の HTTP 通信が省略されてアサートに失敗しました。`tar` で直接生成する方式へ修正しています。
- **リトライ検証時のレジストリ向き先過多**: 全レジストリをローカルへ向けたため、`packageManager` による `pnpm` の取得までローカルレジストリへ向かい失敗しました。スコープ付きレジストリ設定へ修正済みです。
- **`verify-remote.mjs` 新障壁での表記差誤判定**: 初回試行で Vue Router の URL エンコード表記差（`:` と `%3A` 等）をルート変更と誤判定して終了コード `1` となりました。値を正規化して比較するよう修正した後、3 回成功しています。
- **`pnpm check` の初回失敗（終了コード `1`）**: `remote` 検証の `buildNativeUi` から呼ばれる `buildProtocol` が `dist` を削除して再生成している間に、並行実行していた `typecheck` が `@slidock/protocol/contracts` を解決できず終了コード `1` で失敗しました。初回の失敗ログは保存しておらず、`remote` 等の完了後に直列で再実行して終了コード `0`（全 425 テスト成功、スキップ 0）を確認し、[check.log](../../artifacts/ci-stability-followup/check.log) をこの再実行結果で上書きしました。この競合に対して新たな CI 修正は行わず、同一作業ツリーでの重複ビルドを避ける運用としています。
- **未検証事項・制限事項**: GitHub Actions 上での実実行、実際のキャッシュヒット率、処理速度の改善、クリーンコンテナでの全量 portable / native 検証は未実施です。リトライ検証はローカルで HTTP 503 を返す範囲の実測であり、実 npm レジストリの長期障害や DNS/TLS 障害は未検証です。また、Rust / Tauri / WebKit / Windows、物理 2 画面、実クラウド環境での検証は実施しておらず、ローカル環境で PostgreSQL の固定ポート（`5432` / `55461`）を並行利用した際のポート競合も未解消です。

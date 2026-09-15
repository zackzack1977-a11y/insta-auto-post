# Food&Bar Zack Instagram自動投稿

## 全体の流れ

1. `photos` フォルダに投稿したい写真(jpg/png)を入れる
   - **ファイル名を実際の料理名にする**(例: `蝦夷鹿のロースト.jpg`)。AIはこのファイル名を「正しい料理名」として扱い、写真から推測した食材名(牛肉など)に書き換えたりしない
   - 料理名以外にも伝えたい正確な情報(産地、こだわりなど)があれば、同じ名前の`.txt`ファイル(例: `蝦夷鹿のロースト.txt`)を同じフォルダに置くと、そちらが優先される
   - Gensparkなどで動画を事前に作ってある場合は、同じ名前の`.mp4`ファイルを`videos`フォルダに置く。動画がある写真から優先して投稿される(無い写真同士はファイル名順)。動画が無い写真が選ばれた場合、投稿は行わずLINEに見送り通知だけ送る(簡易版動画へのフォールバックは廃止済み)
2. `music` フォルダに著作権フリー(商用利用可)の音源ファイル(mp3/mp4/m4a/wav)を入れる
3. GitHubにpushする
4. 毎週月・水・金 11:00(日本時間)に自動で以下を行う
   - AIが写真を見てReels用の動画テキスト・Instagramキャプションを作成
   - Genspark動画にBGMを合成(動画が無ければ投稿せずLINEに見送り通知)
   - Instagram側に「下書き(非公開のメディアコンテナ)」だけを作成する(**この時点ではまだ誰にも公開されない**)
   - **たけしさん個人のLINEに、内容確認用の通知が届く**。キャプションを確認し、リンクをタップして「投稿する」ボタンを押すと、そこで初めてInstagramに公開される
5. リンクには約23時間の有効期限がある(Instagram側のコンテナが約24時間で失効するため)。期限切れでタップし損ねた場合、その写真は自動的に次回の実行時にまた候補に戻る(再度AIがキャプションを作り直してLINEに送られる)

## いま投稿がどうなっているか知りたいとき

`data/posted.json` に、各写真ごとの状態が記録されている。

- `confirmed: false` … LINEに提示済みだが、実際にタップして公開されたかはまだ未確認(リンクの期限内、またはタップ待ち)
- `confirmed: true` … Instagram側で実際に公開されたことを確認済み

`confirmed: false` のまま長時間放置され期限が切れた場合は、次回の自動実行時に自動でこのファイルから削除され、また候補として選ばれるようになる(手動で編集する必要はない)。

## 手動で今すぐ投稿したいとき

GitHubリポジトリの「Actions」タブ→「Instagram自動投稿」→「Run workflow」で、スケジュールを待たずに今すぐ実行できる(結果はいつも通りLINEに届く)。

## 投稿頻度やタイミングを変えたいとき

`.github/workflows/post.yml` の `cron` の行を書き換える(現在は毎週月・水・金 11:00 JST = 02:00 UTC)

## Genspark動画の「作り置き」について

動画付きの投稿を安定させるため、投稿直前ではなく事前にまとめてGenspark動画を作り溜めする仕組みが別途ある(このリポジトリの外、たけしさんのPC上のタスクスケジューラで運用)。

- 毎日10:00に、まだ動画が無く未投稿の写真を対象に `node src/list-video-candidates.js 4` で最大4件選び、Gensparkで動画生成→`videos/`フォルダに保存→pushする
- Gensparkの無料枠クレジットを使いすぎないよう、1回の実行で処理するのは最大4件まで
- 対象の写真が無くなれば(全ての未投稿写真に動画が揃えば)、その日は何もせずスキップする
- ここで作られた動画は、通常の自動投稿(`post.js`)から「事前生成済み動画」としてそのまま使われる

## 著作権フリー音楽の入手先の例

- Pixabay Music(https://pixabay.com/music/) — 商用利用可・帰属表示(クレジット表記)不要のものが多い
- Meta Sound Collection(https://www.facebook.com/sound/collection) — Facebook/Instagram投稿専用に無料利用が認められている音源(他サービスへの転用は不可)
- Free Music Archive

ダウンロードした音源ファイルを `music` フォルダに置くだけで自動的に使われる(複数入れておくとランダムに選ばれる)。BGMの長さが動画より短くても自動でループ再生されるので、短い曲でも問題ない。

## 必要なGitHub Secrets

リポジトリの Settings → Secrets and variables → Actions → New repository secret で以下を登録する

- `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`
- `LINE_CHANNEL_ACCESS_TOKEN` — LINE公式アカウントのチャンネルアクセストークン
- `LINE_USER_ID` — **たけしさん個人**のLINEユーザーID(下記「LINE_USER_IDの調べ方」参照)
- `PUBLISH_SIGNING_SECRET` — 投稿確認リンクの署名用のランダムな文字列(worker側の同名シークレットと必ず同じ値にする)
- `PUBLISH_WORKER_URL` — 下記Cloudflare Workerのデプロイ後に発行されるURL + `/publish`

## LINE_USER_IDの調べ方(初回セットアップ時のみ)

このLINE公式アカウントはお客様も友だち追加している可能性があるため、フォロワー全員のIDを調べる方法は使わず、たけしさん個人からメッセージを送ってもらってIDを確認する方式にしている。

1. LINE Developersコンソールでこのチャンネルを開き、Webhook URLに `<WorkerのURL>/line-webhook` を設定し、Webhookをオンにする
2. たけしさんが自分のLINEアプリから、このFood&Bar Zack公式アカウントに何かメッセージを送る
3. 「あなたのLINEユーザーIDです: U〜」という返信が届くので、その値をGitHub Secrets `LINE_USER_ID` に登録する
4. 登録が終わればWebhookはオフに戻してよい(オンのままでも実害はない)

## Cloudflare Worker(投稿確認・公開の受け口)

`worker/publish-worker.js` をCloudflare Workersにデプロイして使う(`cd worker && npx wrangler deploy`)。

必要な設定:

- KVネームスペース `PUBLISH_KV` を作成し、`worker/wrangler.toml` の `[[kv_namespaces]]` にバインドする(同じリンクの連打・二重送信で二重投稿しないようにするため)
- Workerシークレット(`npx wrangler secret put <名前>` で設定、値はGitHub Secretsと同じもの)
  - `INSTAGRAM_ACCESS_TOKEN`
  - `INSTAGRAM_BUSINESS_ACCOUNT_ID`
  - `PUBLISH_SIGNING_SECRET`
  - `LINE_CHANNEL_ACCESS_TOKEN`
  - `LINE_CHANNEL_SECRET`(LINE_USER_ID調査用Webhookの署名検証に使用)

## 既知の制約

- Instagramのメディアコンテナは作成からおよそ24時間で失効する。それより手前(約23時間)でこちら側からもリンクを無効化しているが、期限が近い場合は早めにLINEを確認してほしい
- 生成した動画ファイルは、Instagramが取り込むまでの一時的なホスティング先としてリポジトリに直接コミット→削除する方式を取っている。運用が長く続くとgit履歴にバイナリが蓄積していくため、リポジトリのサイズが気になってきたら履歴の整理(squash等)を検討する

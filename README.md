# Food&Bar Zack Instagram自動投稿

## 使い方

1. `photos` フォルダに投稿したい写真(jpg/png)を入れる
   - **ファイル名を実際の料理名にする**(例: `蝦夷鹿のロースト.jpg`)。AIはこのファイル名を「正しい料理名」として扱い、写真から推測した食材名(牛肉など)に書き換えたりしない
   - 料理名以外にも伝えたい正確な情報(産地、こだわりなど)があれば、同じ名前の`.txt`ファイル(例: `蝦夷鹿のロースト.txt`)を同じフォルダに置くと、そちらが優先される
2. `music` フォルダに著作権フリー(商用利用可)のmp3ファイルを入れる
3. GitHubにpushする
4. 毎週月・水・金 11:00(日本時間)に自動で以下を行う
   - AIが写真を見てReels用の動画テキスト・Instagramキャプションを作成
   - 写真をズームする動画を作成し、テキストとBGM(musicフォルダからランダム選択)を合成
   - Reelsとして投稿
5. 投稿済みの写真は `data/posted.json` に記録され、二重投稿されない

## 手動で今すぐ投稿したいとき

GitHubリポジトリの「Actions」タブ→「Instagram自動投稿」→「Run workflow」で、スケジュールを待たずに今すぐ実行できる

## 投稿頻度やタイミングを変えたいとき

`.github/workflows/post.yml` の `cron` の行を書き換える(現在は毎週月・水・金 11:00 JST = 02:00 UTC)

## 著作権フリー音楽の入手先の例

- Pixabay Music(https://pixabay.com/music/) — 商用利用可・帰属表示(クレジット表記)不要のものが多い
- YouTube Audio Library
- Free Music Archive

ダウンロードしたmp3ファイルを `music` フォルダに置くだけで自動的に使われる(複数入れておくとランダムに選ばれる)

## 必要なGitHub Secrets

リポジトリの Settings → Secrets and variables → Actions → New repository secret で以下を登録する

- `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`

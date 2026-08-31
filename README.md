# Food&Bar Zack Instagram自動投稿

## 使い方

1. `photos` フォルダに投稿したい写真(jpg/png)を入れる
2. GitHubにpushする
3. 毎週月・水・金 11:00(日本時間)に自動でAIがキャプションを作成し、1枚ずつInstagramに投稿する
4. 投稿済みの写真は `data/posted.json` に記録され、二重投稿されない

## 手動で今すぐ投稿したいとき

GitHubリポジトリの「Actions」タブ→「Instagram自動投稿」→「Run workflow」で、スケジュールを待たずに今すぐ実行できる

## 投稿頻度やタイミングを変えたいとき

`.github/workflows/post.yml` の `cron` の行を書き換える(現在は毎週月・水・金 11:00 JST = 02:00 UTC)

## 必要なGitHub Secrets

リポジトリの Settings → Secrets and variables → Actions → New repository secret で以下を登録する

- `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`

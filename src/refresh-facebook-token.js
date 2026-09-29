// システムユーザーアクセストークン(FACEBOOK_PAGE_ACCESS_TOKEN)は60日で失効するため、
// 定期的にMetaの更新APIで延長し、GitHub SecretsとCloudflare Workerのシークレットを
// 自動で書き換える。トークンの値は絶対にログに出力しない(::add-mask::で即座にマスクする)。
const { execFileSync } = require('child_process');
const path = require('path');
const { ROOT } = require('./shared');

const {
  FACEBOOK_PAGE_ACCESS_TOKEN: CURRENT_TOKEN,
  FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET,
  GH_TOKEN,
  GITHUB_REPOSITORY,
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
} = process.env;

function maskInLogs(value) {
  // GitHub Actionsのログマスク機能。以降このプロセスの出力でこの文字列が
  // 出ても "***" に置き換わる。念のための保険であり、そもそも出力しない設計にする。
  console.log(`::add-mask::${value}`);
}

async function sendLine(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: Buffer.from(JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text }] }), 'utf8'),
    });
  } catch (err) {
    console.error('LINE通知の送信に失敗しました:', err);
  }
}

async function main() {
  if (!CURRENT_TOKEN || !FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
    throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN / FACEBOOK_APP_ID / FACEBOOK_APP_SECRETが設定されていません。');
  }

  const url =
    `https://graph.facebook.com/v21.0/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(FACEBOOK_APP_ID)}` +
    `&client_secret=${encodeURIComponent(FACEBOOK_APP_SECRET)}` +
    `&set_token_expires_in_60_days=true` +
    `&fb_exchange_token=${encodeURIComponent(CURRENT_TOKEN)}`;

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    // エラー応答にトークンが含まれることは無い想定だが、念のためAPI応答は
    // ログに出さない(status_codeだけ出す)。
    throw new Error(`トークン更新APIエラー(HTTP ${res.status})`);
  }

  const newToken = json.access_token;
  maskInLogs(newToken);

  // GitHub Secretsを更新(gh CLIはstdinから値を読めるので、CLI引数やログに値を出さない)
  execFileSync('gh', ['secret', 'set', 'FACEBOOK_PAGE_ACCESS_TOKEN', '--repo', GITHUB_REPOSITORY], {
    input: newToken,
    env: { ...process.env, GH_TOKEN },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('GitHub SecretsのFACEBOOK_PAGE_ACCESS_TOKENを更新しました。');

  // Cloudflare Workerのシークレットも更新
  if (CLOUDFLARE_API_TOKEN) {
    execFileSync('npx', ['wrangler', 'secret', 'put', 'FACEBOOK_PAGE_ACCESS_TOKEN'], {
      cwd: path.join(ROOT, 'worker'),
      input: newToken,
      env: { ...process.env, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID },
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log('Cloudflare WorkerのFACEBOOK_PAGE_ACCESS_TOKENを更新しました。');
  } else {
    console.warn('CLOUDFLARE_API_TOKEN未設定のため、Worker側のシークレット更新はスキップしました。');
  }

  const expiresInDays = json.expires_in ? Math.round(json.expires_in / 86400) : '約60';
  await sendLine(`【Facebookトークン自動更新】成功しました。次回の有効期限まで約${expiresInDays}日です。`);
}

main().catch(async (err) => {
  console.error(err);
  await sendLine(`【Facebookトークン自動更新】失敗しました。手動での確認・更新が必要です。\n${String(err && err.message ? err.message : err).slice(0, 500)}`);
  process.exit(1);
});

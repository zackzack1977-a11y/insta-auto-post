// 新しい項目(AIラベル is_ai_generated、表紙 thumb_offset)が、Instagramに受け付けられるかを確かめる。
// 下書き(コンテナ)を作って、準備完了になるまで待つだけ。公開(media_publish)は絶対にしない。
// 下書きは約24時間で自然に消える。posted.jsonにも記録しない。
// 使い方: VIDEO_URL=<公開されている動画のURL> node src/test-container.js
const { INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ACCESS_TOKEN, VIDEO_URL, THUMB_OFFSET } = process.env;

async function main() {
  if (!VIDEO_URL) throw new Error('VIDEO_URLを指定してください');
  const res = await fetch(`https://graph.facebook.com/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      video_url: VIDEO_URL,
      caption: '(テスト用の下書き。公開しません)',
      is_ai_generated: true,
      thumb_offset: Number(THUMB_OFFSET || 3000),
      access_token: FACEBOOK_PAGE_ACCESS_TOKEN,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.log('結果: 受け付けられませんでした HTTP ' + res.status + ' ' + JSON.stringify(json));
    process.exit(1);
  }
  console.log('下書きを作りました(公開はしません)。状態を待ちます…');
  for (let i = 0; i < 60; i += 1) {
    const s = await (await fetch(`https://graph.facebook.com/v21.0/${json.id}?fields=status_code,status&access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`)).json();
    if (s.status_code && s.status_code !== 'IN_PROGRESS') {
      console.log('結果: ' + s.status_code + (s.status ? ' / ' + s.status : ''));
      process.exit(s.status_code === 'FINISHED' ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  console.log('結果: 10分たっても準備が終わりませんでした');
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

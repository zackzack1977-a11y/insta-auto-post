// LINEが送れなかったときの逃げ道(公開リンクを Worker に預ける → パソコンが業務ナビに出す)の通し試験(2026-11-25)。
// 存在しない投稿ID(test-...)で、署名つきの材料を Worker の /stash に預けるだけ。投稿・公開は何もしない。
// (このリンクで「投稿する」を押しても、IDが存在しないのでエラーで終わる)
const crypto = require('crypto');

(async () => {
  const { PUBLISH_SIGNING_SECRET, PUBLISH_WORKER_URL } = process.env;
  if (!PUBLISH_SIGNING_SECRET || !PUBLISH_WORKER_URL) throw new Error('PUBLISH_SIGNING_SECRET / PUBLISH_WORKER_URL がありません');
  const id = `test-${Date.now()}`;
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', PUBLISH_SIGNING_SECRET).update(`${id}.${ts}`).digest('hex');
  const res = await fetch(PUBLISH_WORKER_URL.replace(/\/publish\/?$/, '/stash'), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({ id, ts, sig, dish: '【試験】逃げ道の確認(投稿はされません)', videoUrl: 'https://example.com/test.mp4', lineOk: false }), 'utf8'),
  });
  console.log(`預け入れ: HTTP ${res.status} ${await res.text()}(試験のID: ${id})`);
  // 署名の違う材料は断られることも確かめる
  const bad = await fetch(PUBLISH_WORKER_URL.replace(/\/publish\/?$/, '/stash'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ts, sig: '0'.repeat(64) }),
  });
  console.log(`署名の違う材料: HTTP ${bad.status}(403なら正しい)`);
  if (!res.ok || bad.status !== 403) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

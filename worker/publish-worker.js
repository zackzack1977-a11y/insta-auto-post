// Cloudflare Worker: LINEに届く「投稿する」リンクをタップした時だけ、
// Instagramの下書き(メディアコンテナ)を実際に公開する受け口。
//
// 必要なWorkerシークレット(wrangler secret putで設定):
//   INSTAGRAM_ACCESS_TOKEN          … insta-auto-postのGitHub Secretsと同じ値
//   INSTAGRAM_BUSINESS_ACCOUNT_ID   … insta-auto-postのGitHub Secretsと同じ値
//   PUBLISH_SIGNING_SECRET          … insta-auto-postのGitHub Secretsと同じ値(署名検証用)
//
// デプロイ後、発行されるURL(例: https://xxx.workers.dev)を
// insta-auto-postリポジトリのGitHub Secrets「PUBLISH_WORKER_URL」に
// "https://xxx.workers.dev/publish" の形で登録する。

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/publish') {
      return new Response('Not Found', { status: 404 });
    }

    const id = url.searchParams.get('id');
    const sig = url.searchParams.get('sig');
    if (!id || !sig) {
      return html('リンクの形式が正しくありません。', 400);
    }

    const expected = await hmacHex(env.PUBLISH_SIGNING_SECRET, id);
    if (!timingSafeEqual(expected, sig)) {
      return html('このリンクは無効です(署名が一致しません)。', 403);
    }

    const res = await fetch(
      `https://graph.instagram.com/v21.0/${env.INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish?creation_id=${encodeURIComponent(id)}&access_token=${encodeURIComponent(env.INSTAGRAM_ACCESS_TOKEN)}`,
      { method: 'POST' }
    );
    const json = await res.json();

    if (!res.ok) {
      return html(`投稿に失敗しました。<br><small>${escapeHtml(JSON.stringify(json))}</small>`, 500);
    }
    return html('Instagramに投稿しました!');
  },
};

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function html(message, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="font-family:sans-serif;padding:2em;text-align:center;">${message}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

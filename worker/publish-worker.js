// Cloudflare Worker: LINEに届く「投稿する」リンクをタップした時だけ、
// Instagramの下書き(メディアコンテナ)を実際に公開する受け口。
// あわせて、たけしさん個人のLINEユーザーIDを調べるための一時的な
// Webhookエンドポイント(/line-webhook)も持つ(下記参照)。
//
// 重要な設計変更(2026-09-11): 以前はGETリクエストだけで即座に公開処理を実行していたが、
// LINEアプリ自身がメッセージ内のURLのプレビュー(サムネイル)を生成するために裏側で
// そのURLへ自動アクセスすることがあり、それだけで意図せず投稿が公開されてしまう事故が発生した。
// そのため、GETでは「確認画面(投稿するボタン)」だけを返し、実際の公開処理は
// そのボタンを押して送信されるPOSTリクエストの時にのみ実行するよう変更した。
// プレビュー生成のクローラーは通常GETのみを行いフォーム送信は行わないため、この方式で防止できる。
//
// 重要な設計変更(2026-09-14):
// 1) リンクに発行時刻(ts)を含めて署名し、一定時間(下のLINK_EXPIRY_MS)を過ぎた
//    リンクは無効にする。Instagramのメディアコンテナ自体が約24時間で失効するため、
//    それより手前でこちらから分かりやすく「期限切れ」と案内する。
// 2) KV(PUBLISH_KV)にcreation_idの処理状態を記録し、同じリンクを連打・再送信しても
//    media_publishが複数回走らないようにする(すでに公開済みなら即座にその旨を返す)。
// 3) media_publish呼び出し後のres.json()を必ずtry/catchし、HTTPレベルでは成功しているのに
//    JSON解析だけ失敗して「失敗」と誤表示 → 再タップで二重投稿、という事故を防ぐ
//    (res.okがtrueならJSON解析に失敗しても「成功」として扱う)。
//
// 必要なWorkerシークレット(wrangler secret putで設定):
//   FACEBOOK_PAGE_ACCESS_TOKEN      … insta-auto-postのGitHub Secretsと同じ値(位置情報タグ対応のため2026-09-28にINSTAGRAM_ACCESS_TOKENから切り替え)
//   INSTAGRAM_BUSINESS_ACCOUNT_ID   … insta-auto-postのGitHub Secretsと同じ値
//   PUBLISH_SIGNING_SECRET          … insta-auto-postのGitHub Secretsと同じ値(署名検証用)
//   LINE_CHANNEL_ACCESS_TOKEN       … LINE公式アカウントのチャンネルアクセストークン(/line-webhook用)
//   LINE_CHANNEL_SECRET             … LINE公式アカウントのチャンネルシークレット(署名検証用)
// 必要なKVバインディング(wrangler.tomlの[[kv_namespaces]]で設定): PUBLISH_KV
//
// デプロイ後、発行されるURL(例: https://xxx.workers.dev)を
// insta-auto-postリポジトリのGitHub Secrets「PUBLISH_WORKER_URL」に
// "https://xxx.workers.dev/publish" の形で登録する。
//
// --- /line-webhook について ---
// post.jsからのLINE通知は「たけしさん個人」宛のpushメッセージにする必要があるが、
// そのためには「たけしさんのLINEユーザーID」を一度だけ調べる必要がある
// (このLINE公式アカウントはお客様も友だち追加している可能性があるため、
//  全フォロワーID一覧を取得する方法は使わない)。
// 手順:
//   1. LINE Developersコンソールで、このWorkerのURL + "/line-webhook" を
//      Webhook URLに設定し、Webhookの利用をオンにする。
//   2. たけしさんが自分のLINEアプリからこの公式アカウントに何かメッセージを送る。
//   3. Botから「あなたのLINEユーザーIDです: Uxxxxxxxx...」という返信が届くので、
//      その値をGitHub Secrets「LINE_USER_ID」に登録する。
//   4. (任意)登録が終わればWebhook設定はオフに戻してよい。

const LINK_EXPIRY_MS = 23 * 60 * 60 * 1000; // post.js側の同名の定数と必ず一致させること

// 予約公開(2026-11-20、たけしさんの決定): 「投稿する」を押しても、すぐには公開せず、
// その日の夕方5時(日本時間)に公開する。オーパスの調査で、来店につながる時間として選んだ。
// 5時を過ぎてから押した場合や、5時まで待つと下書き(24時間で失効)の期限に近い場合は、すぐ公開する。
// 予約はKVの「sched:<creation_id>」に入れ、wrangler.tomlのcron(UTC 8:00〜8:50に10分おき)で公開する。
const PUBLISH_HOUR_JST = 17;
const SCHEDULE_SAFETY_MS = 22 * 60 * 60 * 1000; // 下書きを作ってから22時間を超える予約はしない

function scheduledTimeFor(ts) {
  const now = Date.now();
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const target = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), PUBLISH_HOUR_JST - 9, 0, 0);
  if (now >= target) return null; // もう5時を過ぎた → すぐ公開
  if (target - Number(ts) > SCHEDULE_SAFETY_MS) return null; // 5時まで待つと期限が近い → すぐ公開
  return target;
}

function schedKey(id) {
  return `sched:${id}`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.cron));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/line-webhook' && request.method === 'POST') {
      return handleLineWebhook(request, env);
    }

    if (url.pathname !== '/publish') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method === 'GET') {
      return handleConfirmPage(url, env);
    }

    if (request.method === 'POST') {
      return handlePublish(request, env);
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

async function verifyPublishToken(env, id, ts, sig) {
  if (!id || !ts || !sig) return { ok: false, reason: 'missing' };
  const expected = await hmacHex(env.PUBLISH_SIGNING_SECRET, `${id}.${ts}`);
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: 'signature' };
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > LINK_EXPIRY_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
}

function kvKey(id) {
  return `pub:${id}`;
}

async function handleConfirmPage(url, env) {
  const id = url.searchParams.get('id');
  const ts = url.searchParams.get('ts');
  const sig = url.searchParams.get('sig');
  const check = await verifyPublishToken(env, id, ts, sig);
  if (!check.ok) {
    if (check.reason === 'expired') {
      return html('このリンクは有効期限切れです。この写真は次回の自動実行時に投稿候補へ自動的に戻ります。', 403);
    }
    return html('このリンクの形式が正しくないか、無効です。', 400);
  }

  if (env.PUBLISH_KV) {
    const state = await env.PUBLISH_KV.get(kvKey(id));
    if (state === 'published') {
      return html('この投稿はすでに公開済みです。');
    }
    if (state === 'scheduled') {
      return html('この投稿は予約済みです。今日の夕方5時に自動で公開されます。');
    }
  }

  const willSchedule = scheduledTimeFor(ts) !== null;
  // ここではまだ何も公開しない。確認ボタン付きのページを返すだけ。
  return html(
    `<p>${willSchedule ? 'この内容を、今日の夕方5時にInstagramへ予約で投稿します。よろしいですか?' : 'この内容をInstagramに投稿します(今すぐ公開されます)。よろしいですか?'}</p>
     <form method="POST" action="/publish">
       <input type="hidden" name="id" value="${escapeHtml(id)}">
       <input type="hidden" name="ts" value="${escapeHtml(ts)}">
       <input type="hidden" name="sig" value="${escapeHtml(sig)}">
       <button type="submit" style="font-size:1.2em;padding:0.8em 2em;background:#3897f0;color:#fff;border:none;border-radius:8px;">投稿する</button>
     </form>`
  );
}

async function handlePublish(request, env) {
  const form = await request.formData();
  const id = form.get('id');
  const ts = form.get('ts');
  const sig = form.get('sig');
  const check = await verifyPublishToken(env, id, ts, sig);
  if (!check.ok) {
    if (check.reason === 'expired') {
      return html('このリンクは有効期限切れです。この写真は次回の自動実行時に投稿候補へ自動的に戻ります。', 403);
    }
    return html('このリンクの形式が正しくないか、無効です。', 400);
  }

  const key = kvKey(id);
  if (env.PUBLISH_KV) {
    const state = await env.PUBLISH_KV.get(key);
    if (state === 'published') {
      return html('この投稿はすでに公開済みです(重複タップ防止)。');
    }
    if (state === 'scheduled') {
      return html('この投稿は予約済みです。今日の夕方5時に自動で公開されます。');
    }
    if (state === 'processing') {
      return html('いま公開の処理中です。少し待ってから、Instagramで確かめてください。');
    }

    const at = scheduledTimeFor(ts);
    if (at !== null) {
      await env.PUBLISH_KV.put(schedKey(id), JSON.stringify({ at }), { expirationTtl: 60 * 60 * 24 * 2 });
      await env.PUBLISH_KV.put(key, 'scheduled', { expirationTtl: 60 * 60 * 24 * 2 });
      return html('予約しました。今日の夕方5時に、自動でInstagramに公開されます。公開されたらLINEでお知らせが届きます。');
    }
  }

  const result = await publishNow(env, id);
  if (result.ok) {
    if (result.parseFailed) {
      return html('Instagramに投稿しました(応答の詳細は取得できませんでしたが、リクエスト自体は成功しています)。');
    }
    return html('Instagramに投稿しました!');
  }
  if (result.network) {
    return html(`通信エラーで投稿に失敗しました。もう一度お試しください。<br><small>${escapeHtml(result.detail)}</small>`, 502);
  }
  return html(
    `投稿に失敗しました。このリンクはそのまま再度お試しいただけます。長時間経過して無効になった場合、この写真は次回の自動実行時に候補へ自動的に戻ります。<br><small>${escapeHtml(result.detail)}</small>`,
    500
  );
}

// 予約の公開(cronから呼ばれる)。時刻が来た予約を公開する。最後の回(UTC 8:50)でも失敗したら、
// 予約を外して、たけしさんがリンクをもう一度押せばすぐ公開できる状態に戻す。
async function runScheduled(env, cron) {
  if (!env.PUBLISH_KV) return;
  const lastTry = new Date().getUTCMinutes() >= 50;
  const list = await env.PUBLISH_KV.list({ prefix: 'sched:' });
  for (const k of list.keys) {
    const id = k.name.slice('sched:'.length);
    let at = 0;
    try {
      at = JSON.parse((await env.PUBLISH_KV.get(k.name)) || '{}').at || 0;
    } catch {}
    if (Date.now() < at) continue;
    await env.PUBLISH_KV.put(kvKey(id), 'processing', { expirationTtl: 300 });
    const result = await publishNow(env, id);
    console.log(`[scheduled] ${id}: ${result.ok ? '公開した' : '失敗 ' + result.detail}`);
    if (result.ok || lastTry) await env.PUBLISH_KV.delete(k.name);
    if (!result.ok && !lastTry) await env.PUBLISH_KV.put(kvKey(id), 'scheduled', { expirationTtl: 60 * 60 * 24 * 2 });
  }
}

// 実際に公開する。KVの状態(published/ロック解除)もここで更新する。
async function publishNow(env, id) {
  const key = kvKey(id);
  if (env.PUBLISH_KV) await env.PUBLISH_KV.put(key, 'processing', { expirationTtl: 300 });

  let res;
  try {
    res = await fetch(
      `https://graph.facebook.com/v21.0/${env.INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish?creation_id=${encodeURIComponent(id)}&access_token=${encodeURIComponent(env.FACEBOOK_PAGE_ACCESS_TOKEN)}`,
      { method: 'POST' }
    );
  } catch (err) {
    if (env.PUBLISH_KV) await env.PUBLISH_KV.delete(key);
    return { ok: false, network: true, detail: String(err) };
  }

  let json = null;
  let parseFailed = false;
  try {
    json = await res.json();
  } catch {
    parseFailed = true;
  }

  if (res.ok) {
    // HTTPレベルでは成功。JSON解析にだけ失敗しても、Instagram側では投稿処理が
    // 成功している可能性が高いため、ここを「失敗」と表示して再タップを誘発しない。
    if (env.PUBLISH_KV) await env.PUBLISH_KV.put(key, 'published', { expirationTtl: 60 * 60 * 24 * 30 });
    return { ok: true, parseFailed };
  }

  // 明確な失敗。ロックを解除し、必要なら同じリンクで再試行できるようにする。
  if (env.PUBLISH_KV) await env.PUBLISH_KV.delete(key);
  return { ok: false, detail: json ? JSON.stringify(json) : `HTTP ${res.status}` };
}

// --- LINEユーザーID調べ用の一時的なWebhook ---
async function handleLineWebhook(request, env) {
  console.log('[line-webhook] リクエスト受信');
  const bodyText = await request.text();
  const signature = request.headers.get('x-line-signature');
  if (!env.LINE_CHANNEL_SECRET || !signature) {
    console.log('[line-webhook] 400: LINE_CHANNEL_SECRET未設定 または x-line-signatureヘッダ無し', {
      hasSecret: !!env.LINE_CHANNEL_SECRET,
      hasSignatureHeader: !!signature,
    });
    return new Response('Bad Request', { status: 400 });
  }
  const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, bodyText, signature);
  if (!valid) {
    console.log('[line-webhook] 403: 署名検証に失敗');
    return new Response('Forbidden', { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    console.log('[line-webhook] 400: JSON解析失敗', bodyText.slice(0, 300));
    return new Response('Bad Request', { status: 400 });
  }

  const events = payload.events || [];
  console.log(`[line-webhook] 署名OK、イベント数: ${events.length}`, JSON.stringify(payload).slice(0, 500));
  for (const event of events) {
    if (event.type === 'message' && event.replyToken && event.source && event.source.userId) {
      const userId = event.source.userId;
      const replyRes = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [
            {
              type: 'text',
              text:
                `あなたのLINEユーザーIDです:\n${userId}\n\n` +
                'この値をGitHubリポジトリのSecrets「LINE_USER_ID」に登録してください。',
            },
          ],
        }),
      });
      const replyText = await replyRes.text().catch(() => '(本文取得失敗)');
      console.log(`[line-webhook] reply API結果: status=${replyRes.status}`, replyText.slice(0, 300));
    } else {
      console.log('[line-webhook] message以外のイベントのためスキップ:', event.type);
    }
  }

  return new Response('OK', { status: 200 });
}

async function verifyLineSignature(channelSecret, bodyText, signatureHeaderB64) {
  if (!signatureHeaderB64) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(bodyText));
  const expectedB64 = arrayBufferToBase64(sigBuf);
  return timingSafeEqual(expectedB64, signatureHeaderB64);
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

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
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

// 共同投稿の状態を調べる(見るだけ。承認・辞退はしない)。
// - 届いている招待(まだ承認していないもの): GET /{ig-user-id}/collaboration_invites
// - 承認済みで、共同投稿者として載っている投稿: GET /{ig-user-id}/collaborative_media
// このリポジトリは公開で、実行の記録は誰でも見られるため、相手のアカウント名は頭の2文字だけ出す。
const { INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ACCESS_TOKEN } = process.env;
const BASE = 'https://graph.facebook.com/v21.0';

function mask(name) {
  return name ? String(name).slice(0, 2) + '***' : '(不明)';
}

async function getAll(url, max = 100) {
  const items = [];
  let next = url;
  while (next && items.length < max) {
    const res = await fetch(next);
    const json = await res.json();
    if (!res.ok) return { error: json, items };
    items.push(...(json.data || []));
    next = json.paging && json.paging.next;
  }
  return { items };
}

async function main() {
  const token = `access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`;

  const invites = await getAll(`${BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/collaboration_invites?limit=50&${token}`);
  if (invites.error) {
    console.log('招待の一覧: 取れませんでした ' + JSON.stringify(invites.error));
  } else {
    console.log(`招待の一覧(未承認): ${invites.items.length}件`);
    invites.items.forEach((x, i) => console.log(`  ${i + 1}. 相手 ${mask(x.media_owner_username)}`));
  }

  const collab = await getAll(`${BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/collaborative_media?fields=id,timestamp,username,media_type&limit=50&${token}`);
  if (collab.error) {
    console.log('承認済みの共同投稿: 取れませんでした ' + JSON.stringify(collab.error));
  } else {
    console.log(`承認済みの共同投稿: ${collab.items.length}件`);
    collab.items.forEach((x, i) => console.log(`  ${i + 1}. ${x.timestamp || ''} 相手 ${mask(x.username)} ${x.media_type || ''}`));
  }

  // 他の人の投稿で、お店がタグ付けされたもの(写真の中のタグ)。共同投稿ではなくタグだけで済まされているかを見る。
  const tags = await getAll(`${BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/tags?fields=id,timestamp,username,media_type&limit=50&${token}`, 200);
  if (tags.error) {
    console.log('タグ付けされた投稿: 取れませんでした ' + JSON.stringify(tags.error));
  } else {
    console.log(`タグ付けされた投稿: ${tags.items.length}件`);
    tags.items.forEach((x, i) => console.log(`  ${i + 1}. ${x.timestamp || ''} 相手 ${mask(x.username)} ${x.media_type || ''}`));
  }

  // キャプションで @food_bar_zack と書かれた投稿は、Webhookでしか一覧を取れないので、ここでは見ない。
}
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

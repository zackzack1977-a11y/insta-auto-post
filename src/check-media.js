// 診断用: 指定したメディアIDに、実際に位置情報タグ(location)が
// 付いているかをInstagram Graph API経由で確認する。
// トークンはGitHub Secrets(本番と同じ)から読むが、結果(location/caption等)は
// 機密情報ではないためログにそのまま出力してよい。
const { FACEBOOK_PAGE_ACCESS_TOKEN, MEDIA_ID } = process.env;

async function main() {
  if (!MEDIA_ID) {
    throw new Error('MEDIA_IDが指定されていません。');
  }
  const fields = process.env.FIELDS || 'id,location';
  // 単体ノードへの直接GETだとlocation/permalink等のフィールドが
  // 「存在しない」と拒否されることがあるため、IGユーザーの投稿一覧
  // エッジ経由で取得できるようにする(LIST=1で切り替え)。
  const url = process.env.LIST === '1'
    ? `https://graph.facebook.com/v21.0/${MEDIA_ID}/media?fields=${fields}&access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`
    : `https://graph.facebook.com/v21.0/${MEDIA_ID}?fields=${fields}&access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log('HTTPステータス:', res.status);
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

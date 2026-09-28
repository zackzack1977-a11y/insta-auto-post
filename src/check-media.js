// 診断用: 指定したメディアIDに、実際に位置情報タグ(location)が
// 付いているかをInstagram Graph API経由で確認する。
// トークンはGitHub Secrets(本番と同じ)から読むが、結果(location/caption等)は
// 機密情報ではないためログにそのまま出力してよい。
const { INSTAGRAM_ACCESS_TOKEN, MEDIA_ID } = process.env;

async function main() {
  if (!MEDIA_ID) {
    throw new Error('MEDIA_IDが指定されていません。');
  }
  const url = `https://graph.instagram.com/v21.0/${MEDIA_ID}?fields=id,caption,permalink,location,media_type&access_token=${INSTAGRAM_ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  console.log('HTTPステータス:', res.status);
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');

const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const POSTED_LOG = path.join(__dirname, '..', 'data', 'posted.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const {
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  INSTAGRAM_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
} = process.env;

function loadPostedList() {
  if (!fs.existsSync(POSTED_LOG)) return [];
  return JSON.parse(fs.readFileSync(POSTED_LOG, 'utf8'));
}

function savePostedList(list) {
  fs.mkdirSync(path.dirname(POSTED_LOG), { recursive: true });
  fs.writeFileSync(POSTED_LOG, JSON.stringify(list, null, 2));
}

function pickNextPhoto() {
  const posted = new Set(loadPostedList());
  const candidates = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(PHOTOS_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  return candidates[0]?.name ?? null;
}

async function generateCaption(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const prompt = `あなたは静岡県富士市にあるダイニングバー「Food&Bar Zack」のSNS担当者です。

店舗情報:
- 住所: 静岡県富士市本市場町919
- 最寄り駅: 富士駅から徒歩10分、新富士駅から徒歩15分
- ジャンル: ダイニングバー(フレンチ・イタリアンをベースに、刺身や生ガキなど多国籍な料理も提供)

添付の写真を見て、Instagram投稿用の日本語キャプションを作成してください。

条件:
- 写真に写っている料理や雰囲気を魅力的に表現する
- 親しみやすく、来店したくなるトーンにする
- 3〜5行程度の本文の後に、空行を挟んでハッシュタグを15〜20個つける
- ハッシュタグは集客に効果的なものを意識する(地域名+グルメ系、ジャンル系、汎用の飲食系、店名などをバランスよく)
- 出力はキャプション本文とハッシュタグのみ。前置きや説明文は書かない`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error: ${JSON.stringify(json)}`);
  }
  return json.content[0].text.trim();
}

async function postToInstagram(imageUrl, caption) {
  const base = `https://graph.instagram.com/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}`;

  const createRes = await fetch(`${base}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Instagramメディア作成エラー: ${JSON.stringify(createJson)}`);
  }

  const publishRes = await fetch(`${base}/media_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      creation_id: createJson.id,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(`Instagram公開エラー: ${JSON.stringify(publishJson)}`);
  }
  return publishJson;
}

async function main() {
  const photo = pickNextPhoto();
  if (!photo) {
    console.log('投稿できる新しい写真がありません。photosフォルダに写真を追加してください。');
    return;
  }

  console.log(`投稿対象: ${photo}`);
  const imagePath = path.join(PHOTOS_DIR, photo);

  const caption = await generateCaption(imagePath);
  console.log('生成されたキャプション:\n' + caption);

  const branch = GITHUB_REF_NAME || 'main';
  const imageUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${branch}/photos/${encodeURIComponent(photo)}`;

  await postToInstagram(imageUrl, caption);
  console.log('投稿完了しました。');

  const posted = loadPostedList();
  posted.push(photo);
  savePostedList(posted);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const MUSIC_DIR = path.join(ROOT, 'music');
const GENERATED_DIR = path.join(ROOT, 'generated');
const POSTED_LOG = path.join(ROOT, 'data', 'posted.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_SECONDS = 10;

const {
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  INSTAGRAM_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
} = process.env;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

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

function dishNameFromFilename(filename) {
  let name = path.parse(filename).name;
  name = name.replace(/\s*-\s*コピー(\s*\(\d+\))?\s*$/i, '');
  name = name.replace(/\s*\(\d+\)\s*$/, '');
  name = name.replace(/\s*[_-]\s*\d+\s*$/, '');
  return name.trim();
}

function pickRandomMusic() {
  const files = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter((f) => f.toLowerCase().endsWith('.mp3'))
    : [];
  if (files.length === 0) {
    throw new Error('musicフォルダに著作権フリーのmp3ファイルを入れてください。');
  }
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function generateCaptionAndOverlay(imagePath, dishNote) {
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const dishNoteBlock = dishNote
    ? `\nこの料理の正式名称・情報(必ずこれを正としてキャッチコピー・本文に使い、これと矛盾する食材名・肉の種類・産地などを書かないこと): ${dishNote}\n`
    : '';

  const prompt = `あなたは静岡県富士市にあるダイニングバー「Food&Bar Zack」のSNS担当者です。

店舗情報:
- 住所: 静岡県富士市本市場町919
- 最寄り駅: 富士駅から徒歩10分、新富士駅から徒歩15分
- ジャンル: ダイニングバー(フレンチ・イタリアンをベースに、刺身や生ガキなど多国籍な料理も提供)
${dishNoteBlock}
添付の写真を見て、Instagram Reels投稿用のテキストを2種類作成してください。

重要な注意:
- 上記に料理の正式名称がある場合、写真の見た目から違う食材(例: 実際は鹿肉なのに牛肉と書く)を憶測で書かないこと。名称に含まれる食材名をそのまま使うこと
- 品種名・産地・「和牛」「A5」など、正式名称にも写真からも確認できない具体的な食材情報は、憶測で書かないこと
- 料理の正式名称が無い場合は、食材や部位を断定せず、見た目の魅力(色合い、質感、雰囲気)を中心に表現すること

出力は以下の形式で、この通りに出力してください(前置き・説明文は禁止):

OVERLAY:
(動画に焼き込む8〜14文字程度のキャッチコピー。絵文字は使わない)

CAPTION:
(Instagram投稿用の本文3〜5行。その後に空行を挟んでハッシュタグを15〜20個。集客に効果的な地域名+グルメ系、ジャンル系、汎用の飲食系、店名などをバランスよく)

必ずOVERLAYとCAPTIONを1つずつだけ出力すること。複数の案・パターンを提示したり、「パターン2」のような代替案を追加したりしないこと。`;

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
  const text = json.content[0].text.trim();

  const overlayMatch = text.match(/OVERLAY:\s*([\s\S]*?)\n\s*CAPTION:/i);
  const captionMatch = text.match(/CAPTION:\s*([\s\S]*?)(?:\n\s*(?:-{2,}|OVERLAY:|パターン)|$)/i);
  if (!overlayMatch || !captionMatch) {
    throw new Error(`AIの出力形式が想定と違います:\n${text}`);
  }
  return {
    overlayText: overlayMatch[1].trim(),
    caption: captionMatch[1].trim(),
  };
}

function findJapaneseFont() {
  const fontPath = execFileSync('fc-match', [':lang=ja', '-f', '%{file}']).toString().trim();
  if (!fontPath) {
    throw new Error('日本語フォントが見つかりません。fonts-noto-cjkをインストールしてください。');
  }
  return fontPath;
}

function buildVideo(imagePath, overlayText, musicPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const textFile = outputPath + '.overlay.txt';
  fs.writeFileSync(textFile, overlayText, 'utf8');

  const fontFile = findJapaneseFont();
  const fps = 30;
  const totalFrames = VIDEO_SECONDS * fps;
  const zoomPerFrame = (0.2 / totalFrames).toFixed(6);

  const zoompan = `zoompan=z='min(zoom+${zoomPerFrame},1.2)':d=1:s=1080x1920:fps=${fps}`;
  const drawtext = [
    `drawtext=textfile='${textFile.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
    `fontfile='${fontFile.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
    'fontsize=54',
    'fontcolor=white',
    'borderw=3',
    'bordercolor=black@0.7',
    'shadowcolor=black@0.4',
    'shadowx=2',
    'shadowy=2',
    'x=(w-text_w)/2',
    'y=h-300',
  ].join(':');

  const filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${zoompan},${drawtext}[v]`;

  execFileSync('ffmpeg', [
    '-y',
    '-loop', '1',
    '-framerate', String(fps),
    '-i', imagePath,
    '-i', musicPath,
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', '1:a',
    '-t', String(VIDEO_SECONDS),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-af', 'afade=t=out:st=' + (VIDEO_SECONDS - 1) + ':d=1',
    '-shortest',
    outputPath,
  ], { stdio: 'inherit' });

  fs.rmSync(textFile);
}

async function waitUntilMediaReady(creationId, attempts = 30, intervalMs = 10000) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${creationId}?fields=status_code&access_token=${INSTAGRAM_ACCESS_TOKEN}`
    );
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`メディア状態確認エラー: ${JSON.stringify(json)}`);
    }
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR') {
      throw new Error('Instagram側でメディアの処理に失敗しました');
    }
    await sleep(intervalMs);
  }
  throw new Error('メディアの準備がタイムアウトしました');
}

async function postReelToInstagram(videoUrl, caption) {
  const base = `https://graph.instagram.com/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}`;

  const createRes = await fetch(`${base}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Instagramメディア作成エラー: ${JSON.stringify(createJson)}`);
  }

  await waitUntilMediaReady(createJson.id);

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

  const noteFile = path.join(PHOTOS_DIR, path.parse(photo).name + '.txt');
  const noteText = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8').trim() : null;
  const dishName = dishNameFromFilename(photo);
  const dishNote = noteText || (dishName ? `料理名: ${dishName}` : null);
  console.log('料理情報として使用: ' + (dishNote ?? '(なし)'));

  const { overlayText, caption } = await generateCaptionAndOverlay(imagePath, dishNote);
  console.log('動画テキスト: ' + overlayText);
  console.log('生成されたキャプション:\n' + caption);

  const musicPath = pickRandomMusic();
  console.log('使用するBGM: ' + path.basename(musicPath));

  const videoName = path.parse(photo).name + '.mp4';
  const videoPath = path.join(GENERATED_DIR, videoName);
  buildVideo(imagePath, overlayText, musicPath, videoPath);
  console.log('動画を生成しました: ' + videoPath);

  git(['config', 'user.name', 'insta-auto-post-bot']);
  git(['config', 'user.email', 'actions@github.com']);
  git(['add', path.relative(ROOT, videoPath)]);
  git(['commit', '-m', `動画を生成: ${videoName}`]);
  git(['push']);

  const branch = GITHUB_REF_NAME || 'master';
  const videoUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${branch}/generated/${encodeURIComponent(videoName)}`;

  await postReelToInstagram(videoUrl, caption);
  console.log('投稿完了しました。');

  const posted = loadPostedList();
  posted.push(photo);
  savePostedList(posted);

  fs.rmSync(videoPath);
  git(['add', '-A']);
  git(['commit', '-m', '投稿履歴を更新・生成ファイルを削除']);
  git(['push']);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

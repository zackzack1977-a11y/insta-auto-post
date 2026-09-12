const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const MUSIC_DIR = path.join(ROOT, 'music');
const GENERATED_DIR = path.join(ROOT, 'generated');
const PREMADE_VIDEOS_DIR = path.join(ROOT, 'videos');
const POSTED_LOG = path.join(ROOT, 'data', 'posted.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_SECONDS = 15;

const {
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  INSTAGRAM_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
  LINE_CHANNEL_ACCESS_TOKEN,
  PUBLISH_SIGNING_SECRET,
  PUBLISH_WORKER_URL,
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

function hasPremadeVideo(photoFilename) {
  const videoName = path.parse(photoFilename).name + '.mp4';
  return fs.existsSync(path.join(PREMADE_VIDEOS_DIR, videoName));
}

function pickNextPhoto() {
  // GitHub Actions上のチェックアウトではファイルの更新日時がgit管理外(チェックアウト時刻)に
  // なってしまい、mtime順は意味を持たない。そのため「Genspark動画が事前に用意されている
  // 写真」を優先して選ぶ(たけしさんの方針: 作り置きした動画がある写真から順に投稿する)。
  // 動画が無い写真同士の順序はファイル名順(決定的な順序を保つため)。
  const posted = new Set(loadPostedList());
  const candidates = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f))
    .sort((a, b) => {
      const aHasVideo = hasPremadeVideo(a);
      const bHasVideo = hasPremadeVideo(b);
      if (aHasVideo !== bHasVideo) return aHasVideo ? -1 : 1;
      return a.localeCompare(b, 'ja');
    });
  return candidates[0] ?? null;
}

function dishNameFromFilename(filename) {
  let name = path.parse(filename).name;
  name = name.replace(/\s*-\s*コピー(\s*\(\d+\))?\s*$/i, '');
  name = name.replace(/\s*\(\d+\)\s*$/, '');
  name = name.replace(/\s*[_-]\s*\d+\s*$/, '');
  return name.trim();
}

const MUSIC_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.wav']);

function pickRandomMusic() {
  const files = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()))
    : [];
  if (files.length === 0) {
    throw new Error('musicフォルダに著作権フリーの音楽ファイル(mp3/mp4/m4a/wav)を入れてください。');
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
(Instagram投稿用の本文。1〜2文ごとに必ず改行を入れ、文章がずっと1行につながらないようにすること。目安は3〜5行、1行あたり20〜40文字程度の短い文で区切る。その後に空行を挟んでハッシュタグを15〜20個。集客に効果的な地域名+グルメ系、ジャンル系、汎用の飲食系、店名などをバランスよく)

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

function getVideoDurationSeconds(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]).toString().trim();
  return parseFloat(out);
}

// Genspark等で生成した動画は音楽を付けずに(無音で)作ってもらう運用にしているため、
// ここでmusicフォルダからランダムに選んだ音源を合成する。映像はそのまま(再エンコードなし)、
// 音声トラックだけを差し替える(元動画に音声があっても無視して上書きする)。
function addMusicToVideo(inputVideoPath, musicPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const duration = getVideoDurationSeconds(inputVideoPath);
  const fadeStart = Math.max(duration - 1, 0);

  execFileSync('ffmpeg', [
    '-y',
    '-i', inputVideoPath,
    '-i', musicPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-af', `afade=t=out:st=${fadeStart}:d=1`,
    '-shortest',
    outputPath,
  ], { stdio: 'inherit' });
}

function buildVideo(imagePath, overlayText, musicPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const textFile = outputPath + '.overlay.txt';
  fs.writeFileSync(textFile, overlayText, 'utf8');

  const fontFile = findJapaneseFont();
  const fps = 30;
  const totalFrames = VIDEO_SECONDS * fps;
  const zoomPerFrame = (0.2 / totalFrames).toFixed(6);

  // 前フレームのzoom値を自己参照する書き方(zoom+...)は、-loop 1の静止画入力と組み合わせると
  // 初回フレームから最大ズームに飛んでしまう既知の不具合があるため、絶対フレーム番号(on)を使って
  // 毎フレームのズーム量を直接計算する(1から始まり、totalFramesかけて1.2まで一定速度で増える)
  const zoompan = `zoompan=z='min(1+on*${zoomPerFrame},1.2)':d=1:s=1080x1920:fps=${fps}`;
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

  // 横長の写真をそのままscale+cropで9:16にすると左右が大きく切り取られ、
  // 「何の写真か分からないほどアップ」になってしまう。そのため、
  // ぼかして拡大した背景の上に、写真全体を欠けさせずに縮小したものを重ねる
  // (レターボックス+ぼかし背景)方式にする。どんな縦横比の写真でも全体が映る。
  const filterComplex =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.08[bg];` +
    `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,${zoompan},${drawtext}[v]`;

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

async function createMediaContainer(videoUrl, caption) {
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
  return createJson.id;
}

function signCreationId(creationId) {
  return crypto.createHmac('sha256', PUBLISH_SIGNING_SECRET).update(creationId).digest('hex').slice(0, 16);
}

async function sendLineNotification(dishName, caption, publishUrl, usedFallback) {
  const fallbackWarning = usedFallback
    ? '⚠️ Genspark動画が見つからなかったため、簡易版(写真をぼかしただけの背景)の動画になっています。\n\n'
    : '';
  const text =
    `【Instagram投稿の確認】\n${dishName}\n\n` +
    fallbackWarning +
    `${caption}\n\n` +
    `内容を確認して問題なければ、このリンクをタップすると投稿されます:\n${publishUrl}`;

  const body = JSON.stringify({ messages: [{ type: 'text', text }] });
  const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: Buffer.from(body, 'utf8'),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE通知エラー: ${errText}`);
  }
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

  const videoName = path.parse(photo).name + '.mp4';
  const branch = GITHUB_REF_NAME || 'master';

  // Gensparkなどで事前に作った高品質な動画がvideos/に置いてあれば、
  // ffmpegでの自動生成(Ken Burns風のズーム)は行わずそちらを優先して使う。
  const premadePath = path.join(PREMADE_VIDEOS_DIR, videoName);
  let videoUrl;
  let generatedVideoPath = null;
  let usedFfmpegFallback = false;

  git(['config', 'user.name', 'insta-auto-post-bot']);
  git(['config', 'user.email', 'actions@github.com']);

  if (fs.existsSync(premadePath)) {
    console.log('事前生成済みの動画を使用します: ' + premadePath);

    const musicPath = pickRandomMusic();
    console.log('使用するBGM: ' + path.basename(musicPath));

    generatedVideoPath = path.join(GENERATED_DIR, videoName);
    addMusicToVideo(premadePath, musicPath, generatedVideoPath);
    console.log('Genspark動画にBGMを合成しました: ' + generatedVideoPath);

    git(['add', path.relative(ROOT, generatedVideoPath)]);
    git(['commit', '-m', `動画にBGMを合成: ${videoName}`]);
    git(['push']);

    videoUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${branch}/generated/${encodeURIComponent(videoName)}`;
  } else {
    usedFfmpegFallback = true;
    const musicPath = pickRandomMusic();
    console.log('使用するBGM: ' + path.basename(musicPath));

    generatedVideoPath = path.join(GENERATED_DIR, videoName);
    buildVideo(imagePath, overlayText, musicPath, generatedVideoPath);
    console.log('動画を生成しました(ffmpegフォールバック): ' + generatedVideoPath);

    git(['add', path.relative(ROOT, generatedVideoPath)]);
    git(['commit', '-m', `動画を生成: ${videoName}`]);
    git(['push']);

    videoUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${branch}/generated/${encodeURIComponent(videoName)}`;
  }

  const creationId = await createMediaContainer(videoUrl, caption);
  console.log('Instagram側で公開準備が完了しました(まだ非公開): ' + creationId);

  const sig = signCreationId(creationId);
  const publishUrl = `${PUBLISH_WORKER_URL}?id=${encodeURIComponent(creationId)}&sig=${sig}`;
  await sendLineNotification(dishName || photo, caption, publishUrl, usedFfmpegFallback);
  console.log('LINEに確認通知を送信しました。実際の投稿はたけしさんがリンクをタップするまで行われません。');

  // このpushed候補は「実際に投稿済み」ではなく「承認待ちで提示済み」の意味。
  // 同じ写真を毎回LINEに送り続けないよう、ここで候補プールから外す。
  const posted = loadPostedList();
  posted.push(photo);
  savePostedList(posted);

  if (generatedVideoPath) fs.rmSync(generatedVideoPath);
  git(['add', '-A']);
  git(['commit', '-m', '投稿履歴を更新・生成ファイルを削除']);
  git(['push']);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

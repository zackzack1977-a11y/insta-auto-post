const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  ROOT,
  PHOTOS_DIR,
  loadPostedList,
  savePostedList,
  findPremadeVideoPath,
  pickNextPhoto,
} = require('./shared');

const MUSIC_DIR = path.join(ROOT, 'music');
const GENERATED_DIR = path.join(ROOT, 'generated');
// Instagramのメディアコンテナは作成からおよそ24時間で失効する。
// LINEリンクの有効期限はそれより少し短く設定し、期限切れの表示を
// Instagram側の分かりにくいエラーより先に、こちらの分かりやすい文言で出す。
// publish-worker.js側の同名の定数と必ず一致させること。
const PUBLISH_LINK_EXPIRY_MS = 23 * 60 * 60 * 1000;

const {
  INSTAGRAM_BUSINESS_ACCOUNT_ID,
  INSTAGRAM_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
  PUBLISH_SIGNING_SECRET,
  PUBLISH_WORKER_URL,
} = process.env;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

function getHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
}

// pull --rebase してからpushする。手元でvideos/等をpushした直後や、
// 前回実行の後始末コミットとの競合を避けるため、pushの前に必ず取り込む。
function pushWithRebase(branch) {
  git(['pull', '--rebase', '--autostash', 'origin', branch]);
  git(['push', 'origin', branch]);
}

// 429(レート制限)・5xx(サーバ側の一時的な障害)・ネットワークエラーの場合のみ
// 指数バックオフでリトライする。4xx(内容の誤り)はリトライしても無駄なのでそのまま返す。
async function fetchWithRetry(url, options = {}, { retries = 2, baseDelayMs = 1500, label = url } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[リトライ] ${label}: HTTP ${res.status} → ${delay}ms後に再試行 (${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[リトライ] ${label}: ネットワークエラー → ${delay}ms後に再試行 (${attempt + 1}/${retries}): ${err.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

  const res = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
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
    },
    { label: 'Anthropic API' }
  );

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error: ${JSON.stringify(json)}`);
  }
  const text = json?.content?.[0]?.text?.trim();
  if (!text) {
    throw new Error(`Anthropic APIの応答形式が想定と違います:\n${JSON.stringify(json)}`);
  }

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

function getVideoDurationSeconds(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]).toString().trim();
  const duration = parseFloat(out);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`動画の長さを取得できませんでした(ffprobeの出力: "${out}")。動画ファイルが壊れている可能性があります: ${videoPath}`);
  }
  return duration;
}

// Genspark等で生成した動画は音楽を付けずに(無音で)作ってもらう運用にしているため、
// ここでmusicフォルダからランダムに選んだ音源を合成する。映像はそのまま(再エンコードなし)、
// 音声トラックだけを差し替える(元動画に音声があっても無視して上書きする)。
// BGMの方が動画より短いケースがあるため、音声を無限ループさせたうえで
// -shortest(=映像の長さ)で切る。これにより「BGMが短いせいで動画自体が
// 切り詰められる」事故を防ぐ(逆に音声が長い場合は従来通り-shortestで映像長に合わせる)。
function addMusicToVideo(inputVideoPath, musicPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const duration = getVideoDurationSeconds(inputVideoPath);
  const fadeStart = Math.max(duration - 1, 0);

  execFileSync('ffmpeg', [
    '-y',
    '-i', inputVideoPath,
    '-stream_loop', '-1',
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

async function waitUntilMediaReady(creationId, attempts = 60, intervalMs = 10000) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetchWithRetry(
      `https://graph.instagram.com/v21.0/${creationId}?fields=status_code&access_token=${INSTAGRAM_ACCESS_TOKEN}`,
      {},
      { label: 'メディア状態確認' }
    );
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`メディア状態確認エラー: ${JSON.stringify(json)}`);
    }
    if (json.status_code === 'FINISHED' || json.status_code === 'PUBLISHED') return;
    if (json.status_code === 'ERROR') {
      throw new Error('Instagram側でメディアの処理に失敗しました');
    }
    if (json.status_code === 'EXPIRED') {
      throw new Error('Instagram側でメディアコンテナが失効しました(処理に時間がかかりすぎました)');
    }
    await sleep(intervalMs);
  }
  // Reelsは処理に5分を超えることがあるため、ここまで60回×10秒(最大10分)待っている。
  throw new Error('メディアの準備がタイムアウトしました(10分経過)');
}

async function createMediaContainer(videoUrl, caption) {
  const base = `https://graph.instagram.com/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}`;

  const createRes = await fetchWithRetry(
    `${base}/media`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }),
    },
    { retries: 1, label: 'Instagramメディア作成' } // POSTの再試行はコンテナ二重生成のリスクがあるため回数を絞る
  );
  const createJson = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Instagramメディア作成エラー: ${JSON.stringify(createJson)}`);
  }

  await waitUntilMediaReady(createJson.id);
  return createJson.id;
}

function signPublishToken(creationId, timestamp) {
  return crypto.createHmac('sha256', PUBLISH_SIGNING_SECRET).update(`${creationId}.${timestamp}`).digest('hex');
}

async function sendLineNotification(dishName, caption, publishUrl, expiresAt) {
  const expiresAtJst = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(expiresAt);
  const text =
    `【Instagram投稿の確認】\n${dishName}\n\n` +
    `${caption}\n\n` +
    `内容を確認して問題なければ、このリンクをタップすると投稿されます:\n${publishUrl}\n\n` +
    `⏰ このリンクは ${expiresAtJst}(日本時間)頃までが期限です。期限切れになった場合、この写真は自動で次回投稿の候補に戻ります。`;

  if (!LINE_USER_ID) {
    throw new Error('LINE_USER_IDが設定されていません。GitHub SecretsにLINE_USER_IDを登録してください。');
  }

  const body = JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text }] });
  const res = await fetchWithRetry(
    'https://api.line.me/v2/bot/message/push',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: Buffer.from(body, 'utf8'),
    },
    { label: 'LINE通知' }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE通知エラー: ${errText}`);
  }
}

// Genspark動画がまだ用意できていない写真が選ばれた場合、無理に(ffmpegの簡易動画で)
// 投稿はせず、投稿を見送ったことだけをLINEに知らせる。posted.jsonには記録しないため、
// この写真は次回以降も引き続き候補として残る(「作り置き」バッチが追いつくのを待つ)。
async function sendSkipNotification(dishName) {
  const text =
    `【Instagram投稿を見送りました】\n` +
    `本日投稿予定だった「${dishName}」について、Genspark動画がまだ用意できていなかったため、今回の投稿は見送りました。\n\n` +
    `作り置き(毎日10時に自動生成)が追いつき次第、次回以降の実行で自動的に投稿されます。`;

  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    console.warn('LINE_USER_ID/LINE_CHANNEL_ACCESS_TOKEN未設定のため、見送り通知は送信できません。');
    return;
  }

  const body = JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text }] });
  const res = await fetchWithRetry(
    'https://api.line.me/v2/bot/message/push',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: Buffer.from(body, 'utf8'),
    },
    { label: 'LINE見送り通知' }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE見送り通知エラー: ${errText}`);
  }
}

// main()内で例外が起きた場合、可能な限りたけしさん個人にLINEでエラーを知らせる。
// ここ自体が失敗しても(LINE_USER_ID未設定など)、元のエラーをもみ消さないよう
// 必ず自分で例外を握りつぶす。
async function notifyErrorBestEffort(err, photo) {
  try {
    if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
      console.error('LINE_USER_ID/LINE_CHANNEL_ACCESS_TOKEN未設定のため、エラー通知は送信できません。');
      return;
    }
    const text =
      `【Instagram自動投稿でエラー】\n` +
      (photo ? `対象: ${photo}\n\n` : '\n') +
      `${String(err && err.message ? err.message : err).slice(0, 800)}\n\n` +
      `詳細はGitHub Actionsの実行ログを確認してください。`;
    const body = JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text }] });
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: Buffer.from(body, 'utf8'),
    });
  } catch (notifyErr) {
    console.error('エラー通知の送信自体にも失敗しました:', notifyErr);
  }
}

// 「LINEに提示したが公開されたか未確認(confirmed: false)」のエントリについて、
// Instagram側のコンテナ状態を確認し、
//   - PUBLISHED  → confirmed: true にする(実際に公開されたことを確定)
//   - EXPIRED/ERROR、または問い合わせ自体が失敗(コンテナ消滅等) → 一覧から削除し、次回また候補に戻す
//   - FINISHED/IN_PROGRESS(まだ未公開でリンクの期限内の可能性がある) → そのまま保持
// これにより、24時間の期限切れでリンクをタップし損ねた写真が「提示済み」のまま
// 永久に投稿できなくなる、という事故を防ぐ。
async function reconcilePresentedPhotos() {
  const posted = loadPostedList();
  let changed = false;
  const next = [];

  for (const entry of posted) {
    if (entry.confirmed || !entry.creationId) {
      next.push(entry);
      continue;
    }
    try {
      const res = await fetchWithRetry(
        `https://graph.instagram.com/v21.0/${entry.creationId}?fields=status_code&access_token=${INSTAGRAM_ACCESS_TOKEN}`,
        {},
        { retries: 1, label: `コンテナ状態確認(${entry.photo})` }
      );
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }

      if (res.ok && json && json.status_code === 'PUBLISHED') {
        console.log(`確認: ${entry.photo} は公開済みでした。`);
        next.push({ ...entry, confirmed: true });
        changed = true;
      } else if (res.ok && json && (json.status_code === 'EXPIRED' || json.status_code === 'ERROR')) {
        console.log(`${entry.photo} は公開されないまま期限切れ/エラーになったため、候補に戻します。`);
        changed = true; // このエントリを落とす(next.pushしない)
      } else if (!res.ok) {
        console.log(`${entry.photo} のコンテナ確認に失敗(削除済み等)。候補に戻します: ${JSON.stringify(json)}`);
        changed = true;
      } else {
        // FINISHED / IN_PROGRESS 等: まだリンクの期限内かもしれないので保持
        next.push(entry);
      }
    } catch (err) {
      console.warn(`${entry.photo} のコンテナ状態確認でエラー、今回は判断を保留します: ${err.message}`);
      next.push(entry);
    }
  }

  if (changed) savePostedList(next);
}

let currentPhotoForErrorReport = null;

async function main() {
  await reconcilePresentedPhotos();

  const photo = pickNextPhoto();
  currentPhotoForErrorReport = photo;
  if (!photo) {
    console.log('投稿できる新しい写真がありません。photosフォルダに写真を追加してください。');
    return;
  }

  console.log(`投稿対象: ${photo}`);
  const dishName = dishNameFromFilename(photo);

  // Gensparkなどで事前に作った動画が無ければ、ffmpegで簡易動画を作って無理に投稿する
  // ことはせず、今回は投稿を見送る(「作り置き」バッチが追いつくのを待つ)。
  // posted.jsonには一切記録しないので、この写真は次回以降も引き続き候補に残る。
  const premadePath = findPremadeVideoPath(photo);
  if (!premadePath) {
    console.log(`Genspark動画がまだ用意されていないため、今回は投稿を見送ります: ${photo}`);
    await sendSkipNotification(dishName || photo);
    console.log('LINEに見送りの通知を送信しました。');
    return;
  }

  const imagePath = path.join(PHOTOS_DIR, photo);
  const noteFile = path.join(PHOTOS_DIR, path.parse(photo).name + '.txt');
  const noteText = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8').trim() : null;
  const dishNote = noteText || (dishName ? `料理名: ${dishName}` : null);
  console.log('料理情報として使用: ' + (dishNote ?? '(なし)'));

  const { caption } = await generateCaptionAndOverlay(imagePath, dishNote);
  console.log('生成されたキャプション:\n' + caption);

  const videoName = path.parse(photo).name + '.mp4';
  const branch = GITHUB_REF_NAME || 'master';
  const generatedVideoPath = path.join(GENERATED_DIR, videoName);

  git(['config', 'user.name', 'insta-auto-post-bot']);
  git(['config', 'user.email', 'actions@github.com']);

  const musicPath = pickRandomMusic();
  console.log('使用するBGM: ' + path.basename(musicPath));

  console.log('事前生成済みの動画を使用します: ' + premadePath);
  addMusicToVideo(premadePath, musicPath, generatedVideoPath);
  console.log('Genspark動画にBGMを合成しました: ' + generatedVideoPath);
  git(['add', path.relative(ROOT, generatedVideoPath)]);
  git(['commit', '-m', `動画にBGMを合成: ${videoName}`]);
  pushWithRebase(branch);

  // raw.githubusercontent.comはURL単位でキャッシュするため、push直後の404や
  // 同名ファイル再生成時に古い版が配信されるリスクがある。コミットSHAをクエリに
  // 付けてキャッシュを確実に割ることで回避する。
  const headSha = getHeadSha();
  const videoUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${branch}/generated/${encodeURIComponent(videoName)}?v=${headSha}`;

  const creationId = await createMediaContainer(videoUrl, caption);
  console.log('Instagram側で公開準備が完了しました(まだ非公開): ' + creationId);

  // 動画はInstagram側に取り込まれた後は不要なので削除する。
  // 投稿履歴(posted.json)の更新・pushは、必ずLINE通知の「前」に行う。
  // (LINE送信〜最終pushの間で失敗すると、次回同じ写真が再選択され二重にLINEが
  // 飛んでしまう可能性があったため、記録を先に確定させる)
  fs.rmSync(generatedVideoPath);
  const postedList = loadPostedList();
  postedList.push({
    photo,
    creationId,
    presentedAt: new Date().toISOString(),
    confirmed: false,
  });
  savePostedList(postedList);
  git(['add', path.relative(ROOT, generatedVideoPath), path.relative(ROOT, path.join(ROOT, 'data', 'posted.json'))]);
  git(['commit', '-m', `投稿履歴を更新・生成ファイルを削除: ${photo}`]);
  pushWithRebase(branch);

  const timestamp = Date.now();
  const sig = signPublishToken(creationId, timestamp);
  const publishUrl = `${PUBLISH_WORKER_URL}?id=${encodeURIComponent(creationId)}&ts=${timestamp}&sig=${sig}`;
  const expiresAt = new Date(timestamp + PUBLISH_LINK_EXPIRY_MS);

  await sendLineNotification(dishName || photo, caption, publishUrl, expiresAt);
  console.log('LINEに確認通知を送信しました。実際の投稿はたけしさんがリンクをタップするまで行われません。');
}

main().catch(async (err) => {
  console.error(err);
  await notifyErrorBestEffort(err, currentPhotoForErrorReport);
  process.exit(1);
});

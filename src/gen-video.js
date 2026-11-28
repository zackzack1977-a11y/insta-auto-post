// 作り置きの動画を、Gemini API(gemini-omni-1.2-flash)で作る(2026-11-10追加。Gensparkの代わり)。
// GitHub Actions の「動画の作り置き」(video-gen.yml)から動く。
//
// 流れ(写真1枚ごと):
//   1. 候補を選ぶ: 未投稿・動画なし・2回不合格になっていない写真。縦長の写真を先にする
//   2. 写真を正しい向きに直し、上下をGeminiの画像の機能で描き足して縦9:16にする(src/outpaint.js。料理の部分は元の写真を貼り戻す)
//   3. Claudeが、描き足した画像を見て、カメラの動きが違う2場面の指示文を作る(動きの候補は CAMERA_MOVES。毎回変える)
//   4. Gemini APIで8秒の動画を2本作る(2026-11-25から。以前は切り出した写真から12秒1本で、近すぎた)
//   5. 最初の0.6秒以内のカットは切り落とし、場面ごとに切り替わりを確かめる → 0.5秒重ねてつなぐ(約15.5秒)
//      → check-video.js → Claudeが写真と見比べる(料理が別物/ゆがみ/お皿が回る/人や手が映る、は不合格)
//   写真をスライドさせるだけ・ずらすだけの場面(ffmpegで写真を動かす編集)は使わない(たけしさんの指示)
//   6. 合格なら videos/写真名.mp4 に入れる。費用と結果は data/video-gen-log.json に必ず残す
//   7. LINEで知らせる(合格なら、文字入れとBGMを付けた仕上がりの見本の動画も送る)
//
// お金の守り:
//   ・1回の実行で作るのは MAX_VIDEOS 本まで(既定1、どう指定しても2まで)
//   ・1場面の長さは DURATION_SEC 秒(既定8、5〜10)×2場面。1品あたり 8秒×2本+描き足し1枚 ≒ 1.19ドル
//   ・今月の合計(日本時間の月)+今回の分が MONTHLY_CAP_USD(既定15ドル)を超えるなら作らない
//   ・定期実行では、使える在庫が STOCK_TARGET 本(既定6)以上あれば作らない(手動実行の FORCE=true は除く)
//   ・同じ写真が2回不合格・失敗したら、候補から外す
//
// 環境変数: GEMINI_API_KEY, ANTHROPIC_API_KEY, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID,
//           GITHUB_REPOSITORY, GITHUB_REF_NAME, MAX_VIDEOS, DURATION_SEC, MONTHLY_CAP_USD, STOCK_TARGET,
//           FORCE, PHOTO(作る写真を指定), DRY_RUN(trueならAPIを呼ばずに指示文と切り出しだけ作る), NO_PUSH
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, PHOTOS_DIR, PREMADE_VIDEOS_DIR, IMAGE_EXTENSIONS, loadPostedList, findPremadeVideoPath } = require('./shared');
const { generateOmniVideo, estimateUsd, MODEL } = require('./gemini-video');
const { outpaintVertical, USD_PER_IMAGE } = require('./outpaint');
const { notify } = require('./notify');
const { renderFinalVideo } = require('./video-edit');
const { dishNameFromFilename, pickRandomMusic } = require('./post-helpers');

// 手元で試すときは .env から読む(GitHubの上では Secrets から渡る)
const dotEnv = path.join(ROOT, '.env');
if (!process.env.GITHUB_ACTIONS && fs.existsSync(dotEnv)) {
  for (const line of fs.readFileSync(dotEnv, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = process.env;
const WORK_DIR = path.join(ROOT, 'generated', 'video-gen');
const LOG_FILE = path.join(ROOT, 'data', 'video-gen-log.json');
const SKIP_FILE = path.join(ROOT, 'data', 'video-skip.json');
const MAX_VIDEOS = Math.min(2, Math.max(1, parseInt(env.MAX_VIDEOS, 10) || 1));
// 1場面の秒数(既定8)と場面の数(2)。つなぐと約15.5秒になる
const SHOT_SEC = Math.min(10, Math.max(5, parseInt(env.DURATION_SEC, 10) || 8));
const SHOTS = 2;
const COST_PER_PHOTO = Math.round((estimateUsd(SHOT_SEC) * SHOTS + USD_PER_IMAGE) * 100) / 100;
const MONTHLY_CAP_USD = Number(env.MONTHLY_CAP_USD) > 0 ? Number(env.MONTHLY_CAP_USD) : 15;
const STOCK_TARGET = parseInt(env.STOCK_TARGET, 10) > 0 ? parseInt(env.STOCK_TARGET, 10) : 6;
const FORCE = env.FORCE === 'true';
const DRY_RUN = env.DRY_RUN === 'true';
const NO_PUSH = env.NO_PUSH === 'true';
const MAX_FAILS_PER_PHOTO = 2;
const PROMPT_MODEL = 'claude-sonnet-5-5';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

// ---------- 小道具 ----------
function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}
function monthJst(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(d);
}
function loadLog() {
  return fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
}
function saveLog(log) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');
}
function spentThisMonth(log) {
  const m = monthJst();
  return log.filter((e) => monthJst(new Date(e.at)) === m).reduce((s, e) => s + (e.usd || 0), 0);
}
function probeSize(file) {
  const out = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]));
  return { width: out.streams[0].width, height: out.streams[0].height };
}

// JPEGのEXIFの「向き」(1=そのまま、6=右に90度回す、など)。スマホを縦にして撮った写真は6になる
function jpegOrientation(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) return 1;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const t = off + 10;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = t + r32(t + 4);
      const n = r16(ifd);
      for (let i = 0; i < n; i += 1) {
        const e = ifd + 2 + i * 12;
        if (r16(e) === 0x0112) return r16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    off += 2 + len;
  }
  return 1;
}
const ORIENT_FILTER = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };

// 正しい向きに直した写真(元の大きさ)を作る
function makeUpright(photoPath, outPath) {
  const o = jpegOrientation(photoPath);
  const vf = ORIENT_FILTER[o] || 'null';
  run('ffmpeg', ['-y', '-loglevel', 'error', '-noautorotate', '-i', photoPath, '-vf', vf, '-q:v', '2', outPath]);
  return probeSize(outPath);
}
function isPortrait(photoFile) {
  const p = path.join(PHOTOS_DIR, photoFile);
  try {
    const { width, height } = probeSize(p);
    const o = path.extname(p).toLowerCase() === '.png' ? 1 : jpegOrientation(p);
    return [5, 6, 7, 8].includes(o) ? width > height : height > width;
  } catch (e) {
    return false;
  }
}

// ---------- 候補 ----------
function pickCandidates(log) {
  const posted = new Set(loadPostedList().map((e) => e.photo));
  const skipped = new Set(fs.existsSync(SKIP_FILE) ? JSON.parse(fs.readFileSync(SKIP_FILE, 'utf8')).map((e) => e.photo) : []);
  const fails = {};
  for (const e of log) if (e.result !== 'ok') fails[e.photo] = (fails[e.photo] || 0) + 1;
  const list = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f) && !skipped.has(f) && !findPremadeVideoPath(f))
    .filter((f) => (fails[f] || 0) < MAX_FAILS_PER_PHOTO)
    .map((f) => ({ f, portrait: isPortrait(f), fails: fails[f] || 0 }));
  // 縦長を先に、次に不合格の少ない順、最後に名前順
  list.sort((a, b) => (a.portrait !== b.portrait ? (a.portrait ? -1 : 1) : a.fails - b.fails || a.f.localeCompare(b.f, 'ja')));
  return list;
}
function countReady() {
  const posted = new Set(loadPostedList().map((e) => e.photo));
  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f) && findPremadeVideoPath(f)).length;
}

// ---------- Claude ----------
// 2026-11-12: Sonnet 5.5は、何も指定しなくても考える時間(thinking)を使い、その分もmax_tokensに数える。
// 確認の呼び出しをmax_tokens 300にしていたら、考えるだけで使い切って答えが空になり、
// できた動画(約0.84ドル)が「確認中のエラー」で捨てられた。なので上限は大きめにし、空なら理由を出す。
async function askClaude(content, maxTokens = 8000) {
  for (const model of [PROMPT_MODEL, FALLBACK_MODEL]) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    });
    const json = await res.json();
    if (res.ok) {
      const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text.trim()) return text;
      console.warn(`${model} の答えが空でした(stop_reason: ${json.stop_reason}${json.stop_details ? ', ' + JSON.stringify(json.stop_details) : ''})`);
      if (model === FALLBACK_MODEL) return '';
      continue;
    }
    if (model === FALLBACK_MODEL || (res.status !== 404 && res.status !== 400)) {
      throw new Error(`Anthropic APIのエラー(${model}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    console.warn(`${model} が使えなかったので ${FALLBACK_MODEL} で続けます`);
  }
  return '';
}
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claudeの答えにJSONがありません: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}
function imageBlock(file) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(file).toString('base64') } };
}
function smallCopy(src, out, box = 1400) {
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${box}:${box}:force_original_aspect_ratio=decrease`, '-q:v', '3', out]);
  return out;
}

// 2026-11-25 作り方を変えた(たけしさんの要望): 切り出しは近すぎて「押し込むだけ」になっていたので、
// 上下を描き足した縦長の画像(src/outpaint.js、料理は元の写真のまま)から、カメラの動きが違う2場面を作ってつなぐ。
// 写真をスライドさせるだけ・ずらすだけの編集(ffmpegで写真を動かす場面)は使わない。全部の場面が実写の動き。
// 毎回同じにならないよう、カメラの動きは下の中から、料理に合わせてClaudeが2つ選ぶ。
const CAMERA_MOVES = [
  'low-orbit: the camera smoothly lowers toward table height while moving a little closer, then glides sideways in a slow arc of about 25 degrees around the dish (the background visibly slides past behind the dish)',
  'truck-rise: a slow, steady sideways dolly (camera trucking left or right) combined with a gentle rise in height, the background bar shelves and lights sliding past with natural parallax, the whole dish staying in frame',
  'push-macro: a slow push-in from the start framing toward the most appetizing part of the dish, ending in a close-up where steam/bubbles/gloss are clearly visible',
  'crane-down: the camera starts slightly higher and slowly descends to a low, heroic eye-level angle facing the dish, with a slight sideways drift',
  'top-tilt: the camera rises and tilts down to a high three-quarter view showing the whole plate and the table around it, then drifts slowly sideways',
  'slow-reveal: starting a little closer than the start framing on the dish, the camera slowly pulls back and rises to show the whole plate and some of the table and bar around it',
];

// 描き足した縦長の画像を見て、2場面ぶんの指示文を作る
async function planVideo(startSmall, dishName, note) {
  const text = `You are directing two short shots for a restaurant's Instagram Reel, made with an image-to-video model (Gemini Omni Flash).
The attached vertical 9:16 image is the start frame of BOTH shots. The dish's official Japanese name is 「${dishName}」.${note ? `\nOwner's note about the dish (Japanese): ${note}` : ''}

Choose TWO different camera moves from this list that suit this dish (vary them; do not always pick the first ones):
${CAMERA_MOVES.map((m) => '- ' + m).join('\n')}

Return ONLY a JSON object:
{
 "action": the natural live food motion you chose, or "none",
 "shots": [
  {"move": "the move name", "prompt": "the English prompt for shot 1"},
  {"move": "the move name", "prompt": "the English prompt for shot 2"}
 ]
}

Write each "prompt" in exactly this structure (~120-160 words):
Vertical 9:16, ${SHOT_SEC} seconds, one continuous take with no cuts, photorealistic cinematic food commercial of "[faithful English translation of the Japanese dish name]" served [on/in the plate/vessel exactly as seen], on [the surface as seen] ([comma list of ONLY the items you can actually see]). [The live food motion, described as continuing during the entire shot, never freezing.] The plate, the food and everything on the table stay perfectly still and fixed in place; they never rotate, spin, turn or slide. Only the camera moves. Camera choreography: [the chosen move, written out with timings in seconds]. Smooth gimbal movement, shallow depth of field, warm moody bar lighting, appetizing highlights. Keep every item the same as in the image, keep the table, napkins and background natural and undistorted, do not add ingredients, do not deform the food or the dishware. No people, no faces, no hands, no arms. No speech, no music. No text, no logos, no watermark.

Live food motion rules: hot dishes → steam rising and curling, plus gentle sizzling bubbles only if there is hot oil or sauce (e.g. ajillo, gratin, hot pan). Melted cheese → a slight glisten, no stretching unless the image shows it. Cold or raw dishes (sashimi, carpaccio, salads, vegetable sticks, oysters, desserts) → "none": no steam; use subtle glistening light only. Never add ingredients, garnish, sauce, utensils or hands that are not in the image or note.
Never use the word "orbit" or ask the dish to rotate: describe how the CAMERA moves around a still dish.`;
  const answer = await askClaude([imageBlock(startSmall), { type: 'text', text }]);
  const plan = parseJson(answer);
  if (!Array.isArray(plan.shots) || plan.shots.length < SHOTS || plan.shots.some((s) => !s.prompt || s.prompt.length < 80)) throw new Error('指示文が作れませんでした');
  plan.shots = plan.shots.slice(0, SHOTS);
  return plan;
}

// 2つの場面を、そろった形(1080x1920、30コマ、音なし)にして、0.5秒の重ね合わせでつなぐ
function joinShots(files, outPath) {
  const norm = files.map((f) => {
    const n = f.replace(/\.mp4$/, '_n.mp4');
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', n]);
    return n;
  });
  if (norm.length === 1) {
    fs.copyFileSync(norm[0], outPath);
    return;
  }
  const dur = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());
  let chain = '';
  let last = '[0:v]';
  let offset = 0;
  for (let i = 1; i < norm.length; i += 1) {
    offset += dur(norm[i - 1]) - 0.5;
    const label = i === norm.length - 1 ? '[v]' : `[x${i}]`;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=0.5:offset=${offset.toFixed(2)}${label};`;
    last = label;
  }
  run('ffmpeg', ['-y', '-loglevel', 'error', ...norm.flatMap((f) => ['-i', f]), '-filter_complex', chain.replace(/;$/, ''), '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath]);
}
// ---------- できた動画の後始末と合格チェック ----------
function sceneCuts(file) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}
// 最初の0.6秒以内にカットがあれば、そこから後ろだけを残す(比較のポークCは0.33秒目にカットがあった)
function trimLeadingCut(raw, outPath) {
  const early = sceneCuts(raw).filter((t) => t > 0 && t <= 0.6);
  if (early.length === 0) {
    fs.copyFileSync(raw, outPath);
    return 0;
  }
  const start = Math.max(...early) + 0.05;
  run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start.toFixed(2), '-i', raw, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath]);
  return start;
}
function machineCheck(video) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-video.js'), video], { cwd: ROOT, encoding: 'utf8' });
  const lines = (r.stdout || '').split('\n');
  const sheet = (lines.find((l) => l.startsWith('見比べ用の1枚絵: ')) || '').replace('見比べ用の1枚絵: ', '').trim();
  return { ok: r.status === 0, reasons: lines.filter((l) => l.startsWith('・')).map((l) => l.slice(1)), sheet };
}
async function visualCheck(smallPhoto, sheet, dishName) {
  const sheetJpg = sheet.replace(/\.png$/, '.jpg');
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', sheet, '-q:v', '3', sheetJpg]);
  const text = `1枚目は料理「${dishName}」の元の写真、2枚目はその写真の上下をAIで描き足してから作った動画を、1秒ごとに並べたコマ(左上から順)です。動画は2つの場面を、なめらかに重ねてつないであります(場面のつなぎ目は不合格の理由にしない)。
次のどれかに当てはまるときだけ不合格にしてください。
①1つの場面の途中で、別の場面・別のお皿にパッと切り替わる ②料理そのものが写真と別物になっている(主役の食材や盛り付けが違う) ③引き伸ばし・ゆがみ・溶けたような崩れ・ノイズ(描き足したテーブルや店内も含む) ④お皿や料理そのものが回ったり動いたりしている(カメラが動くなら、奥の景色が流れて見えるはず。奥が止まったままお皿の向きだけ変わるのは不合格) ⑤人・顔・手・腕がはっきり映っている(奥にぼんやり見える程度は可)
背景に棚や厨房や店内が入る、添え物が少し増える、カメラが寄ったり回り込んだりする、程度は合格です。
JSONだけで答えてください: {"ok": true か false, "reason": "日本語で短く"}`;
  const answer = await askClaude([imageBlock(smallPhoto), imageBlock(sheetJpg), { type: 'text', text }]);
  const j = parseJson(answer);
  return { ok: j.ok === true, reason: String(j.reason || '') };
}
// ---------- LINE ----------
// 2026-11-28: 送り先は src/notify.js(NOTIFY_CHANNEL で Discord / LINE を切り替え)
async function pushLine(messages) {
  await notify(messages);
}
function yen(usd) {
  return `約${Math.round(usd * 155)}円`;
}

// ---------- 1枚分 ----------
async function makeOne(cand, log) {
  const photo = cand.f;
  const base = path.parse(photo).name;
  const dishName = dishNameFromFilename(photo) || base;
  const noteFile = path.join(PHOTOS_DIR, base + '.txt');
  const note = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8').trim() : '';
  const dir = path.join(WORK_DIR, base);
  fs.mkdirSync(dir, { recursive: true });

  const upright = path.join(dir, 'upright.jpg');
  const size = makeUpright(path.join(PHOTOS_DIR, photo), upright);
  const small = smallCopy(upright, path.join(dir, 'small.jpg'));
  const entry = { at: new Date().toISOString(), photo, model: MODEL, seconds: 0, usd: 0, result: 'error', reason: '', portrait: cand.portrait, style: 'outpaint-2shots' };

  if (DRY_RUN) {
    console.log(`DRY_RUN のため、描き足しと動画は作りません(${photo}、${size.width}x${size.height})`);
    return { entry: null };
  }
  log.push(entry);

  // 1. 上下を描き足して、縦9:16の始まりの画像を作る(料理の部分は元の写真のまま)
  const startPath = path.join(dir, 'start.jpg');
  try {
    let op = await outpaintVertical({ apiKey: env.GEMINI_API_KEY, uprightPath: upright, outPath: startPath, workDir: path.join(dir, 'outpaint'), dishName, mode: 'gray' });
    entry.usd += op.usd;
    if (op.outpainted && !op.ok) {
      console.warn(`描き足しで写真の位置がずれました(一致度 ${op.ssim.toFixed(2)})。もう1回だけ試します`);
      op = await outpaintVertical({ apiKey: env.GEMINI_API_KEY, uprightPath: upright, outPath: startPath, workDir: path.join(dir, 'outpaint2'), dishName, mode: 'gray' });
      entry.usd += op.usd;
    }
    entry.outpaint = { outpainted: op.outpainted, ssim: op.ssim, model: op.model };
    if (op.outpainted && !op.ok) throw new Error(`描き足しで写真の位置がずれました(一致度 ${op.ssim.toFixed(2)})`);
  } catch (e) {
    entry.reason = '上下の描き足しに失敗: ' + e.message.slice(0, 250);
    console.error(entry.reason);
    return { entry };
  }

  // 2. 2場面ぶんの指示文
  let plan;
  try {
    plan = await planVideo(smallCopy(startPath, path.join(dir, 'start_small.jpg')), dishName, note);
  } catch (e) {
    entry.reason = '指示文づくりに失敗: ' + e.message.slice(0, 250);
    return { entry };
  }
  entry.action = plan.action;
  entry.camera = plan.shots.map((s) => s.move).join(' + ');
  entry.prompt = plan.shots.map((s, i) => `[${i + 1}] ${s.prompt}`).join('\n');
  console.log(`料理の動き: ${plan.action} / カメラ: ${entry.camera}`);
  console.log('指示文:\n' + entry.prompt);

  // 3. 場面ごとに動画を作る(1つ目で失敗・切り替わりがあれば、2つ目は作らずにお金を守る)
  const clips = [];
  entry.interactionIds = [];
  for (let i = 0; i < plan.shots.length; i += 1) {
    const raw = path.join(dir, `raw${i + 1}.mp4`);
    try {
      const r = await generateOmniVideo({ apiKey: env.GEMINI_API_KEY, imagePath: startPath, prompt: plan.shots[i].prompt, seconds: SHOT_SEC, outPath: raw });
      entry.usd += r.estimatedUsd;
      entry.seconds += r.seconds;
      entry.interactionIds.push(r.interactionId);
    } catch (e) {
      entry.usd += e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429 ? 0 : estimateUsd(SHOT_SEC);
      entry.reason = `場面${i + 1}の動画づくりに失敗: ` + e.message.slice(0, 250);
      console.error(entry.reason);
      return { entry };
    }
    const trimmed = path.join(dir, `shot${i + 1}.mp4`);
    const cutAt = trimLeadingCut(raw, trimmed);
    if (cutAt) console.log(`場面${i + 1}: 最初の${cutAt.toFixed(2)}秒にカットがあったので切り落としました`);
    const cuts = sceneCuts(trimmed).filter((t) => t > 0.5);
    if (cuts.length) {
      entry.result = 'ng';
      entry.reason = `場面${i + 1}の途中で場面が切り替わっている(${cuts.map((t) => t.toFixed(1)).join('、')}秒)`;
      console.log('判定: ng ' + entry.reason);
      return { entry };
    }
    clips.push(trimmed);
  }

  // 4. つないで、機械の確認と、目での確認
  const video = path.join(dir, 'video.mp4');
  try {
    joinShots(clips, video);
    const mc = machineCheck(video);
    let vc = { ok: false, reason: '' };
    if (mc.ok) vc = await visualCheck(small, mc.sheet, dishName);
    entry.result = mc.ok && vc.ok ? 'ok' : 'ng';
    entry.reason = mc.ok ? vc.reason : mc.reasons.join(' / ');
  } catch (e) {
    // お金を使ったあとのエラーは、記録を残すためにここで受け止める
    entry.result = 'error';
    entry.reason = 'できた動画の確認中のエラー: ' + e.message.slice(0, 200);
  }
  entry.usd = Math.round(entry.usd * 100) / 100;
  console.log(`判定: ${entry.result} ${entry.reason}(費用 $${entry.usd})`);
  return { entry, video, dir, dishName };
}
// ---------- 全体 ----------
async function main() {
  const branch = env.GITHUB_REF_NAME || 'master';
  if (env.GITHUB_ACTIONS) {
    git(['config', 'user.name', 'insta-auto-post-bot']);
    git(['config', 'user.email', 'actions@github.com']);
    git(['fetch', 'origin', branch]);
    git(['reset', '--hard', `origin/${branch}`]);
  }
  const log = loadLog();
  const ready = countReady();
  console.log(`使える在庫: ${ready}本(目安 ${STOCK_TARGET}本)、今月の動画代: $${spentThisMonth(log).toFixed(2)} / 上限 $${MONTHLY_CAP_USD}`);
  if (!FORCE && ready >= STOCK_TARGET) {
    console.log('在庫が足りているので、今日は作りません');
    return;
  }

  let cands = pickCandidates(log);
  if (env.PHOTO) cands = cands.filter((c) => c.f === env.PHOTO);
  if (cands.length === 0) {
    console.log('動画にできる写真がありません' + (env.PHOTO ? `(${env.PHOTO} は候補にありません)` : ''));
    if (!env.PHOTO) await pushLine([{ type: 'text', text: '【動画の作り置き】動画にできる写真がありません。photos に写真を足してください。' }]);
    return;
  }

  const results = [];
  for (const cand of cands.slice(0, MAX_VIDEOS)) {
    const cost = COST_PER_PHOTO;
    if (!DRY_RUN && spentThisMonth(log) + cost > MONTHLY_CAP_USD) {
      const msg = `【動画の作り置き】今月の動画代が上限($${MONTHLY_CAP_USD})に届くので、作るのを止めました。今月の合計: $${spentThisMonth(log).toFixed(2)}`;
      console.log(msg);
      await pushLine([{ type: 'text', text: msg }]);
      break;
    }
    const r = await makeOne(cand, log);
    if (!r.entry) continue;
    results.push(r);
    saveLog(log); // お金を使ったら、すぐ記録する
  }
  if (DRY_RUN || results.length === 0) return;

  // 合格した動画を videos/ に入れ、仕上がりの見本(文字入れ+BGM)も作る
  const toAdd = [path.relative(ROOT, LOG_FILE)];
  for (const r of results) {
    if (r.entry.result !== 'ok') continue;
    const dest = path.join(PREMADE_VIDEOS_DIR, path.parse(r.entry.photo).name + '.mp4');
    fs.copyFileSync(r.video, dest);
    toAdd.push(path.relative(ROOT, dest));
    try {
      const sample = path.join(ROOT, 'generated', 'video-gen-sample', path.parse(r.entry.photo).name + '.mp4');
      fs.mkdirSync(path.dirname(sample), { recursive: true });
      renderFinalVideo(dest, pickRandomMusic(), sample, { dishName: r.dishName, workDir: path.join(r.dir, 'work'), style: 'hand' });
      const thumb = sample.replace(/\.mp4$/, '.jpg');
      run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '6', '-i', sample, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', thumb]);
      r.sample = sample;
      r.thumb = thumb;
      toAdd.push(path.relative(ROOT, sample), path.relative(ROOT, thumb));
    } catch (e) {
      console.warn('仕上がりの見本は作れませんでした(作り置きには入っています): ' + e.message);
    }
  }
  if (NO_PUSH) {
    console.log('NO_PUSH のため、commit と push はしません');
    return;
  }
  git(['add', ...toAdd]);
  const okNames = results.filter((r) => r.entry.result === 'ok').map((r) => path.parse(r.entry.photo).name);
  git(['commit', '-m', okNames.length ? `動画の作り置き(Gemini): ${okNames.join('、')}` : '動画の作り置き(Gemini): 不合格・失敗の記録']);
  git(['pull', '--rebase', '--autostash', 'origin', branch]);
  git(['push', 'origin', branch]);
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  const cdn = (p) => `https://cdn.jsdelivr.net/gh/${env.GITHUB_REPOSITORY}@${sha}/${p.split(path.sep).join('/').split('/').map(encodeURIComponent).join('/')}`;

  const total = spentThisMonth(log);
  for (const r of results) {
    const e = r.entry;
    const name = path.parse(e.photo).name;
    if (e.result === 'ok') {
      const msgs = [];
      if (r.sample) msgs.push({ type: 'video', originalContentUrl: cdn(path.relative(ROOT, r.sample)), previewImageUrl: cdn(path.relative(ROOT, r.thumb)) });
      msgs.push({ type: 'text', text: `【動画の作り置き】「${name}」の動画を作りました(${e.seconds}秒、${yen(e.usd)})。\n上の動画は、投稿のときの仕上がり(文字とBGM入り)の見本です。投稿の順番が来たら、いつもどおり確認のLINEが届きます。\n今月の動画代: $${total.toFixed(2)}(上限 $${MONTHLY_CAP_USD})` });
      await pushLine(msgs);
    } else {
      const left = MAX_FAILS_PER_PHOTO - log.filter((x) => x.photo === e.photo && x.result !== 'ok').length;
      await pushLine([{ type: 'text', text: `【動画の作り置き】「${name}」は${e.result === 'ng' ? '不合格' : '作れません'}でした(${e.reason})。${left > 0 ? '次の回にもう一度作ります。' : 'この写真は2回うまくいかなかったので、作り置きの候補から外しました。撮り直しか、別の写真をお願いします。'}\n今月の動画代: $${total.toFixed(2)}(上限 $${MONTHLY_CAP_USD})` }]);
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  await pushLine([{ type: 'text', text: `【動画の作り置き】エラーで止まりました: ${String(e.message || e).slice(0, 300)}` }]).catch(() => {});
  process.exit(1);
});

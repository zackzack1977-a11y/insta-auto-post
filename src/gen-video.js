// 作り置きの動画を、Gemini API(gemini-omni-1.2-flash)で作る(2026-11-10追加。Gensparkの代わり)。
// GitHub Actions の「動画の作り置き」(video-gen.yml)から動く。
//
// 流れ(写真1枚ごと):
//   1. 候補を選ぶ: 未投稿・動画なし・2回不合格になっていない写真。縦長の写真を先にする
//   2. 写真を正しい向きに直し、Claudeに「料理の中心」と「指示文(比較で一番良かったCの型)」を作らせる
//   3. 料理を中心に縦9:16に切り出す(9:16に近い縦長の写真は切らない)
//   4. Gemini APIで12秒の動画を作る
//   5. 最初の0.6秒以内のカットは切り落とす → check-video.js(切り替わり・縦横比・長さ)→ Claudeが写真と見比べる
//   6. 合格なら videos/写真名.mp4 に入れる。費用と結果は data/video-gen-log.json に必ず残す
//   7. LINEで知らせる(合格なら、文字入れとBGMを付けた仕上がりの見本の動画も送る)
//
// お金の守り:
//   ・1回の実行で作るのは MAX_VIDEOS 本まで(既定1、どう指定しても2まで)
//   ・長さは DURATION_SEC 秒(既定12、3〜15)
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
const DURATION_SEC = Math.min(15, Math.max(3, parseInt(env.DURATION_SEC, 10) || 12));
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
async function askClaude(content, maxTokens = 1200) {
  for (const model of [PROMPT_MODEL, FALLBACK_MODEL]) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    });
    const json = await res.json();
    if (res.ok) return json.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
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

// 写真を見て、料理の中心・構図・指示文を作る(比較で一番良かった「C」の型)
async function planVideo(smallPhoto, dishName, note, portrait) {
  const text = `You are writing a prompt for an image-to-video model (Gemini Omni Flash) for a restaurant's Instagram Reel.
The attached photo is the start image. The dish's official Japanese name is 「${dishName}」.${note ? `\nOwner's note about the dish (Japanese): ${note}` : ''}
The photo was taken ${portrait ? 'in portrait orientation' : 'in landscape orientation and will be center-cropped to vertical 9:16 around the dish'}.

Return ONLY a JSON object:
{
 "center_x": 0-1 (horizontal center of the main plate in this photo, fraction of width),
 "center_y": 0-1 (vertical center of the main plate, fraction of height),
 "composition": "wide" if the whole plate and some table/background are visible, "close" if the plate is cut off by the frame,
 "action": short label of the food action you chose, or "none",
 "camera": short label of the camera moves,
 "prompt": the English prompt
}

Write "prompt" in exactly this structure (fill the brackets, ~110-150 words):
Vertical 9:16, ${DURATION_SEC} seconds, one continuous take with no cuts, photorealistic cinematic food commercial of "[faithful English translation of the Japanese dish name]" on [the plate/vessel and surface exactly as seen] ([comma list of ONLY the items you can actually see]). Camera choreography: 0-3s [...]; 3-7s [...]; 7-${DURATION_SEC}s [...]. Smooth gimbal movement, shallow depth of field, warm moody bar lighting, appetizing highlights. Keep every item the same as in the photo, do not add ingredients, do not deform the food. No people or faces. Natural soft restaurant ambience only, no speech, no music. No text, no logos, no watermark.

Camera rules:
- "wide": 0-3s extreme macro close-up gliding across the most appetizing part; 3-7s the camera smoothly pulls back and rises to reveal the whole plate [+ the food action]; 7-end a slow orbit of at most 30 degrees around the plate ending with a gentle push-in.
- "close": 0-3s extreme macro close-up gliding across the food; 3-7s a slow pull-back only as far as the original photo framing [+ the food action]; 7-end a gentle push-in. NO orbit and do not reveal anything outside the photo (it would make the model invent unseen parts).
Food action rules (choose at most ONE, only if natural for this dish): a spoon drizzling a glossy ribbon of the dish's own sauce (only if the dish clearly has that sauce, or the note says so); steam rising (hot dishes only); melted cheese stretching (only for visibly cheesy hot dishes). For raw, cold or fried-dry dishes (sashimi, oysters, carpaccio, salads, vegetable sticks, fries) use "none" and rely on light and camera only. Only a hand holding the spoon may appear. Never add ingredients, garnish or sauce that are not in the photo or note.`;
  const answer = await askClaude([imageBlock(smallPhoto), { type: 'text', text }]);
  const plan = parseJson(answer);
  plan.center_x = Math.min(1, Math.max(0, Number(plan.center_x) || 0.5));
  plan.center_y = Math.min(1, Math.max(0, Number(plan.center_y) || 0.5));
  if (!plan.prompt || plan.prompt.length < 50) throw new Error('指示文が作れませんでした');
  return plan;
}

// 料理を中心に、縦9:16に切り出して 1080x1920 以内にする
function cropVertical(upright, size, plan, outPath) {
  const r = 9 / 16;
  const { width: W, height: H } = size;
  let vf;
  if (W / H > r * 1.03) {
    const cw = Math.floor((H * r) / 2) * 2;
    const x = Math.round(Math.min(W - cw, Math.max(0, plan.center_x * W - cw / 2)));
    vf = `crop=${cw}:${H}:${x}:0`;
  } else if (W / H < r / 1.03) {
    const ch = Math.floor(W / r / 2) * 2;
    const y = Math.round(Math.min(H - ch, Math.max(0, plan.center_y * H - ch / 2)));
    vf = `crop=${W}:${ch}:0:${y}`;
  } else {
    vf = 'null';
  }
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', upright, '-vf', `${vf},scale=1080:1920:force_original_aspect_ratio=decrease`, '-q:v', '2', outPath]);
  return vf;
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
  const text = `1枚目は料理「${dishName}」の元の写真、2枚目はその写真から作った動画を1秒ごとに並べたコマ(左上から順)です。
次の3つのどれかに当てはまるときだけ不合格にしてください。
①途中で別の場面・別のお皿に切り替わる ②料理そのものが写真と別物になっている(主役の食材や盛り付けが違う) ③引き伸ばし・ゆがみ・溶けたような崩れ・ノイズ
背景に棚や厨房が少し入る、添え物が少し増える、カメラが寄ったり回り込んだりする、程度は合格です。
JSONだけで答えてください: {"ok": true か false, "reason": "日本語で短く"}`;
  const answer = await askClaude([imageBlock(smallPhoto), imageBlock(sheetJpg), { type: 'text', text }], 300);
  const j = parseJson(answer);
  return { ok: j.ok === true, reason: String(j.reason || '') };
}

// ---------- LINE ----------
async function pushLine(messages) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_USER_ID) {
    console.warn('LINEの設定が無いので、知らせは送りません');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: Buffer.from(JSON.stringify({ to: env.LINE_USER_ID, messages }), 'utf8'),
  });
  if (!res.ok) console.warn('LINEへの送信に失敗: ' + (await res.text()));
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
  const plan = await planVideo(small, dishName, note, cand.portrait);
  const cropPath = path.join(dir, 'start.jpg');
  const crop = cropVertical(upright, size, plan, cropPath);
  console.log(`写真: ${photo}(${cand.portrait ? '縦長' : '横長'}、${size.width}x${size.height}、切り出し ${crop})`);
  console.log(`構図: ${plan.composition} / 動き: ${plan.camera} / 料理の動き: ${plan.action}`);
  console.log('指示文:\n' + plan.prompt);

  const entry = { at: new Date().toISOString(), photo, model: MODEL, seconds: DURATION_SEC, usd: 0, result: 'error', reason: '', portrait: cand.portrait, composition: plan.composition, camera: plan.camera, action: plan.action, prompt: plan.prompt };
  if (DRY_RUN) {
    console.log('DRY_RUN のため、動画は作りません');
    return { entry: null };
  }

  const raw = path.join(dir, 'raw.mp4');
  log.push(entry);
  try {
    const r = await generateOmniVideo({ apiKey: env.GEMINI_API_KEY, imagePath: cropPath, prompt: plan.prompt, seconds: DURATION_SEC, outPath: raw });
    entry.usd = r.estimatedUsd;
    entry.interactionId = r.interactionId;
  } catch (e) {
    // 入力の誤り(400など)は料金がかからないとみる。時間切れやサーバーの不具合は、かかったものとして数える
    entry.usd = e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429 ? 0 : estimateUsd(DURATION_SEC);
    entry.reason = e.message.slice(0, 300);
    console.error('動画づくりに失敗: ' + e.message);
    return { entry };
  }

  const trimmed = path.join(dir, 'video.mp4');
  try {
    const cutAt = trimLeadingCut(raw, trimmed);
    if (cutAt) console.log(`最初の${cutAt.toFixed(2)}秒にカットがあったので切り落としました`);
    const mc = machineCheck(trimmed);
    let vc = { ok: false, reason: '' };
    if (mc.ok) vc = await visualCheck(small, mc.sheet, dishName);
    entry.result = mc.ok && vc.ok ? 'ok' : 'ng';
    entry.reason = mc.ok ? vc.reason : mc.reasons.join(' / ');
  } catch (e) {
    // お金を使ったあとのエラーは、記録を残すためにここで受け止める
    entry.result = 'error';
    entry.reason = 'できた動画の確認中のエラー: ' + e.message.slice(0, 200);
  }
  console.log(`判定: ${entry.result} ${entry.reason}`);
  return { entry, video: trimmed, dir, dishName };
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
    const cost = estimateUsd(DURATION_SEC);
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

// 横長の写真の上下を、Geminiの画像の機能で描き足して、縦9:16の画像にする(2026-11-25追加)。
// 動画のAIに「近すぎる切り出し」ではなく、お皿全体と店内が入った縦長の画像を渡すため。
//
// 料理が描き直されないように:
//   1. 写真を横幅いっぱいに置き、上下は写真をぼかしたもので埋めた「下絵」を作って渡す
//   2. 返ってきた絵の、写真の位置が元の写真とずれていないかを SSIM で確かめる(ずれていたら不合格)
//   3. 最後に、真ん中の写真の部分は元の写真をそのまま貼り戻す(つなぎ目は少しぼかす)
// なので、料理そのものは必ず元の写真のまま。AIが描くのは上下のテーブル・店内だけ。
//
// 鍵(GEMINI_API_KEY)はヘッダーでだけ渡す(URLに載せない)。
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const IMAGE_MODELS = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image'];
const USD_PER_IMAGE = 0.07; // 多めに見積もる
const OUT_W = 1080;
const OUT_H = 1920;
const FEATHER = 90; // 貼り戻すときの、つなぎ目のぼかし(ピクセル)
const MIN_SSIM = 0.55; // 描き足した絵の、写真の部分が元とどれだけ合っているか(これ未満は配置がずれたとみる)

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}
function probeSize(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' }));
  return { width: out.streams[0].width, height: out.streams[0].height };
}
function ssim(a, b) {
  const err = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = err.match(/All:([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

async function callImageModel(apiKey, imagePath, prompt) {
  let lastErr;
  for (const model of IMAGE_MODELS) {
    const body = {
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(imagePath).toString('base64') } }, { text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
    };
    const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastErr = new Error(`Geminiの画像のエラー(${model}, HTTP ${res.status}): ${JSON.stringify(json.error || json).slice(0, 300)}`);
      lastErr.httpStatus = res.status;
      if (res.status === 404 || res.status === 400) {
        console.warn(lastErr.message + ' → 次のモデルで試します');
        continue;
      }
      throw lastErr;
    }
    const parts = json.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData || p.inline_data);
    if (!img) {
      lastErr = new Error(`画像が返ってきませんでした(${model}): ${JSON.stringify(json).slice(0, 300)}`);
      throw lastErr;
    }
    const d = img.inlineData || img.inline_data;
    return { model, buffer: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type };
  }
  throw lastErr;
}

// 境目を目立たなくする: 境目の上下±60pxだけ縦にぼかしてから、元の写真を、端を広く(FEATHER)なだらかにして重ねる
function pasteBack(gen, photo, y0, ph, outPath) {
  const y1 = y0 + ph;
  const fe = Math.min(FEATHER, Math.floor(ph / 4));
  ff([
    '-i', gen, '-i', photo, '-filter_complex',
    `[0:v]split[g][g2];[g2]gblur=sigma=0.1:sigmaV=30,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*max(0,1-min(abs(Y-${y0}),abs(Y-${y1}))/60)'[s];[g][s]overlay=0:0[gs];` +
      `[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,min(Y,H-1-Y)/${fe})'[p];[gs][p]overlay=0:${y0},format=yuvj420p`,
    '-q:v', '2', outPath,
  ]);
}

// 描き足した絵の中で、元の写真がどの高さにあるかを探す(横幅いっぱいに置かれている前提)
function findPhoto(gen, photo, ph, workDir) {
  const mid = path.join(workDir, 'op_find.png');
  let best = { y: Math.round((OUT_H - ph) / 2 / 2) * 2, score: 0 };
  const tryAt = (y) => {
    ff(['-i', gen, '-vf', `crop=${OUT_W}:${ph}:0:${y}`, mid]);
    const s = ssim(mid, photo);
    if (s > best.score) best = { y, score: s };
  };
  // 一致度は数ピクセルのずれで大きく下がるので、8ピクセルおきに探してから、2ピクセルおきに詰める
  for (let y = 0; y <= OUT_H - ph; y += 8) tryAt(y);
  const c = best.y;
  for (let y = Math.max(0, c - 6); y <= Math.min(OUT_H - ph, c + 6); y += 2) tryAt(y);
  return best;
}

// uprightPath: 正しい向きに直した写真。outPath: できた縦長の画像(jpg、1080x1920)
// mode: gray(上下を灰色にした下絵を渡す。既定) / direct(写真をそのまま渡して縦に広げさせる) / blur(上下をぼかした下絵)
// 戻り値: { usd, model, ssim, outpainted, ok }
async function outpaintVertical({ apiKey, uprightPath, outPath, workDir, dishName = '', mode = 'gray' }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY がありません');
  fs.mkdirSync(workDir, { recursive: true });
  const { width: W, height: H } = probeSize(uprightPath);
  // もともと縦長(9:16に近い)なら、描き足さずに合わせるだけ
  if (H / W >= (OUT_H / OUT_W) * 0.9) {
    ff(['-i', uprightPath, '-vf', `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}`, '-q:v', '2', outPath]);
    return { usd: 0, model: null, ssim: 1, outpainted: false, ok: true };
  }
  const ph = Math.min(OUT_H, Math.round((OUT_W * H) / W / 2) * 2);
  const y0c = Math.round((OUT_H - ph) / 2 / 2) * 2;
  const photo = path.join(workDir, 'op_photo.png');
  ff(['-i', uprightPath, '-vf', `scale=${OUT_W}:${ph}`, photo]);

  const scene = `a real photo${dishName ? ` of the dish "${dishName}"` : ''} taken in a warm, dimly lit restaurant bar`;
  const rules = `Seamlessly match the photo's perspective, lighting, colors, grain and depth of field so there is no visible border or line: continue the same table surface and the rest of the plate/board if it is cut off, and above it the softly blurred interior of the same bar in the background. Do not add any new food, dishes, garnish, people, hands, text, logos or watermarks.`;
  let input;
  let prompt;
  if (mode === 'direct') {
    input = path.join(workDir, 'op_input.jpg');
    ff(['-i', uprightPath, '-vf', 'scale=1600:-2', '-q:v', '2', input]);
    prompt = `This is ${scene}. Extend (outpaint) it into a vertical 9:16 image: keep the whole photo unchanged at full width in the middle, and add new content above and below it. ${rules} Do not redraw, move, crop or zoom the original photo.`;
  } else {
    input = path.join(workDir, 'op_canvas.jpg');
    const bg = mode === 'blur' ? `[0:v]scale=${OUT_W}:${OUT_H},boxblur=40:3,eq=brightness=-0.08[bg]` : `color=c=0x808080:s=${OUT_W}x${OUT_H}[bg]`;
    ff(['-i', uprightPath, '-i', photo, '-filter_complex', `${bg};[bg][1:v]overlay=0:${y0c}`, '-frames:v', '1', '-q:v', '2', input]);
    prompt = `This is a vertical 9:16 canvas. The horizontal band in the middle is ${scene}. The ${mode === 'blur' ? 'blurry' : 'flat gray'} areas above and below it are empty and must be filled (outpainting).
Fill ONLY those areas with a natural, photorealistic continuation of the same scene. ${rules}
Keep the middle photo exactly as it is, in exactly the same position and size: do not move, redraw, restyle, crop or zoom it.`;
  }
  const r = await callImageModel(apiKey, input, prompt);
  const genRaw = path.join(workDir, 'op_gen_raw' + (r.mime && r.mime.includes('png') ? '.png' : '.jpg'));
  fs.writeFileSync(genRaw, r.buffer);
  const gen = path.join(workDir, 'op_gen.png');
  ff(['-i', genRaw, '-vf', `scale=${OUT_W}:${OUT_H}`, gen]);

  // 写真がどこにあるか(ずれていないか)を確かめる。下絵の形なら真ん中のはず
  const found = mode === 'direct' ? findPhoto(gen, photo, ph, workDir) : { y: y0c, score: ssim((ff(['-i', gen, '-vf', `crop=${OUT_W}:${ph}:0:${y0c}`, path.join(workDir, 'op_gen_mid.png')]), path.join(workDir, 'op_gen_mid.png')), photo) };
  const ok = found.score >= MIN_SSIM;
  if (ok) pasteBack(gen, photo, found.y, ph, outPath);
  else ff(['-i', gen, '-q:v', '2', outPath]);
  return { usd: USD_PER_IMAGE, model: r.model, mode, ssim: found.score, photoY: found.y, outpainted: true, minSsim: MIN_SSIM, ok };
}

module.exports = { outpaintVertical, USD_PER_IMAGE, MIN_SSIM };

// 単体で試す: node src/outpaint.js <写真> <出力フォルダ>  (OUTPAINT_MODES=gray,direct のように、試す形をカンマで)
if (require.main === module) {
  (async () => {
    const [src, outDir] = process.argv.slice(2);
    const modes = (process.env.OUTPAINT_MODES || 'gray').split(',').map((s) => s.trim()).filter(Boolean);
    const upright = path.join(outDir, 'upright.jpg');
    fs.mkdirSync(outDir, { recursive: true });
    ff(['-i', src, '-q:v', '2', upright]); // ffmpeg はEXIFの向きを自動で直す
    const results = [];
    for (const mode of modes) {
      const workDir = path.join(outDir, mode);
      try {
        const r = await outpaintVertical({ apiKey: process.env.GEMINI_API_KEY, uprightPath: upright, outPath: path.join(workDir, 'start.jpg'), workDir, dishName: process.env.DISH_NAME || '', mode });
        console.log(JSON.stringify(r));
        results.push(r);
      } catch (e) {
        console.error(`${mode}: ${e.message}`);
        results.push({ mode, error: e.message });
      }
    }
    fs.writeFileSync(path.join(outDir, 'outpaint-result.json'), JSON.stringify(results, null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
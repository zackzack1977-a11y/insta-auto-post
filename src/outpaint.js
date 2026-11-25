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
const FEATHER = 48; // 貼り戻すときの、つなぎ目のぼかし(ピクセル)
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

// uprightPath: 正しい向きに直した写真。outPath: できた縦長の画像(jpg、1080x1920)
// 戻り値: { usd, model, ssim, outpainted(描き足したか) }
async function outpaintVertical({ apiKey, uprightPath, outPath, workDir, dishName = '' }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY がありません');
  fs.mkdirSync(workDir, { recursive: true });
  const { width: W, height: H } = probeSize(uprightPath);
  // もともと縦長(9:16に近い)なら、描き足さずに合わせるだけ
  if (H / W >= (OUT_H / OUT_W) * 0.9) {
    ff(['-i', uprightPath, '-vf', `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}`, '-q:v', '2', outPath]);
    return { usd: 0, model: null, ssim: 1, outpainted: false };
  }
  const ph = Math.min(OUT_H, Math.round((OUT_W * H) / W / 2) * 2);
  const y0 = Math.round((OUT_H - ph) / 2 / 2) * 2;
  const photo = path.join(workDir, 'op_photo.png');
  ff(['-i', uprightPath, '-vf', `scale=${OUT_W}:${ph}`, photo]);

  // 下絵: 上下は写真を引き伸ばして強くぼかし、少し暗くしたもの
  const canvas = path.join(workDir, 'op_canvas.jpg');
  ff(['-i', uprightPath, '-i', photo, '-filter_complex', `[0:v]scale=${OUT_W}:${OUT_H},boxblur=40:3,eq=brightness=-0.08[bg];[bg][1:v]overlay=0:${y0}`, '-q:v', '2', canvas]);

  const prompt = `This is a vertical 9:16 canvas. The sharp horizontal band in the middle is a real photo${dishName ? ` of the dish "${dishName}"` : ''} taken in a warm, dimly lit restaurant bar. The blurry areas above and below it are placeholders.
Replace ONLY the blurry top and bottom areas with a natural, photorealistic continuation of the same scene, seamlessly matching the photo's perspective, lighting, colors, grain and depth of field: continue the same table surface, the rest of the plate/board if it is cut off, and above it the softly blurred interior of the same bar in the background.
Keep the middle photo exactly as it is, in exactly the same position and size: do not move, redraw, restyle, crop or zoom it. Do not add any new food, dishes, garnish, people, hands, text, logos or watermarks.`;
  const r = await callImageModel(apiKey, canvas, prompt);
  const genRaw = path.join(workDir, 'op_gen_raw' + (r.mime && r.mime.includes('png') ? '.png' : '.jpg'));
  fs.writeFileSync(genRaw, r.buffer);
  const gen = path.join(workDir, 'op_gen.png');
  ff(['-i', genRaw, '-vf', `scale=${OUT_W}:${OUT_H}`, gen]);

  // 写真の位置がずれていないか(描き足した絵の真ん中と、元の写真を比べる)
  const genMid = path.join(workDir, 'op_gen_mid.png');
  ff(['-i', gen, '-vf', `crop=${OUT_W}:${ph}:0:${y0}`, genMid]);
  const score = ssim(genMid, photo);

  // 真ん中は元の写真を貼り戻す(上下のふちだけ少しぼかしてなじませる)
  const fe = Math.min(FEATHER, Math.floor(ph / 4));
  ff([
    '-i', gen, '-i', photo, '-filter_complex',
    `[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,min(Y,H-1-Y)/${fe})'[p];[0:v][p]overlay=0:${y0},format=yuvj420p`,
    '-q:v', '2', outPath,
  ]);
  return { usd: USD_PER_IMAGE, model: r.model, ssim: score, outpainted: true, minSsim: MIN_SSIM, ok: score >= MIN_SSIM, canvas, gen };
}

module.exports = { outpaintVertical, USD_PER_IMAGE, MIN_SSIM };

// 単体で試す: node src/outpaint.js <写真> <出力.jpg>
if (require.main === module) {
  (async () => {
    const [src, out] = process.argv.slice(2);
    const workDir = path.join(path.dirname(out), 'outpaint-work');
    const upright = path.join(workDir, 'upright.jpg');
    fs.mkdirSync(workDir, { recursive: true });
    ff(['-i', src, '-q:v', '2', upright]); // ffmpeg はEXIFの向きを自動で直す
    const r = await outpaintVertical({ apiKey: process.env.GEMINI_API_KEY, uprightPath: upright, outPath: out, workDir, dishName: process.env.DISH_NAME || '' });
    console.log(JSON.stringify({ ...r, canvas: undefined, gen: undefined }));
    fs.writeFileSync(path.join(path.dirname(out), 'outpaint-result.json'), JSON.stringify(r, null, 2));
    if (r.outpainted && !r.ok) process.exitCode = 2;
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

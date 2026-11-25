// 動画の作り直しの見本づくり(2026-11-25、たけしさんの承認のうえ)。
// 上下を描き足した縦長の画像(remake-samples/<名前>/start.jpg)から、Geminiで動きの違う動画を数本作り、
// つないで1本の見本にする。videos/ には入れない(見本なので、作り置き・投稿には使わない)。
// 結果は generated/remake/ に置き、GitHub Actions の artifact で持ち帰る。費用は cost.json に残す。
//
// 環境変数: GEMINI_API_KEY, SAMPLE(remake-samples の中のフォルダ名), DURATION_SEC(1本の秒数、既定8),
//           ONLY(作る場面のidをカンマ区切り。空なら全部), MONTHLY_CAP_USD(既定15。今月の作り置きの合計と合わせて超えるなら作らない)
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT } = require('./shared');
const { generateOmniVideo, estimateUsd } = require('./gemini-video');

const env = process.env;
const SAMPLE = env.SAMPLE || 'ebi';
const SEC = Math.min(15, Math.max(3, parseInt(env.DURATION_SEC, 10) || 8));
const CAP = Number(env.MONTHLY_CAP_USD) > 0 ? Number(env.MONTHLY_CAP_USD) : 15;
const SRC_DIR = path.join(ROOT, 'remake-samples', SAMPLE);
const OUT_DIR = path.join(ROOT, 'generated', 'remake', SAMPLE);
const LOG_FILE = path.join(ROOT, 'data', 'video-gen-log.json');

function monthJst(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(d);
}
function ff(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}
function sceneCuts(file) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

async function main() {
  const only = (env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const shots = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'shots.json'), 'utf8')).filter((s) => only.length === 0 || only.includes(s.id));
  const start = path.join(SRC_DIR, 'start.jpg');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
  const spent = log.filter((e) => monthJst(new Date(e.at)) === monthJst()).reduce((s, e) => s + (e.usd || 0), 0);
  const need = estimateUsd(SEC) * shots.length;
  console.log(`今月の動画代: $${spent.toFixed(2)}、今回の見込み: $${need.toFixed(2)}、上限: $${CAP}`);
  if (spent + need > CAP) throw new Error('今月の上限を超えるので作りません');

  const cost = [];
  const clips = [];
  for (const shot of shots) {
    const out = path.join(OUT_DIR, `${shot.id}.mp4`);
    console.log(`\n--- ${shot.id}: ${shot.label}\n${shot.prompt}`);
    const rec = { at: new Date().toISOString(), photo: `remake-sample:${SAMPLE}:${shot.id}`, seconds: SEC, usd: estimateUsd(SEC), result: 'sample' };
    try {
      const r = await generateOmniVideo({ apiKey: env.GEMINI_API_KEY, imagePath: start, prompt: shot.prompt, seconds: SEC, outPath: out });
      rec.interactionId = r.interactionId;
      const cuts = sceneCuts(out);
      console.log(`できました。場面の切り替わり: ${cuts.length ? cuts.map((t) => t.toFixed(2)).join(', ') + '秒' : 'なし'}`);
      rec.cuts = cuts;
      clips.push({ shot, file: out });
    } catch (e) {
      rec.result = 'error';
      rec.reason = e.message.slice(0, 300);
      if (e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429) rec.usd = 0;
      console.error('失敗: ' + e.message);
    }
    cost.push(rec);
    fs.writeFileSync(path.join(OUT_DIR, 'cost.json'), JSON.stringify(cost, null, 2) + '\n');
  }

  // 1本ずつ、そろった形(1080x1920、30コマ、音なし)に直してから、0.5秒の重ね合わせでつなぐ
  const norm = clips.map((c) => {
    const f = c.file.replace(/\.mp4$/, '_n.mp4');
    ff(['-i', c.file, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', f]);
    return f;
  });
  if (norm.length >= 2) {
    const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
    const inputs = norm.flatMap((f) => ['-i', f]);
    let chain = '';
    let last = '[0:v]';
    let offset = 0;
    for (let i = 1; i < norm.length; i += 1) {
      offset += dur(norm[i - 1]) - 0.5;
      const label = i === norm.length - 1 ? '[v]' : `[x${i}]`;
      chain += `${last}[${i}:v]xfade=transition=fade:duration=0.5:offset=${offset.toFixed(2)}${label};`;
      last = label;
    }
    ff([...inputs, '-filter_complex', chain.replace(/;$/, ''), '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT_DIR, 'joined.mp4')]);
    console.log('つないだ見本: ' + path.join(OUT_DIR, 'joined.mp4'));
  }
  const failed = cost.filter((c) => c.result === 'error');
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Genspark等で作った動画の、機械で分かる崩れのチェック(2026-10-16追加)。
// 「マッシュルームとベーコンのパスタ」の動画が、5秒目で別の料理の場面に切り替わり、
// 前半も引き伸ばされていたのに、そのままpush・投稿されてしまったことを受けて作った。
//
// 見ること: 縦9:16か / 長さ(8〜12秒) / 途中で場面が切り替わっていないか(冒頭0.5秒は除く)。
// あわせて、目で見比べるための1枚絵(1秒ごとのコマを並べた画像)を generated/check/ に作る。
// お皿の形が違う・写っていない物が出る、などは機械では分からないので、
// 1枚絵と元の写真を見比べて判断する(genspark-prompt-template.mdの「できた動画のチェック」)。
//
// 使い方: node src/check-video.js <動画のパス> [写真のパス]
// 結果: 1行目に OK か NG、続けて理由。NGのときは終了コード1。

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHECK_DIR = path.join(ROOT, 'generated', 'check');
const SCENE_THRESHOLD = 0.3;

function findTool(name) {
  // PATHに無い環境(タスクスケジューラから動くWindows)のために、wingetの置き場所も探す
  const candidates = [name];
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(winget)) {
    for (const pkg of fs.readdirSync(winget).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      const pkgDir = path.join(winget, pkg);
      for (const build of fs.readdirSync(pkgDir)) {
        const exe = path.join(pkgDir, build, 'bin', name + '.exe');
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    }
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch (e) {
      // 次の候補へ
    }
  }
  throw new Error(name + 'が見つかりません');
}

const videoPath = process.argv[2];
const photoPath = process.argv[3];
if (!videoPath || !fs.existsSync(videoPath)) {
  console.log('NG');
  console.log('動画が見つかりません: ' + videoPath);
  process.exit(1);
}

const ffmpeg = findTool('ffmpeg');
const ffprobe = findTool('ffprobe');
const problems = [];

const info = JSON.parse(execFileSync(ffprobe, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:format=duration',
  '-of', 'json', videoPath,
]).toString());
const { width, height } = info.streams[0];
const duration = Number(info.format.duration);

if (Math.abs(width / height - 9 / 16) > 0.02) problems.push(`縦9:16ではない(${width}x${height})`);
if (duration < 8 || duration > 12) problems.push(`長さが10秒前後ではない(${duration.toFixed(1)}秒)`);

// showinfoの結果はstderrに出る
const sceneOutput = spawnSync(ffmpeg, ['-hide_banner', '-i', videoPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-']).stderr.toString();
const cuts = [...sceneOutput.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.5);
if (cuts.length > 0) problems.push(`途中で場面が切り替わっている(${cuts.map((t) => t.toFixed(1) + '秒').join('、')})`);

fs.mkdirSync(CHECK_DIR, { recursive: true });
const base = path.basename(videoPath, path.extname(videoPath));
const sheetPath = path.join(CHECK_DIR, base + '_コマ.png');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', videoPath, '-vf', 'fps=1,scale=240:-1,tile=5x2', '-frames:v', '1', sheetPath]);

console.log(problems.length === 0 ? 'OK' : 'NG');
for (const p of problems) console.log('・' + p);
console.log('見比べ用の1枚絵: ' + sheetPath);
if (photoPath) console.log('元の写真: ' + photoPath + '(お皿の形・料理・写っていない物・ゆがみを見比べる)');
process.exit(problems.length === 0 ? 0 : 1);

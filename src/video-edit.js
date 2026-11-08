// 投稿する動画の仕上げ(文字入れ・BGM合成・表紙のコマ選び)。
// post.js(本番)と preview-video.js(手元での試し)の両方から使う。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ACCESS_TEXT = '富士駅から徒歩10分';

// 日本語の太字フォント。GitHub Actions(Ubuntu)は fonts-noto-cjk、手元のWindowsは游ゴシック等。
const FONT_CANDIDATES = [
  process.env.OVERLAY_FONT,
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf',
  'C:/Windows/Fonts/BIZ-UDGothicB.ttc',
  'C:/Windows/Fonts/YuGothB.ttc',
].filter(Boolean);

function findFont() {
  const found = FONT_CANDIDATES.find((f) => fs.existsSync(f));
  if (!found) throw new Error('文字入れ用の日本語フォントが見つかりません: ' + FONT_CANDIDATES.join(', '));
  return found;
}

// ffmpegのフィルタの中に書くパスは「:」や「\」を逃がす必要がある。
function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// 料理名を1〜2行に分ける。9文字以下は1行。長い名前は真ん中に近い「の」「と」「・」の後ろで切る。
function splitTitle(name) {
  const chars = [...name];
  if (chars.length <= 9) return [name];
  const mid = chars.length / 2;
  let best = -1;
  let bestDist = Infinity;
  chars.forEach((c, i) => {
    if ('のと・&'.includes(c) && i > 1 && i < chars.length - 2) {
      const dist = Math.abs(i + 1 - mid);
      if (dist < bestDist) {
        best = i + 1;
        bestDist = dist;
      }
    }
  });
  if (best < 0 || bestDist > chars.length / 4) best = Math.ceil(mid);
  return [chars.slice(0, best).join(''), chars.slice(best).join('')];
}

function probe(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', videoPath,
  ]).toString();
  const json = JSON.parse(out);
  const duration = parseFloat(json.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`動画の長さを取得できませんでした。動画ファイルが壊れている可能性があります: ${videoPath}`);
  }
  return { width: json.streams[0].width, height: json.streams[0].height, duration };
}

// 動画の上に、料理名(大きく)と「富士駅から徒歩10分」(小さく)を入れるフィルタを作る。
// 位置は上から17%あたり。プロフィールの一覧(縦3:4で上下が切られる)でも切れず、
// リールの下側のボタンや説明文とも重ならない場所。文字の後ろに薄い黒の帯を敷いて読みやすくする。
// 文字はファイル経由で渡す(日本語や記号をフィルタの中に直接書くと、逃がし方で崩れるため)。
function buildOverlayFilter(dishName, { width, height }, workDir) {
  const font = filterPath(findFont());
  const lines = splitTitle(dishName);
  const maxLen = Math.max(...lines.map((l) => [...l].length));
  const titleSize = Math.round(Math.min(width * 0.12, (width * 0.86) / maxLen));
  const subSize = Math.round(width * 0.05);
  const lineGap = Math.round(titleSize * 0.25);
  const top = Math.round(height * 0.17);
  const pad = Math.round(titleSize * 0.35);
  const subTop = top + lines.length * titleSize + (lines.length - 1) * lineGap + Math.round(subSize * 0.7);
  const bandTop = top - pad;
  const bandHeight = subTop + subSize + pad - bandTop;

  fs.mkdirSync(workDir, { recursive: true });
  const parts = [`drawbox=x=0:y=${bandTop}:w=iw:h=${bandHeight}:color=black@0.38:t=fill`];
  const common = `fontfile='${font}':fontcolor=white:borderw=3:bordercolor=black@0.55:shadowcolor=black@0.5:shadowx=2:shadowy=2`;
  lines.forEach((line, i) => {
    const file = path.join(workDir, `overlay_title_${i}.txt`);
    fs.writeFileSync(file, line, 'utf8');
    const y = top + i * (titleSize + lineGap);
    parts.push(`drawtext=${common}:textfile='${filterPath(file)}':fontsize=${titleSize}:x=(w-text_w)/2:y=${y}`);
  });
  const subFile = path.join(workDir, 'overlay_sub.txt');
  fs.writeFileSync(subFile, ACCESS_TEXT, 'utf8');
  parts.push(`drawtext=fontfile='${font}':fontcolor=white@0.95:borderw=2:bordercolor=black@0.5:textfile='${filterPath(subFile)}':fontsize=${subSize}:x=(w-text_w)/2:y=${subTop}`);
  return parts.join(',');
}

// 文字入れ・BGM合成・映像の作り直しを、1回のエンコードでまとめて行う。
// 映像の作り直し: 2026-10-16、Gensparkの出力の作りが変わり(作成ソフトの表記が「ISO Media file produced
// by Google」、色の情報にsRGB用の値)、そのままコピーして投稿したらInstagram側で下半分がノイズに崩れた。
// Instagramの推奨どおりの、ごく普通のH.264(BT.709、1秒ごとの区切りのコマ、先頭にファイル情報)にそろえる。
// BGM: 音声は差し替え。BGMの方が短いときのために無限ループさせ、映像の長さ(-shortest)で切る。
function renderFinalVideo(inputVideoPath, musicPath, outputPath, { dishName, workDir } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const info = probe(inputVideoPath);
  const fadeStart = Math.max(info.duration - 1, 0);
  const vf = dishName ? ['-vf', buildOverlayFilter(dishName, info, workDir || path.dirname(outputPath))] : [];

  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...vf,
    '-c:v', 'libx264',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.0',
    '-g', '24',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-ar', '48000',
    '-af', `afade=t=out:st=${fadeStart}:d=1`,
    '-shortest',
    outputPath,
  ], { stdio: 'inherit' });
}

// 表紙のコマ選び。動画の中から6コマを切り出し、AI(Claude)に「一番おいしそうに見えるコマ」を選ばせる。
// 戻り値は {offsetMs, framePath}。AIが使えない・答えが変なときは1秒目にする(投稿は止めない)。
async function pickCoverFrame(videoPath, workDir, { apiKey, dishName } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const { duration } = probe(videoPath);
  const count = 6;
  const times = Array.from({ length: count }, (_, i) => +(0.8 + (i * (duration - 1.6)) / (count - 1)).toFixed(2));
  const frames = times.map((t, i) => {
    const p = path.join(workDir, `cover_candidate_${i + 1}.jpg`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=360:-1', '-q:v', '3', p]);
    return p;
  });

  let chosen = 0;
  if (apiKey) {
    try {
      const content = [];
      frames.forEach((p, i) => {
        content.push({ type: 'text', text: `候補${i + 1}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(p).toString('base64') } });
      });
      content.push({
        type: 'text',
        text: `これは飲食店のInstagramリール「${dishName || '料理'}」の動画から切り出した${count}コマです。` +
          'プロフィールの一覧に並ぶ表紙として、料理が一番おいしそうに見えて、ピントが合っていて、料理がよく分かるコマを1つ選んでください。' +
          `答えは候補の番号(1〜${count})の数字だけを書いてください。`,
      });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content }] }),
      });
      const json = await res.json();
      const n = parseInt(String(json?.content?.[0]?.text || '').match(/\d+/)?.[0], 10);
      if (res.ok && n >= 1 && n <= count) chosen = n - 1;
      else console.warn('表紙のコマ選びで想定外の答え。1枚目を使います: ' + JSON.stringify(json).slice(0, 300));
    } catch (e) {
      console.warn('表紙のコマ選びに失敗。1枚目を使います: ' + e.message);
    }
  }
  console.log(`表紙のコマ: 候補${chosen + 1}(${times[chosen]}秒目)`);
  return { offsetMs: Math.round(times[chosen] * 1000), framePath: frames[chosen], candidates: frames };
}

module.exports = { renderFinalVideo, pickCoverFrame, splitTitle, probe };

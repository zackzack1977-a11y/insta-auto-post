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

// 料理名を1〜2行に分ける。9文字以下は1行。
// 「|」が入っていれば、そこで切る(手で切れ目を指定したいとき用)。
// それ以外は、真ん中に近い言葉の切れ目で切る。切れ目は「の」「と」「・」の後ろと、よく出る料理の言葉の前。
const BREAK_BEFORE_WORDS = ['バルサミコ', 'ソース', 'クリーム', 'サラダ', 'パスタ', 'スパ', 'アヒージョ', 'チーズ', 'マスタード',
  'トマト', 'ガーリック', 'ステーキ', 'グリル', 'ソテー', 'カルパッチョ', 'リゾット', 'ピザ', 'フライ', 'ロースト', '刺身', '焼き', '煮込み', '赤身'];

function splitTitle(name) {
  if (name.includes('|')) return name.split('|').slice(0, 2).map((s) => s.trim());
  const chars = [...name];
  if (chars.length <= 9) return [name];
  const cuts = new Set();
  chars.forEach((c, i) => { if ('のと・&'.includes(c)) cuts.add(i + 1); });
  BREAK_BEFORE_WORDS.forEach((w) => {
    let at = name.indexOf(w, 1);
    while (at > 0) {
      cuts.add([...name.slice(0, at)].length);
      at = name.indexOf(w, at + 1);
    }
  });
  const mid = chars.length / 2;
  let best = -1;
  let bestDist = Infinity;
  cuts.forEach((k) => {
    if (k < 2 || k > chars.length - 2) return;
    const dist = Math.abs(k - mid);
    if (dist < bestDist) {
      best = k;
      bestDist = dist;
    }
  });
  if (best < 0 || bestDist > chars.length / 3) best = Math.ceil(mid);
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

// ---- デザイン案(2026-11-08、試作中)。フォントはどれもSIL Open Font License(商用可・同梱可)。----
// フォントの置き場は OVERLAY_FONT_DIR(なければリポジトリの fonts/)。
const STYLE_FONTS = {
  mincho: { title: 'ZenOldMincho-Bold.ttf', sub: 'ZenOldMincho-Bold.ttf', accent: 'PlayfairDisplay-Italic.ttf' },
  hand: { title: 'KleeOne-SemiBold.ttf', sub: 'KleeOne-SemiBold.ttf', accent: 'GreatVibes-Regular.ttf' },
  label: { title: 'ZenMaruGothic-Bold.ttf', sub: 'ZenMaruGothic-Bold.ttf' },
};

function styleFont(file) {
  const dir = process.env.OVERLAY_FONT_DIR || path.join(__dirname, '..', 'fonts');
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new Error('デザイン用のフォントが見つかりません: ' + p);
  return filterPath(p);
}

// start秒から dur秒かけて、ふわっと出る(透明→不透明)
const fadeIn = (start, dur = 0.7) => `alpha='if(lt(t,${start}),0,min(1,(t-${start})/${dur}))'`;
// 出るときに、rise ピクセル下から定位置まで上がる
const riseY = (y, start, rise = 16, dur = 0.8) => `y='${y}+${rise}*(1-min(1,max(0,(t-${start})/${dur})))'`;

// 白いお皿など明るい背景でも読めるように、文字の後ろに「にじみ」を敷いてから文字を描く(2026-11-08、たけしさんの希望)。
// にじみ: 太い薄墨のふち(外側)→少し細い濃いめのふち、の2枚を重ね、ぼかしたように見せる。その上に文字と小さな影。
function pushWithHalo(parts, base, color, halo) {
  parts.push(`drawtext=${base}:fontcolor=black@0.18:borderw=${halo * 2}:bordercolor=black@0.18`);
  parts.push(`drawtext=${base}:fontcolor=black@0.3:borderw=${halo}:bordercolor=black@0.3`);
  parts.push(`drawtext=${base}:fontcolor=${color}:shadowcolor=black@0.6:shadowx=2:shadowy=2`);
}

// 帯の上下の端をぼかす(何本かの薄い帯を重ねて、グラデーションのように見せる)
function softBand(top, height, alpha) {
  const parts = [`drawbox=x=0:y=${top}:w=iw:h=${height}:color=black@${alpha}:t=fill`];
  const steps = 20;
  const s = 3;
  for (let i = 0; i < steps; i += 1) {
    const a = (alpha * (1 - (i + 1) / (steps + 1))).toFixed(3);
    parts.push(`drawbox=x=0:y=${top - s * (i + 1)}:w=iw:h=${s}:color=black@${a}:t=fill`);
    parts.push(`drawbox=x=0:y=${top + height + s * i}:w=iw:h=${s}:color=black@${a}:t=fill`);
  }
  return parts;
}

function buildStyledOverlay(style, dishName, { width, height }, workDir) {
  const f = STYLE_FONTS[style];
  if (!f) throw new Error('知らないデザイン名: ' + style);
  fs.mkdirSync(workDir, { recursive: true });
  const write = (name, text) => {
    const p = path.join(workDir, `overlay_${name}.txt`);
    fs.writeFileSync(p, text, 'utf8');
    return filterPath(p);
  };
  const lines = splitTitle(dishName);
  const maxLen = Math.max(...lines.map((l) => [...l].length));
  const titleSize = Math.round(Math.min(width * 0.115, (width * 0.84) / maxLen));
  const lineGap = Math.round(titleSize * 0.22);
  const top = Math.round(height * 0.17);
  const parts = [];

  if (style === 'mincho' || style === 'hand') {
    const accentText = style === 'mincho' ? 'Food & Bar Zack' : "Today's Special";
    const accentSize = Math.round(width * (style === 'mincho' ? 0.056 : 0.09));
    const accentColor = style === 'mincho' ? '0xE8D9B5' : '0xF3D9A4';
    const titleTop = top + Math.round(accentSize * 1.35);
    const titleBottom = titleTop + lines.length * titleSize + (lines.length - 1) * lineGap;
    const ruleY = titleBottom + Math.round(width * 0.03);
    const subSize = Math.round(width * 0.042);
    const subTop = ruleY + Math.round(width * 0.03);
    const bandTop = top - Math.round(width * 0.04);
    parts.push(...softBand(bandTop, subTop + subSize + Math.round(width * 0.04) - bandTop, style === 'mincho' ? 0.34 : 0.3));
    pushWithHalo(parts, `fontfile='${styleFont(f.accent)}':textfile='${write('accent', accentText)}':fontsize=${accentSize}:x=(w-text_w)/2:y=${top}:${fadeIn(0.2)}`, accentColor, Math.max(2, Math.round(accentSize * 0.08)));
    lines.forEach((line, i) => {
      const y = titleTop + i * (titleSize + lineGap);
      pushWithHalo(parts, `fontfile='${styleFont(f.title)}':textfile='${write('title' + i, line)}':fontsize=${titleSize}:x=(w-text_w)/2:${riseY(y, 0.45 + i * 0.12)}:${fadeIn(0.45 + i * 0.12, 0.8)}`, 'white', Math.max(3, Math.round(titleSize * 0.08)));
    });
    const ruleW = Math.round(width * 0.16);
    parts.push(`drawbox=x=(iw-${ruleW})/2:y=${ruleY}:w=${ruleW}:h=2:color=${accentColor}@0.9:t=fill:enable='gte(t,0.9)'`);
    pushWithHalo(parts, `fontfile='${styleFont(f.sub)}':textfile='${write('sub', ACCESS_TEXT)}':fontsize=${subSize}:x=(w-text_w)/2:y=${subTop}:${fadeIn(1.0)}`, 'white', Math.max(2, Math.round(subSize * 0.12)));
  } else {
    // label: 白い札に料理名(こげ茶)、その下に赤い小さな札で「富士駅から徒歩10分」。左から滑り込む。
    const pad = Math.round(titleSize * 0.28);
    const subSize = Math.round(width * 0.04);
    lines.forEach((line, i) => {
      const y = top + i * (titleSize + pad * 2 + 6);
      const start = 0.3 + i * 0.15;
      parts.push(`drawtext=fontfile='${styleFont(f.title)}':textfile='${write('title' + i, line)}':fontsize=${titleSize}:fontcolor=0x3B2A20:box=1:boxcolor=white@0.92:boxborderw=${pad}:x='(w-text_w)/2-50*(1-min(1,max(0,(t-${start})/0.5)))':y=${y}:${fadeIn(start, 0.5)}`);
    });
    const subTop = top + lines.length * (titleSize + pad * 2 + 6) + Math.round(subSize * 0.5);
    parts.push(`drawtext=fontfile='${styleFont(f.sub)}':textfile='${write('sub', ACCESS_TEXT)}':fontsize=${subSize}:fontcolor=white:box=1:boxcolor=0xB03A2E@0.92:boxborderw=${Math.round(subSize * 0.35)}:x=(w-text_w)/2:y=${subTop}:${fadeIn(0.9, 0.5)}`);
  }
  return parts.join(',');
}

// 文字入れ・BGM合成・映像の作り直しを、1回のエンコードでまとめて行う。
// 映像の作り直し: 2026-10-16、Gensparkの出力の作りが変わり(作成ソフトの表記が「ISO Media file produced
// by Google」、色の情報にsRGB用の値)、そのままコピーして投稿したらInstagram側で下半分がノイズに崩れた。
// Instagramの推奨どおりの、ごく普通のH.264(BT.709、1秒ごとの区切りのコマ、先頭にファイル情報)にそろえる。
// BGM: 音声は差し替え。BGMの方が短いときのために無限ループさせ、映像の長さ(-shortest)で切る。
// 元の動画の音声の大きさ(平均、dB)。音声が無ければnull。
// Gensparkの動画は、音なしで頼んでも、ほぼ無音(平均-40〜-72dB)の音声が付いてくる。
// Flow(Veo)の動画は、セリフや料理の音が入っている(平均-15〜-20dB)。2026-11-08に測った値。
function meanVolumeDb(videoPath) {
  const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath]).toString().trim();
  if (!hasAudio) return null;
  const r = require('child_process').spawnSync('ffmpeg', ['-v', 'info', '-i', videoPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : null;
}

// これより大きい音が入っている動画は、元の音声を残して、BGMを小さく重ねる。
const KEEP_ORIGINAL_AUDIO_DB = -35;
const BGM_UNDER_VOICE = 0.18; // 元の音声に重ねるときのBGMの大きさ(約-15dB)

function renderFinalVideo(inputVideoPath, musicPath, outputPath, { dishName, workDir, style = 'basic' } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const info = probe(inputVideoPath);
  const fadeStart = Math.max(info.duration - 1, 0);
  const wd = workDir || path.dirname(outputPath);
  let vchain = 'null';
  if (dishName) vchain = style === 'basic' ? buildOverlayFilter(dishName, info, wd) : buildStyledOverlay(style, dishName, info, wd);
  const vol = meanVolumeDb(inputVideoPath);
  const keepOriginal = vol !== null && vol > KEEP_ORIGINAL_AUDIO_DB;
  console.log(`元の音声: ${vol === null ? 'なし' : vol + 'dB'} → ${keepOriginal ? '元の音声を残してBGMを小さく重ねる' : 'BGMだけにする'}`);
  const achain = keepOriginal
    ? `[1:a]atrim=0:${info.duration},volume=${BGM_UNDER_VOICE}[bgm];[0:a][bgm]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${fadeStart}:d=1[a]`
    : `[1:a]atrim=0:${info.duration},afade=t=out:st=${fadeStart}:d=1[a]`;
  // くり返し流すBGMは、動画の長さで必ず切る。-shortestだけだと、フィルタを通した音声では止まらないことがあり、
  // 2026-11-08、GitHubの上で出力が無限に伸びて容量があふれた。念のため -t でも長さを決める。

  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-filter_complex', `[0:v]${vchain}[v];${achain}`,
    '-map', '[v]',
    '-map', '[a]',
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
    '-t', String(info.duration),
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

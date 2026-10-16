// 公開後の見え方チェック(2026-10-16追加)。
// たけしさんがLINEの「投稿する」を押したかどうかを、Instagramのコンテナの状態(PUBLISHED)で見つけ、
// Instagramが作り直した「実際に公開されている動画」を取り寄せて、こちらが渡した動画と見比べる。
// 崩れていれば(画面の一部がノイズになっている等)、たけしさんのLINEにすぐ知らせる。
//
// 背景: 10/16、手元とLINEでは正常な動画が、Instagramに上がると下半分がピンク・緑のノイズに崩れた。
// 公開前(下書き)の段階では、Instagramが作り直した後の動画は取り出せないので、公開直後に確かめる。
//
// GitHub Actions(verify-published.yml)で10分おきに動く。確認待ちの投稿が無ければ、すぐ終わる。
// 一致度(SSIM)は、1.0が完全に同じ。普通の作り直しなら0.9前後。崩れると大きく下がる。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, loadPostedList, savePostedList } = require('./shared');

const { INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ACCESS_TOKEN, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID } = process.env;
const GRAPH = 'https://graph.facebook.com/v21.0';
const WATCH_HOURS = 30; // LINEで提示してから、この時間のあいだだけ見張る(リンクの期限は23時間)
const SSIM_AVG_MIN = 0.8;
const SSIM_FRAME_MIN = 0.6;

async function graph(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const res = await fetch(`${GRAPH}/${pathAndQuery}${sep}access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function sendLine(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    console.warn('LINEの設定が無いため、知らせを送れません: ' + text);
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: Buffer.from(JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text }] }), 'utf8'),
  });
  if (!res.ok) console.warn('LINEの送信に失敗: ' + (await res.text()));
}

// こちらが渡した動画(BGM合成後)を、gitの履歴から取り出す。投稿後に生成ファイルは消しているが、履歴には残っている
function extractUploadedVideo(photo, outPath) {
  const videoName = path.parse(photo).name + '.mp4';
  const sha = execFileSync('git', ['log', '--format=%H', '-n', '1', '--fixed-strings', '--grep', `動画にBGMを合成: ${videoName}`], { cwd: ROOT }).toString().trim();
  if (!sha) return false;
  fs.writeFileSync(outPath, execFileSync('git', ['show', `${sha}:generated/${videoName}`], { cwd: ROOT, maxBuffer: 200 * 1024 * 1024 }));
  return true;
}

function compare(igPath, srcPath) {
  // 両方を同じ大きさにそろえて、コマごとの一致度(SSIM)を出す
  const statsFile = path.join(os.tmpdir(), 'ssim-stats.txt');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', igPath, '-i', srcPath, '-lavfi',
    `[0:v]scale=360:640,setsar=1,fps=24[a];[1:v]scale=360:640,setsar=1,fps=24[b];[a][b]ssim=stats_file=${statsFile}`,
    '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = fs.existsSync(statsFile)
    ? fs.readFileSync(statsFile, 'utf8').split('\n').map((l) => /All:([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]))
    : [];
  // 最初と最後の数コマは、作り直しでずれやすいので除く
  const body = frames.length > 10 ? frames.slice(3, -3) : frames;
  const avg = body.length ? body.reduce((a, b) => a + b, 0) / body.length : 0;
  const min = body.length ? Math.min(...body) : 0;
  const decodeErrors = spawnSync('ffmpeg', ['-v', 'error', '-i', igPath, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim();
  return { avg, min, count: body.length, decodeErrors, ffmpegOk: r.status === 0 };
}

async function main() {
  const posted = loadPostedList();
  const now = Date.now();
  const targets = posted.filter((e) => e.creationId && e.presentedAt && !e.verified
    && now - Date.parse(e.presentedAt) < WATCH_HOURS * 3600 * 1000);
  if (targets.length === 0) {
    console.log('確認待ちの投稿はありません。');
    return;
  }

  let changed = false;
  for (const entry of targets) {
    const status = await graph(`${entry.creationId}?fields=status_code`).catch((e) => ({ error: e.message }));
    if (status.status_code !== 'PUBLISHED') {
      console.log(`${entry.photo}: まだ公開されていません(${status.status_code || status.error})`);
      continue;
    }

    // 公開された投稿を、提示した時刻より後の動画の中から探す
    const list = await graph(`${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media?fields=id,media_type,media_url,permalink,timestamp&limit=10`);
    const media = (list.data || [])
      .filter((m) => m.media_type === 'VIDEO' && Date.parse(m.timestamp) >= Date.parse(entry.presentedAt) - 60 * 1000)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
    if (!media || !media.media_url) {
      console.log(`${entry.photo}: 公開済みですが、投稿がまだ一覧に出ていません。次回また見ます。`);
      continue;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    const igPath = path.join(tmp, 'instagram.mp4');
    const srcPath = path.join(tmp, 'uploaded.mp4');
    const dl = await fetch(media.media_url);
    fs.writeFileSync(igPath, Buffer.from(await dl.arrayBuffer()));

    let verdict;
    let detail;
    if (!extractUploadedVideo(entry.photo, srcPath)) {
      const decodeErrors = spawnSync('ffmpeg', ['-v', 'error', '-i', igPath, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim();
      verdict = decodeErrors ? 'ng' : 'unknown';
      detail = decodeErrors ? '動画の読み込みでエラーが出ました' : '元の動画が見つからず、見比べはできませんでした';
    } else {
      const c = compare(igPath, srcPath);
      console.log(`${entry.photo}: 一致度 平均${c.avg.toFixed(3)} 最低${c.min.toFixed(3)}(${c.count}コマ)`);
      verdict = c.count > 0 && c.avg >= SSIM_AVG_MIN && c.min >= SSIM_FRAME_MIN && !c.decodeErrors ? 'ok' : 'ng';
      detail = `元の動画との一致度: 平均${(c.avg * 100).toFixed(0)}点・いちばん低いコマ${(c.min * 100).toFixed(0)}点(100点が完全に同じ)`;
    }

    const dish = path.parse(entry.photo).name;
    if (verdict === 'ok') {
      await sendLine(`【公開後のチェック】「${dish}」の公開を確認しました。Instagram上の動画も崩れていません。\n${detail}\n${media.permalink}`);
    } else if (verdict === 'ng') {
      await sendLine(`【公開後のチェック・要対応】「${dish}」は公開されましたが、Instagram上で動画が崩れている可能性があります。\n${detail}\nアプリで確かめて、崩れていたら削除してください。ブレインに「インスタの動画が崩れた」と声をかけてください。\n${media.permalink}`);
    } else {
      await sendLine(`【公開後のチェック】「${dish}」の公開を確認しました(${detail})。\n${media.permalink}`);
    }

    Object.assign(entry, { confirmed: true, verified: verdict, mediaId: media.id, permalink: media.permalink });
    changed = true;
  }

  if (changed) {
    savePostedList(posted);
    const branch = process.env.GITHUB_REF_NAME || 'master';
    execFileSync('git', ['add', 'data/posted.json'], { cwd: ROOT });
    execFileSync('git', ['commit', '-m', '公開後のチェック結果を記録'], { cwd: ROOT });
    execFileSync('git', ['pull', '--rebase', '--autostash', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

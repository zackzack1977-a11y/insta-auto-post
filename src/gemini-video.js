// Gemini API(Interactions API)で、写真から動画を作る(2026-11-10追加)。
// モデルは gemini-omni-1.2-flash。720pで1秒約0.07ドル(無料枠なし)。
// 説明書: https://aistudio.google.com/docs/omni (POST /v1beta/interactions、response_format で縦横比・長さ・解像度を指定)
//
// 鍵(GEMINI_API_KEY)は、ヘッダー x-goog-api-key でだけ渡す(URLに載せない。ログは公開されるため)。
const fs = require('fs');
const https = require('https');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-omni-1.2-flash';
const USD_PER_SECOND_720P = 0.07;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 動画づくりは数分かかることがある。Node の fetch は応答待ちが5分で切れるため、https で長めに待つ。
function postJson(url, body, apiKey, timeoutMs = 20 * 60 * 1000) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-goog-api-key': apiKey },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            // JSONでない応答はそのまま返す
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`応答が${Math.round(timeoutMs / 60000)}分以内に返りませんでした`)));
    req.on('error', reject);
    req.end(data);
  });
}

function findVideoItem(json) {
  for (const step of json?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const item of step.content || []) {
      if (item.type === 'video') return item;
    }
  }
  return null;
}

async function downloadFromUri(uri, apiKey, outPath) {
  const m = uri.match(/files\/([^:/?]+)/);
  if (m) {
    // 準備ができる(ACTIVE)まで待つ
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`${API_BASE}/files/${m[1]}`, { headers: { 'x-goog-api-key': apiKey } });
      const info = await res.json().catch(() => ({}));
      if (info.state === 'ACTIVE' || !info.state) break;
      if (info.state === 'FAILED') throw new Error('動画ファイルの準備に失敗しました(FAILED)');
      await sleep(5000);
    }
  }
  const res = await fetch(uri, { headers: { 'x-goog-api-key': apiKey }, redirect: 'follow' });
  if (!res.ok) throw new Error(`動画のダウンロードに失敗しました: HTTP ${res.status}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// 写真(jpg)と指示文から動画を作り、outPath に保存する。
// 戻り値: { interactionId, seconds, estimatedUsd }
async function generateOmniVideo({ apiKey, imagePath, prompt, seconds = 12, aspectRatio = '9:16', resolution = '720p', outPath }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY がありません');
  const sec = Math.max(3, Math.min(15, Math.round(seconds)));
  const body = {
    model: MODEL,
    input: [
      { type: 'image', data: fs.readFileSync(imagePath).toString('base64'), mime_type: 'image/jpeg' },
      { type: 'text', text: prompt },
    ],
    response_format: { type: 'video', aspect_ratio: aspectRatio, resolution, duration: `${sec}s`, delivery: 'uri' },
  };
  const res = await postJson(`${API_BASE}/interactions`, body, apiKey);
  if (res.status !== 200 || !res.json) {
    const msg = res.json?.error?.message || res.text.slice(0, 500);
    const err = new Error(`Gemini APIのエラー(HTTP ${res.status}): ${msg}`);
    err.httpStatus = res.status;
    throw err;
  }
  const video = findVideoItem(res.json);
  if (!video) {
    throw new Error(`動画が返ってきませんでした(status=${res.json.status}): ${JSON.stringify(res.json).slice(0, 500)}`);
  }
  if (video.data) fs.writeFileSync(outPath, Buffer.from(video.data, 'base64'));
  else if (video.uri) await downloadFromUri(video.uri, apiKey, outPath);
  else throw new Error('動画のデータもURIもありませんでした');
  return { interactionId: res.json.id, seconds: sec, estimatedUsd: estimateUsd(sec) };
}

function estimateUsd(seconds) {
  return Math.round(seconds * USD_PER_SECOND_720P * 100) / 100;
}

module.exports = { generateOmniVideo, estimateUsd, MODEL };

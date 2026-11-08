// post.js と preview-video.js で共通に使う小さな道具。
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./shared');

const MUSIC_DIR = path.join(ROOT, 'music');
const MUSIC_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.wav']);

// ファイル名から料理名を取り出す(「 - コピー」「 (4)」「_2」などの付け足しを外す)。
function dishNameFromFilename(filename) {
  let name = path.parse(filename).name;
  name = name.replace(/\s*-\s*コピー(\s*\(\d+\))?\s*$/i, '');
  name = name.replace(/\s*\(\d+\)\s*$/, '');
  name = name.replace(/\s*[_-]\s*\d+\s*$/, '');
  return name.trim();
}

function pickRandomMusic() {
  const files = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()))
    : [];
  if (files.length === 0) {
    throw new Error('musicフォルダに著作権フリーの音楽ファイル(mp3/mp4/m4a/wav)を入れてください。');
  }
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

module.exports = { dishNameFromFilename, pickRandomMusic };

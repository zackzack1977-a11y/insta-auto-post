#!/usr/bin/env bash
# aptで部品(ffmpegなど)を入れる。使い方: bash scripts/install-apt.sh ffmpeg fonts-noto-cjk
#
# 2026-11-12: GitHubのマシンが使うUbuntuの配布元の控え(azure.archive.ubuntu.com)が
# 名前を引けなくなる障害で、apt-get が20〜45分止まったまま終わったことがある。
# なので、1回ごとに時間で区切り、2回目からは取り先をUbuntu公式の配布元に切り替えて試す。
# 外から実行ファイルを持ち込まず、aptの仕組みの中だけで直す。
set -u

if [ "$#" -eq 0 ]; then
  echo "入れる部品の名前を指定してください" >&2
  exit 2
fi

all_installed() {
  for p in "$@"; do
    dpkg -s "$p" >/dev/null 2>&1 || return 1
  done
  return 0
}

if all_installed "$@"; then
  echo "すでに入っている: $*"
  exit 0
fi

APT_OPTS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)

try_install() {
  timeout 180 sudo apt-get update "${APT_OPTS[@]}" \
    && timeout 420 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_OPTS[@]}" "$@"
}

use_official_mirror() {
  echo "取り先を、Ubuntu公式の配布元(archive.ubuntu.com / security.ubuntu.com)に切り替える"
  for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    [ -f "$f" ] || continue
    sudo sed -i \
      -e 's#mirror+file:/etc/apt/apt-mirrors.txt#http://archive.ubuntu.com/ubuntu/#g' \
      -e 's#http://azure.archive.ubuntu.com/ubuntu/\?#http://archive.ubuntu.com/ubuntu/#g' \
      "$f"
  done
}

for i in 1 2 3; do
  echo "=== ${i}回目: $* を入れる ==="
  if try_install "$@" && all_installed "$@"; then
    echo "入った(${i}回目)"
    exit 0
  fi
  echo "入らなかった(${i}回目)"
  if [ "$i" -eq 1 ]; then use_official_mirror; fi
  sleep 15
done

echo "3回試しても入らなかった" >&2
exit 1

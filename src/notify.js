// たけしさんへの知らせの送り口(2026-11-28、たけしさんの決定)。
// LINEの無料の月の回数が足りないので、既定はDiscord(Zackのボットから、たけしさんへのDM)。
// 送り先は、リポジトリの変数 NOTIFY_CHANNEL(discord / line / both)。作業メニューの
// 「知らせをDiscordにする」「知らせをLINEに戻す」(notify-switch.ps1)が書き換える。line のときは今までどおり。
//
// messages は LINE の形({type:'text', text} / {type:'video', originalContentUrl, previewImageUrl})で渡す。
// Discord には、文字はそのまま、動画はURLを1行で送る(Discordの中で再生できる)。
// 大事: Discordはメッセージの中のURLを自分で開いて見本を作る。投稿の確認リンク(/publish?…)は <> で囲んで、
// 見本づくりを止める(開いただけでは確認の画面が出るだけで、そこで「投稿する」を押したときだけ公開される作り)。
//
// 環境変数: NOTIFY_CHANNEL, LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID, DISCORD_BOT_TOKEN, DISCORD_USER_ID
// 戻り値: { ok: どこか1つにでも届いたか, line, discord, error }
function channel() {
  const c = String(process.env.NOTIFY_CHANNEL || 'line').trim().toLowerCase();
  return ['discord', 'line', 'both'].includes(c) ? c : 'line';
}

async function sendLine(messages) {
  const { LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID } = process.env;
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) return { ok: false, error: 'LINEの設定がありません' };
  for (let i = 0; i < messages.length; i += 5) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: Buffer.from(JSON.stringify({ to: LINE_USER_ID, messages: messages.slice(i, i + 5) }), 'utf8'),
    });
    if (!res.ok) return { ok: false, error: `LINE: HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  }
  return { ok: true };
}

// 確認リンク・Workerのリンクは見本を止める。それ以外のURL(動画など)はそのまま
function guardUrls(text) {
  return String(text).replace(/(?<!<)(https?:\/\/[^\s<>]+)/g, (u) => (/\/publish\?|workers\.dev/.test(u) ? `<${u}>` : u));
}

function toDiscordTexts(messages) {
  const out = [];
  for (const m of messages) {
    if (m.type === 'text') out.push(guardUrls(m.text));
    else if (m.type === 'video') out.push(`🎬 ${m.originalContentUrl}`);
  }
  // Discordは1通2000文字まで
  const chunks = [];
  for (const t of out) {
    for (let i = 0; i < t.length; i += 1900) chunks.push(t.slice(i, i + 1900));
  }
  return chunks;
}

let dmChannelId = null;
async function sendDiscord(messages) {
  const { DISCORD_BOT_TOKEN, DISCORD_USER_ID } = process.env;
  if (!DISCORD_BOT_TOKEN || !DISCORD_USER_ID) return { ok: false, error: 'Discordの設定がありません' };
  const headers = { 'content-type': 'application/json', authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'user-agent': 'DiscordBot (https://localhost, 1.0)' };
  if (!dmChannelId) {
    const res = await fetch('https://discord.com/api/v10/users/@me/channels', { method: 'POST', headers, body: JSON.stringify({ recipient_id: DISCORD_USER_ID }) });
    if (!res.ok) return { ok: false, error: `Discord(DMを開く): HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
    dmChannelId = (await res.json()).id;
  }
  for (const content of toDiscordTexts(messages)) {
    const res = await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, { method: 'POST', headers, body: JSON.stringify({ content }) });
    if (!res.ok) return { ok: false, error: `Discord: HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  }
  return { ok: true };
}

async function notify(messages) {
  const c = channel();
  const r = { ok: false, channel: c };
  const errors = [];
  if (c === 'discord' || c === 'both') {
    r.discord = await sendDiscord(messages).catch((e) => ({ ok: false, error: e.message }));
    if (!r.discord.ok) errors.push(r.discord.error);
  }
  if (c === 'line' || c === 'both') {
    r.line = await sendLine(messages).catch((e) => ({ ok: false, error: e.message }));
    if (!r.line.ok) errors.push(r.line.error);
  }
  r.ok = Boolean((r.discord && r.discord.ok) || (r.line && r.line.ok));
  if (errors.length) {
    r.error = errors.join(' / ');
    console.warn('知らせの送信で失敗: ' + r.error);
  }
  return r;
}

const notifyText = (text) => notify([{ type: 'text', text }]);

module.exports = { notify, notifyText, channel, guardUrls };

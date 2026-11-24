require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Node 22 미만이면 npm 의 node@22 바이너리로 자기 자신을 다시 실행 (음성 DAVE 지원용)
if (+process.versions.node.split('.')[0] < 22 && !process.env.BOT_CHILD) {
  const bin = ['node-linux-x64', 'node'].map(n => path.join(__dirname, 'node_modules', n, 'bin', 'node')).find(fs.existsSync);
  if (bin) {
    console.log(`[boot] Node ${process.version} → node@22 바이너리로 재실행`);
    const child = spawn(bin, [__filename], { stdio: 'inherit', env: { ...process.env, BOT_CHILD: '1' } });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
    child.on('exit', c => process.exit(c ?? 1));
    return;
  }
  console.warn('[boot] node@22 바이너리를 못 찾았어요 (npm install 확인). 현재 Node로 실행합니다.');
}

const {
  Client, GatewayIntentBits: I, Partials, EmbedBuilder, AttachmentBuilder, Collection,
  SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, MessageFlags, Events, AuditLogEvent,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
let V = null;
try { V = require('@discordjs/voice'); }
catch (e) { console.error('[music] 음성 라이브러리 로드 실패 → 음악 기능 비활성화:', e.message); }
// 음량 조절용 (opusscript + prism-media). 없으면 음량 조절 없이 원본 그대로 재생
let prism = null;
try { prism = require('prism-media'); } catch {}
const HAS_OPUS = ['@discordjs/opus', 'opusscript'].some(n => { try { require(n); return true; } catch { return false; } });
const VOL_OK = !!(prism && HAS_OPUS);

const TOKEN = process.env.TOKEN;
const PREFIX = process.env.PREFIX || '!';
const WARN_LIMIT = +process.env.WARN_LIMIT || 3;
const EXTRA = (process.env.YTDLP_ARGS ?? '--js-runtimes node --remote-components ejs:github').split(' ').filter(Boolean);
const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP = process.env.YTDLP_PATH || path.join(BIN_DIR, 'yt-dlp');
let ytReady = false, ytChecked = false; // ytChecked: 부팅 직후 yt-dlp 준비 전에 '음악 장애'로 오인하지 않기 위함
// yt-dlp(PyInstaller 단일 실행파일)는 실행할 때마다 임시폴더에 압축을 풂 → /tmp 가 작은 호스팅에서 실패하므로 서버 디스크 안으로 지정
const YT_TMP = path.join(__dirname, 'tmp');
EXTRA.push('--cache-dir', path.join(YT_TMP, 'cache'));
const ytEnv = () => ({ ...process.env, TMPDIR: YT_TMP, TEMP: YT_TMP, TMP: YT_TMP });
// yt-dlp 단일 실행파일 다운로드 주소 (리눅스 전용 빌드). 받은 뒤 시작할 때마다 nightly 로 업데이트함
const YTDLP_DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

/* ───────── 데이터 저장 (data.json) ───────── */
const DB_FILE = path.join(__dirname, 'data.json');
let db = { guilds: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db, null, 1), () => {}), 500); };
const G = id => (db.guilds[id] ??= { logChannel: null, warns: {} });

/* ───────── 유틸 ───────── */
const client = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildMessages, I.MessageContent, I.GuildModeration, I.GuildVoiceStates, I.GuildInvites],
  partials: [Partials.Message, Partials.Channel],
  allowedMentions: { parse: [], repliedUser: false }, // 기본: 답장에서 멘션 핑 안 나감
});
const cut = (s, n = 1000) => (s?.length > n ? s.slice(0, n - 1) + '…' : s || '*(없음)*');
const ts = d => `<t:${Math.floor(d / 1000)}:R>`;
const parseDur = s => {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(s ?? '');
  return m ? +m[1] * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()] : null;
};
const fmtDur = sec => {
  if (!sec) return 'LIVE';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const dm = (user, text) => user.send(text).catch(() => {});
const silentDel = new Set(); // 봇이 직접 지운 명령어 메시지는 삭제 로그에서 제외
function quietDelete(msg) {
  silentDel.add(msg.id); setTimeout(() => silentDel.delete(msg.id), 30000);
  return msg.delete().catch(() => {});
}
const tempReply = async (ch, text, ms = 6000) => { const r = await ch.send(text).catch(() => null); if (r) setTimeout(() => quietDelete(r), ms); };

// 슬래시/접두사 공용 헬퍼: 접두사면 원본 명령어 메시지 삭제·임시 안내, 슬래시면 그냥 답장
const origin = m => (m.isSlash ? null : quietDelete(m));
const note = (m, text, ms) => (m.isSlash ? m.reply(text) : tempReply(m.channel, text, ms));

async function log(guild, embed) {
  const id = G(guild.id).logChannel;
  const ch = id && guild.channels.cache.get(id);
  if (ch) ch.send({ embeds: [embed.setTimestamp()] }).catch(() => {});
}
const modLog = (m, title, color, target, reason, extra = []) =>
  log(m.guild, new EmbedBuilder().setColor(color).setTitle(title).addFields(
    { name: '대상', value: `${target} (${target.id})`, inline: true },
    { name: '관리자', value: `${m.author} (${m.author.id})`, inline: true },
    { name: '사유', value: cut(reason) }, ...extra));

// 대상 유저/멤버 해석: 멘션 또는 ID
async function target(m, args) {
  const id = (/^<@!?(\d+)>$/.exec(args[0] ?? '') || /^(\d{15,20})$/.exec(args[0] ?? ''))?.[1];
  if (!id) return {};
  const user = await client.users.fetch(id).catch(() => null);
  const member = await m.guild.members.fetch(id).catch(() => null);
  return { user, member };
}
// 역할 위계 / 자기 자신 / 서버주인 검증
function check(m, t) {
  if (t.id === m.author.id) return '자기 자신에게는 사용할 수 없어요.';
  if (t.id === m.guild.ownerId) return '서버 주인에게는 사용할 수 없어요.';
  if (m.author.id !== m.guild.ownerId && m.member.roles.highest.position <= t.roles.highest.position)
    return '나와 역할이 같거나 더 높은 대상이에요.';
  if (!t.manageable) return '봇의 역할이 대상보다 낮거나 권한이 부족해요. (봇 역할을 위로 올려주세요)';
  return null;
}
const usage = (name) => `사용법: \`${PREFIX}${C[name].usage}\``;

/* ───────── 음악 (yt-dlp + WebM Opus, 음량 조절 시 PCM 경유) ───────── */
const queues = new Map();

async function ensureYtdlp() {
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.mkdirSync(YT_TMP, { recursive: true });
    for (const f of fs.readdirSync(YT_TMP)) if (f.startsWith('_MEI')) fs.rmSync(path.join(YT_TMP, f), { recursive: true, force: true }); // 이전에 강제종료되며 남은 찌꺼기 정리
    if (!fs.existsSync(YTDLP)) {
      console.log('[music] yt-dlp 다운로드 중...');
      const r = await fetch(YTDLP_DOWNLOAD_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(YTDLP, Buffer.from(await r.arrayBuffer()));
      fs.chmodSync(YTDLP, 0o755);
    }
    await new Promise(res => execFile(YTDLP, ['--update-to', 'nightly@latest'], { env: ytEnv(), timeout: 120000 }, (e, out, err) => { // 유튜브 403 은 nightly 에서 먼저 고쳐지는 경우가 많음
      console.log('[music] yt-dlp 업데이트:', String(out || err || e?.message || '').trim().split('\n').pop()); res();
    }));
    ytReady = true;
    console.log('[music] yt-dlp 준비 완료');
  } catch (e) { console.error('[music] yt-dlp 준비 실패 → 음악 기능 비활성화:', e.message); }
  finally { ytChecked = true; }
}
function ytInfo(query) {
  const t = /^https?:\/\//.test(query) ? query : `ytsearch1:${query}`;
  return new Promise((res, rej) => execFile(YTDLP,
    ['--dump-single-json', '--no-playlist', '--flat-playlist', '--no-warnings', ...EXTRA, t],
    { maxBuffer: 1e7, timeout: 60000, env: ytEnv() }, (e, out) => {
      if (e) { health.music.err = Date.now(); return rej(e); }
      let j = JSON.parse(out); if (j.entries) j = j.entries[0];
      if (!j) return rej(new Error('검색 결과가 없어요.'));
      health.music.ok = Date.now();
      res({ title: j.title, url: j.webpage_url || j.url, duration: j.duration, id: j.id });
    }));
}
function ytProc(url) {
  const p = spawn(YTDLP, ['-f', '251/250/249/bestaudio[acodec=opus]', '-o', '-', '--no-playlist', '--no-warnings', '-q', ...EXTRA, url],
    { stdio: ['ignore', 'pipe', 'pipe'], env: ytEnv() });
  p.errTail = '';
  p.stderr.on('data', d => { p.errTail = (p.errTail + d).slice(-800); console.error('[yt-dlp]', d.toString().trim()); if (/ERROR/.test(d)) health.music.err = Date.now(); });
  p.on('error', e => console.error('[yt-dlp spawn]', e.message));
  return p;
}
function destroyQ(gid) {
  const q = queues.get(gid); if (!q) return;
  q.proc?.kill();
  try { q.player.stop(true); q.conn.destroy(); } catch {}
  queues.delete(gid);
}
async function next(gid) {
  const q = queues.get(gid); if (!q) return;
  q.proc?.kill(); q.proc = null; q.res = null;
  const s = q.songs.shift();
  if (!s) { // 큐 종료: 바로 나가지 않고 대기 (5분 뒤 자동 퇴장은 musicpanel.js 가 처리)
    q.current = null;
    return q.text.send(`✅ 대기열이 끝났어요. 5분 안에 새 곡이 없으면 나가요. (\`${PREFIX}leave\` 로 바로 내보내기)`).catch(() => {});
  }
  q.current = s; q.startedAt = Date.now();
  try {
    q.proc = ytProc(s.url);
    let res;
    if (VOL_OK) { // WebM Opus → PCM 디코딩 → 음량 적용
      const demux = new prism.opus.WebmDemuxer(), dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      demux.on('error', e => console.error('[demux]', e.message)); dec.on('error', e => console.error('[decode]', e.message));
      res = V.createAudioResource(q.proc.stdout.pipe(demux).pipe(dec), { inputType: V.StreamType.Raw, inlineVolume: true });
      res.volume.setVolume(q.volume);
    } else res = V.createAudioResource(q.proc.stdout, { inputType: V.StreamType.WebmOpus });
    q.res = res;
    q.player.play(res);
    q.text.send(`🎶 재생 시작: **${s.title}** \`${fmtDur(s.duration)}\``).catch(() => {});
  } catch (e) {
    console.error(e); q.text.send(`❌ 재생 실패: ${s.title}`).catch(() => {});
    q.current = null; next(gid);
  }
}
function needVoice(m) {
  if (!V) return '음성 라이브러리를 불러오지 못해 음악 기능이 꺼져 있어요. (Node 버전 확인)';
  if (!ytReady) return '음악 기능이 비활성화 상태예요. (yt-dlp 준비 실패 — 콘솔 확인)';
  if (!m.member.voice.channel) return '먼저 음성 채널에 들어가 주세요.';
  return null;
}
const getQ = m => queues.get(m.guild.id);

/* ───────── 명령어 정의 ───────── */
const C = {};
const def = (name, admin, usageText, desc, run) => (C[name] = { admin, usage: usageText, desc, run });
const ALIAS = { p: 'play', s: 'skip', q: 'queue', nowplaying: 'np', dc: 'leave', disconnect: 'leave', commands: 'help', h: 'help', vol: 'volume', cf: 'coinflip', sl: 'slots', quiz: 'math' };

/* ── 관리자 전용 ── */
def('ban', true, 'ban @유저|ID [사유]', '유저 차단', async (m, args) => {
  const { user, member } = await target(m, args); if (!user) return m.reply(usage('ban'));
  const reason = args.slice(1).join(' ') || '사유 없음';
  if (member) { const e = check(m, member); if (e) return m.reply('❌ ' + e); if (!member.bannable) return m.reply('❌ 차단할 수 없는 대상이에요.'); }
  await dm(user, `🔨 **${m.guild.name}** 에서 차단되었습니다.\n사유: ${reason}`);
  await m.guild.members.ban(user, { reason: `${reason} (by ${m.author.tag})` });
  await m.reply(`🔨 ${user.tag} 차단 완료 — ${reason}`);
  modLog(m, '🔨 차단', 0xe74c3c, user, reason);
});
def('unban', true, 'unban ID [사유]', '차단 해제', async (m, args) => {
  if (!/^\d{15,20}$/.test(args[0] ?? '')) return m.reply(usage('unban'));
  const reason = args.slice(1).join(' ') || '사유 없음';
  const u = await m.guild.members.unban(args[0], `${reason} (by ${m.author.tag})`).catch(() => null);
  if (!u) return m.reply('❌ 차단 목록에 없는 ID예요.');
  await m.reply(`✅ ${u.tag} 차단 해제`);
  modLog(m, '✅ 차단 해제', 0x2ecc71, u, reason);
});
def('kick', true, 'kick @유저|ID [사유]', '유저 추방', async (m, args) => {
  const { member } = await target(m, args); if (!member) return m.reply(usage('kick') + '\n(서버에 있는 유저만 가능)');
  const reason = args.slice(1).join(' ') || '사유 없음';
  const e = check(m, member); if (e) return m.reply('❌ ' + e);
  if (!member.kickable) return m.reply('❌ 추방할 수 없는 대상이에요.');
  await dm(member.user, `👢 **${m.guild.name}** 에서 추방되었습니다.\n사유: ${reason}`);
  await member.kick(`${reason} (by ${m.author.tag})`);
  await m.reply(`👢 ${member.user.tag} 추방 완료 — ${reason}`);
  modLog(m, '👢 추방', 0xe67e22, member.user, reason);
});
def('mute', true, 'mute @유저|ID [30s|10m|2h|1d] [사유]', '채팅/음성 차단 (기간 생략 시 최대 28일)', async (m, args) => {
  const { member } = await target(m, args); if (!member) return m.reply(usage('mute') + '\n(서버에 있는 유저만 가능)');
  const rest = args.slice(1); let ms = 28 * 864e5, label = '28d';
  if (parseDur(rest[0])) { ms = parseDur(rest.shift()); label = args[1]; }
  if (ms > 28 * 864e5) return m.reply('❌ 최대 28일(28d)까지만 가능해요.');
  const reason = rest.join(' ') || '사유 없음';
  const e = check(m, member); if (e) return m.reply('❌ ' + e);
  if (!member.moderatable) return m.reply('❌ 뮤트할 수 없는 대상이에요.');
  await member.timeout(ms, `${reason} (by ${m.author.tag})`);
  await dm(member.user, `🔇 **${m.guild.name}** 에서 뮤트되었습니다. (${label})\n사유: ${reason}`);
  await m.reply(`🔇 ${member.user.tag} 뮤트 ${label} — ${reason}`);
  modLog(m, '🔇 뮤트', 0xf1c40f, member.user, reason, [{ name: '해제 시각', value: ts(Date.now() + ms), inline: true }]);
});
def('unmute', true, 'unmute @유저|ID [사유]', '뮤트 해제', async (m, args) => {
  const { member } = await target(m, args); if (!member) return m.reply(usage('unmute'));
  if (!member.isCommunicationDisabled()) return m.reply('❌ 뮤트 상태가 아니에요.');
  const reason = args.slice(1).join(' ') || '사유 없음';
  await member.timeout(null, `${reason} (by ${m.author.tag})`);
  await m.reply(`🔊 ${member.user.tag} 뮤트 해제`);
  modLog(m, '🔊 뮤트 해제', 0x2ecc71, member.user, reason);
});
def('warn', true, 'warn @유저|ID [사유]', '경고 부여', async (m, args) => {
  const { member } = await target(m, args); if (!member) return m.reply(usage('warn'));
  if (member.user.bot) return m.reply('❌ 봇에게는 경고를 줄 수 없어요.');
  if (member.id === m.author.id) return m.reply('❌ 자기 자신은 안 돼요.');
  if (m.author.id !== m.guild.ownerId && m.member.roles.highest.position <= member.roles.highest.position) return m.reply('❌ 나와 역할이 같거나 더 높은 대상이에요.');
  const reason = args.slice(1).join(' ') || '사유 없음';
  const list = (G(m.guild.id).warns[member.id] ??= []);
  list.push({ id: Date.now().toString(36), reason, mod: m.author.id, date: Date.now() }); save();
  await dm(member.user, `⚠️ **${m.guild.name}** 에서 경고를 받았습니다. (누적 ${list.length}회)\n사유: ${reason}`);
  let msg = `⚠️ ${member.user.tag} 경고 (누적 ${list.length}/${WARN_LIMIT}) — ${reason}`;
  if (list.length >= WARN_LIMIT && member.moderatable) { await member.timeout(36e5, `경고 ${WARN_LIMIT}회 누적 자동 처리`); msg += '\n🔇 경고 누적으로 1시간 뮤트 적용'; }
  await m.reply(msg);
  modLog(m, '⚠️ 경고', 0xf39c12, member.user, reason, [{ name: '누적', value: `${list.length}회`, inline: true }]);
});
def('warnings', true, 'warnings @유저|ID', '경고 목록 확인', async (m, args) => {
  const { user } = await target(m, args); if (!user) return m.reply(usage('warnings'));
  const list = G(m.guild.id).warns[user.id] ?? [];
  if (!list.length) return m.reply(`${user.tag} 님은 경고가 없어요.`);
  m.reply({ embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`⚠️ ${user.tag} 경고 ${list.length}회`)
    .setDescription(list.slice(-15).map((w, n) => `**${n + 1}.** ${cut(w.reason, 120)} — <@${w.mod}> ${ts(w.date)}`).join('\n'))] });
});
def('clearwarns', true, 'clearwarns @유저|ID', '경고 초기화', async (m, args) => {
  const { user } = await target(m, args); if (!user) return m.reply(usage('clearwarns'));
  delete G(m.guild.id).warns[user.id]; save();
  await m.reply(`🧹 ${user.tag} 경고 초기화`);
  modLog(m, '🧹 경고 초기화', 0x95a5a6, user, '경고 전체 삭제');
});
def('purge', true, 'purge 개수(1~100) [@유저]', '메시지 일괄 삭제', async (m, args) => {
  const n = parseInt(args[0]); if (!(n >= 1 && n <= 100)) return m.reply(usage('purge'));
  const u = m.mentions.users.first();
  await origin(m);
  let msgs = await m.channel.messages.fetch({ limit: u ? 100 : n });
  msgs = [...msgs.filter(x => !x.pinned && (!u || x.author.id === u.id)).values()].slice(0, n);
  const del = await m.channel.bulkDelete(msgs, true);
  note(m, `🗑️ ${del.size}개 삭제 완료 (14일 지난 메시지는 삭제 불가)`);
  log(m.guild, new EmbedBuilder().setColor(0x95a5a6).setTitle('🗑️ 메시지 일괄 삭제').addFields(
    { name: '채널', value: `${m.channel}`, inline: true }, { name: '관리자', value: `${m.author}`, inline: true },
    { name: '개수', value: `${del.size}`, inline: true }, ...(u ? [{ name: '대상 유저', value: `${u}`, inline: true }] : [])));
});
def('slowmode', true, 'slowmode 초(0=해제)', '슬로우모드 설정', async (m, args) => {
  const s = parseInt(args[0]); if (!(s >= 0 && s <= 21600)) return m.reply(usage('slowmode'));
  await m.channel.setRateLimitPerUser(s);
  await m.reply(s ? `🐌 슬로우모드 ${s}초` : '🐌 슬로우모드 해제');
  log(m.guild, new EmbedBuilder().setColor(0x3498db).setTitle('🐌 슬로우모드 변경').setDescription(`${m.channel} → ${s}초 (by ${m.author})`));
});
def('lock', true, 'lock', '현재 채널 잠금', async m => {
  await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: false });
  await m.reply('🔒 채널을 잠갔어요.');
  log(m.guild, new EmbedBuilder().setColor(0xe74c3c).setTitle('🔒 채널 잠금').setDescription(`${m.channel} (by ${m.author})`));
});
def('unlock', true, 'unlock', '현재 채널 잠금 해제', async m => {
  await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: null });
  await m.reply('🔓 채널 잠금을 해제했어요.');
  log(m.guild, new EmbedBuilder().setColor(0x2ecc71).setTitle('🔓 채널 잠금 해제').setDescription(`${m.channel} (by ${m.author})`));
});
def('setlog', true, 'setlog #채널 | off', '관리 로그 채널 설정', async (m, args) => {
  if (args[0] === 'off') { G(m.guild.id).logChannel = null; save(); return m.reply('📝 로그 채널을 해제했어요.'); }
  const ch = m.mentions.channels.first(); if (!ch) return m.reply(usage('setlog'));
  G(m.guild.id).logChannel = ch.id; save();
  m.reply(`📝 로그 채널: ${ch}`);
});
def('announce', true, 'announce #채널 [제목 |] 내용   (이미지 첨부 + @멘션 가능)', '공지 전송', async (m, args, argStr) => {
  const cm = /^<#(\d+)>/.exec(argStr);
  const ch = cm && m.guild.channels.cache.get(cm[1]);
  if (!ch?.isTextBased()) return m.reply(usage('announce'));
  let text = argStr.slice(cm[0].length).trim(), title = null;
  if (text.split('\n')[0].includes('|')) { const k = text.indexOf('|'); title = text.slice(0, k).trim(); text = text.slice(k + 1).trim(); }
  const img = m.attachments.find(a => a.contentType?.startsWith('image/'));
  if (!text.replace(/^(?:\s*(?:@everyone|@here|<@&\d+>|<@!?\d+>))+\s*/, '') && !img) return m.reply(usage('announce'));
  if (!ch.permissionsFor(m.guild.members.me).has(['ViewChannel', 'SendMessages'])) return m.reply('❌ 그 채널에 보낼 권한이 봇에게 없어요.');
  // 임베드 안의 멘션은 핑이 안 가므로 본문 위(content)에 따로 붙임
  const pings = [...new Set(text.match(/@everyone|@here|<@&\d+>|<@!?\d+>/g) ?? [])];
  const e = new EmbedBuilder().setColor(0x5865f2).setTimestamp();
  if (title) e.setTitle(title);
  const body = text.replace(/^(?:\s*(?:@everyone|@here|<@&\d+>|<@!?\d+>))+\s*/, '');
  if (body) e.setDescription(body.slice(0, 4000));
  const payload = {
    embeds: [e], files: [],
    allowedMentions: { parse: [...(pings.some(p => p === '@everyone' || p === '@here') ? ['everyone'] : []), 'roles', 'users'] },
  };
  if (pings.length) payload.content = pings.join(' ');
  if (img) { // CDN 링크는 만료되므로 봇이 다시 업로드
    payload.files.push(new AttachmentBuilder(img.url, { name: img.name }));
    e.setImage(`attachment://${img.name}`);
  }
  const sent = await ch.send(payload);
  await origin(m);
  note(m, `📢 공지 전송 완료: ${sent.url}`, 10000);
  log(m.guild, new EmbedBuilder().setColor(0x5865f2).setTitle('📢 공지 전송').setDescription(`${ch} (by ${m.author})\n${sent.url}`));
});
def('incident', true, 'incident gateway|commands|music [degraded|down] [분]  /  incident resolve', '상태 페이지에 장애를 수동으로 표시/해제 (테스트용)', async (m, args) => {
  if (args[0] === 'resolve') { health.manual = null; await m.reply('✅ 수동 장애를 해제했어요. (페이지 반영까지 최대 1분)'); return pushStatus(); }
  if (!['gateway', 'commands', 'music'].includes(args[0])) return m.reply(usage('incident'));
  const level = args.includes('down') ? 'down' : 'degraded', mins = Math.min(180, Math.max(1, parseInt(args.find(a => /^\d+$/.test(a))) || 5));
  health.manual = { comp: args[0], level, until: Date.now() + mins * 60000 };
  await m.reply(`🚨 \`${args[0]}\` 장애(${level}) 표시 시작 — ${mins}분 뒤 자동 해제. 페이지 반영까지 최대 1분. (실제 기능은 정상 동작)`);
  pushStatus();
});

/* ── 모두 사용 ── */
def('help', false, 'help', '명령어 목록', async m => {
  const admin = m.member.permissions.has(P.Administrator);
  const lines = a => Object.values(C).filter(c => c.admin === a).map(c => `\`${c.private ? '/' : PREFIX}${c.usage}\` — ${c.desc}`);
  const chunks = arr => { const out = ['']; for (const l of arr) { if ((out.at(-1) + l).length > 1000) out.push(''); out[out.length - 1] += l + '\n'; } return out; };
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('📖 명령어').setDescription(`\`${PREFIX}명령어\` 와 \`/명령어\` 둘 다 사용 가능`);
  chunks(lines(false)).forEach((v, i) => e.addFields({ name: i ? '\u200b' : '🎵 / 일반', value: v }));
  if (admin) chunks(lines(true)).forEach((v, i) => e.addFields({ name: i ? '\u200b' : '🛡️ 관리자', value: v }));
  m.reply({ embeds: [e] });
});
def('ping', false, 'ping', '봇 응답속도', m => m.reply(`🏓 ${client.ws.ping}ms`));
def('userinfo', false, 'userinfo [@유저]', '유저 정보', async m => {
  const u = m.mentions.users.first() ?? m.author, mem = await m.guild.members.fetch(u.id).catch(() => null);
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(u.tag).setThumbnail(u.displayAvatarURL())
    .addFields({ name: 'ID', value: u.id, inline: true }, { name: '계정 생성', value: ts(u.createdTimestamp), inline: true });
  if (mem) e.addFields({ name: '서버 입장', value: ts(mem.joinedTimestamp), inline: true },
    { name: '역할', value: cut(mem.roles.cache.filter(r => r.id !== m.guild.id).map(r => r).join(' ') || '없음') });
  m.reply({ embeds: [e] });
});
def('serverinfo', false, 'serverinfo', '서버 정보', m => {
  const g = m.guild;
  m.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(g.name).setThumbnail(g.iconURL())
    .addFields(
      { name: '멤버', value: `${g.memberCount}`, inline: true },
      { name: '채널', value: `${g.channels.cache.size}`, inline: true },
      { name: '역할', value: `${g.roles.cache.size}`, inline: true },
      { name: '주인', value: `<@${g.ownerId}>`, inline: true },
      { name: '생성', value: ts(g.createdTimestamp), inline: true },
    )] });
});

/* ── 음악 ── */
def('play', false, 'play 검색어|링크  (p)', '노래 재생', async (m, args, argStr) => {
  if (!argStr) return m.reply(usage('play'));
  const err = needVoice(m); if (err) return m.reply('❌ ' + err);
  const gid = m.guild.id, vc = m.member.voice.channel;
  let q = queues.get(gid);
  if (q && q.conn.joinConfig.channelId !== vc.id) {
    if (q.current || q.songs.length) return m.reply('❌ 봇이 다른 음성 채널에서 재생 중이에요.');
    destroyQ(gid); q = null; // 대기 중이면 사용자 채널로 이동
  }
  const wait = await m.reply('🔎 검색 중...');
  const info = await ytInfo(argStr).catch(e => { console.error(e); return null; });
  if (!info) return wait.edit('❌ 곡을 찾지 못했어요. (링크/검색어 확인)');
  const song = { ...info, by: m.author.tag };
  if (!q) {
    const conn = V.joinVoiceChannel({ channelId: vc.id, guildId: gid, adapterCreator: m.guild.voiceAdapterCreator, selfDeaf: true });
    const player = V.createAudioPlayer();
    conn.subscribe(player);
    q = { conn, player, songs: [], current: null, loop: 'off', text: m.channel, proc: null, stopped: false, volume: (G(gid).volume ?? 50) / 100, res: null };
    queues.set(gid, q);
    player.on(V.AudioPlayerStatus.Idle, () => {
      if (q.stopped) { q.stopped = false; return; } // !stop 으로 멈춘 경우 다음 곡 안 넘어감
      if (q.current && Date.now() - q.startedAt < 5000) { // 5초 안에 끝났다면 재생 실패
        health.music.err = Date.now();
        const raw = (q.proc?.errTail || '').trim().split('\n').slice(-2).join('\n').slice(0, 300);
        const why = /confirm your age|Sign in to confirm/i.test(raw) ? '연령 제한 영상이라 재생할 수 없어요.'
          : /HTTP Error 403/.test(raw) ? '유튜브가 이 서버의 접근을 막았어요. (403)' : (raw || '원인 불명 (서버 콘솔의 [yt-dlp] 로그 확인)');
        q.text.send(`❌ 재생 실패: **${q.current.title}**\n\`\`\`${why}\`\`\``).catch(() => {});
        q.current = null; return next(gid);
      }
      if (q.loop === 'track' && q.current) q.songs.unshift(q.current);
      else if (q.loop === 'queue' && q.current) q.songs.push(q.current);
      next(gid);
    });
    player.on('error', e => console.error('[player]', e.message));
    conn.on(V.VoiceConnectionStatus.Disconnected, async () => {
      try { await Promise.race([V.entersState(conn, V.VoiceConnectionStatus.Signalling, 5000), V.entersState(conn, V.VoiceConnectionStatus.Connecting, 5000)]); }
      catch { destroyQ(gid); }
    });
    try { await V.entersState(conn, V.VoiceConnectionStatus.Ready, 20000); }
    catch { destroyQ(gid); return wait.edit('❌ 음성 채널 연결에 실패했어요. (봇의 Connect/Speak 권한 확인)'); }
  }
  q.songs.push(song); q.text = m.channel;
  await wait.edit(`➕ 대기열 추가: ${song.title} \`${fmtDur(song.duration)}\``);
  if (!q.current) next(gid);
});
def('skip', false, 'skip  (s)', '현재 곡 건너뛰기', m => {
  const q = getQ(m); if (!q?.current) return m.reply('❌ 재생 중인 곡이 없어요.');
  q.current = null; q.player.stop(true); m.reply('⏭️ 건너뛰었어요.');
});
def('stop', false, 'stop', '재생 정지 + 대기열 비우기 (5분 뒤 자동 퇴장)', m => {
  const q = getQ(m); if (!q) return m.reply('❌ 봇이 음성 채널에 없어요.');
  q.songs = []; q.current = null; q.loop = 'off'; q.proc?.kill(); q.proc = null;
  q.stopped = q.player.state.status !== V.AudioPlayerStatus.Idle;
  q.player.stop(true);
  m.reply(`⏹️ 정지했어요. 5분 안에 새 곡이 없으면 나가요. (\`${PREFIX}leave\` 로 바로 내보내기)`);
});
def('leave', false, 'leave', '봇을 음성 채널에서 내보내기', m => {
  if (!getQ(m)) return m.reply('❌ 봇이 음성 채널에 없어요.');
  destroyQ(m.guild.id); m.reply('👋 음성 채널에서 나갔어요.');
});
def('pause', false, 'pause', '일시정지', m => {
  const q = getQ(m); if (!q?.current) return m.reply('❌ 재생 중이 아니에요.'); q.player.pause(); m.reply('⏸️ 일시정지');
});
def('resume', false, 'resume', '다시 재생', m => {
  const q = getQ(m); if (!q?.current) return m.reply('❌ 재생 중이 아니에요.'); q.player.unpause(); m.reply('▶️ 다시 재생');
});
def('queue', false, 'queue  (q)', '대기열 보기', m => {
  const q = getQ(m); if (!q || (!q.current && !q.songs.length)) return m.reply('대기열이 비어 있어요.');
  const lines = q.songs.slice(0, 10).map((s, n) => `${n + 1}. ${cut(s.title, 70)} \`${fmtDur(s.duration)}\``);
  m.reply({ embeds: [new EmbedBuilder().setColor(0x1db954).setTitle('🎶 대기열')
    .setDescription(`지금: ${q.current ? cut(q.current.title, 70) : '-'}\n\n${lines.join('\n') || '*(다음 곡 없음)*'}${q.songs.length > 10 ? `\n…외 ${q.songs.length - 10}곡` : ''}`)
    .setFooter({ text: `반복: ${q.loop}` })] });
});
def('np', false, 'np', '현재 재생 중인 곡', m => {
  const q = getQ(m); if (!q?.current) return m.reply('재생 중인 곡이 없어요.');
  m.reply(`🎵 ${q.current.title} \`${fmtDur(q.current.duration)}\` — 요청: ${q.current.by}\n${q.current.url}`);
});
def('loop', false, 'loop off|track|queue', '반복 모드', (m, args) => {
  const q = getQ(m); if (!q) return m.reply('❌ 봇이 음성 채널에 없어요.');
  if (!['off', 'track', 'queue'].includes(args[0])) return m.reply(usage('loop'));
  q.loop = args[0]; m.reply(`🔁 반복 모드: ${q.loop}`);
});
def('volume', false, 'volume [0~150]  (vol)', '음량 확인/조절 (기본 50, 서버별로 저장)', (m, args) => {
  const cur = G(m.guild.id).volume ?? 50;
  if (!args[0]) return m.reply(`🔊 현재 음량: ${cur}%`);
  if (!VOL_OK) return m.reply('❌ 음량 조절을 쓰려면 서버에서 npm i opusscript prism-media 후 봇을 재시작해 주세요.');
  const n = parseInt(args[0]); if (!(n >= 0 && n <= 150)) return m.reply(usage('volume'));
  G(m.guild.id).volume = n; save();
  const q = getQ(m); if (q) { q.volume = n / 100; q.res?.volume?.setVolume(q.volume); } // 재생 중인 곡에도 즉시 적용
  m.reply(`🔊 음량 ${n}%${n > 100 ? ' (100% 넘으면 소리가 깨질 수 있어요)' : ''}`);
});

/* ── 발로란트 상점 (비공식 API · 로그인은 QR 전용(슬래시) · 상점 버튼은 명령어를 쓴 본인만 · 다중 계정) ── */
// 로그인은 Riot Mobile 앱으로 QR 스캔 → login_token → access_token 흐름. 비밀번호는 이 봇을 거치지 않음.
// 쿠키 자동 재로그인에 쓰는 Riot 웹 인증 주소 (vCookieTokens)
const VAL_AUTH_URL = 'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid';
const VAL_ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1';
const VAL_USERINFO_URL = 'https://auth.riotgames.com/userinfo';
const VAL_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant';
const VAL_PLATFORM = Buffer.from(JSON.stringify({ platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' })).toString('base64');
const VAL_REGIONS = ['kr', 'ap', 'na', 'eu'];
const VAL_MAX = 5; // 한 사람이 등록할 수 있는 계정 수
const VAL_CUR = { '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741': 'VP', '85ca954a-41f2-ce94-9b45-8ca3dd39a00d': 'KC', 'e59aa87c-4cbf-517a-5983-6e81511be9b7': 'RAD' };
const VAL_TYPE = { 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475': '스프레이', 'dd3bf334-87f3-40bd-b043-682a57a8dc3a': '총기 장식', '3f296c07-64c3-494c-923b-fe692a4fa1bd': '플레이어 카드', 'de7caa6b-adf7-4588-bbd1-143831e786c6': '칭호' };
const VIEWS = [['daily', '🛒 오늘의 상점'], ['night', '🌙 야시장'], ['weekly', '🗓️ 주간 상점'], ['bundle', '🎁 번들']];
const VIEW_LABEL = { daily: '오늘의 상점', night: '야시장', weekly: '장식상점', bundle: '번들' };
// 로그인 토큰(access/entitlement)은 메모리에만 보관. data.json 에는 계정 이름/지역/puuid 목록만 저장 (토큰 없음)
const vSessions = new Map(); // discord user id -> Map(puuid -> { access, ent, puuid, name, shard, exp, cache })
let vSkins = null, vSkinsAt = 0, vBundles = null, vVer = null, vVerAt = 0;
const vAccs = uid => ((db.vacc ??= {})[uid] ??= []); // 등록된 계정 [{ puuid, name, shard }]
const vSess = uid => vSessions.get(uid) ?? vSessions.set(uid, new Map()).get(uid);
const vLive = s => !!s && Date.now() < s.exp - 60000;
// ── 쿠키(ssid) 자동 재로그인: 쿠키는 AES-256-GCM 으로 암호화해서 data.json 에만 저장 (키: .env 의 VAL_COOKIE_KEY, 없으면 기능 꺼짐) ──
// QR 로그인은 쿠키를 받지 못하므로, 기존에 쿠키가 등록된 계정이 있을 때만 쓰임
const COOKIE_KEY = process.env.VAL_COOKIE_KEY ? crypto.createHash('sha256').update(process.env.VAL_COOKIE_KEY).digest() : null;
const VAL_UA = 'ShooterGame/13 Windows/10.0.19043.1.256.64bit';
const ckEnc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', COOKIE_KEY, iv), d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.'); };
const ckDec = x => { try { const [iv, tag, d] = x.split('.').map(v => Buffer.from(v, 'base64')), c = crypto.createDecipheriv('aes-256-gcm', COOKIE_KEY, iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); } catch { return null; } };
// 입력값 정리: "ssid=값" / "값" / 쿠키 전체 문자열 어느 쪽이든 "ssid=값" 으로
const ckNorm = t => { const v = String(t ?? '').trim(); if (!v) return null; const m = /(?:^|[;\s])ssid=([^;\s]+)/.exec(v); return m ? `ssid=${m[1]}` : /^[^\s;=]{20,}$/.test(v) ? `ssid=${v}` : null; };
// 쿠키로 Riot 에 다시 인증 요청 → 303 리다이렉트 주소(토큰 포함) 반환. 쿠키가 무효면 null, 네트워크 오류는 throw
async function vCookieTokens(cookie) {
  const r = await fetch(VAL_AUTH_URL, { headers: { 'user-agent': VAL_UA, cookie }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const loc = r.headers.get('location') || '';
  if (r.status < 300 || r.status > 399 || !/access_token=/.test(loc)) return null;
  const sc = (r.headers.getSetCookie?.() ?? []).map(c => /^ssid=([^;]+)/.exec(c)?.[1]).find(Boolean); // 쿠키가 갱신되면 새 값으로 교체
  return { uri: loc, cookie: sc ? `ssid=${sc}` : cookie };
}
// 사용할 계정 결정: 지정한 계정 > 마지막으로 선택한 계정 > 첫 번째 계정
const vPick = (uid, want) => { const l = vAccs(uid); return l.find(a => a.puuid === want) ?? l.find(a => a.puuid === db.vact?.[uid]) ?? l[0] ?? null; };
async function vjson(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url.split('?')[0]}`), { status: r.status });
  return j;
}
// 아이템 UUID → { name, icon, tier } (스킨 레벨 / 총기 장식 / 스프레이 / 플레이어 카드 / 칭호, 6시간 캐시)
async function vSkinMap() {
  if (vSkins && Date.now() - vSkinsAt < 6 * 36e5) return vSkins;
  const get = (p, optional) => vjson(`https://valorant-api.com/v1/${p}?language=ko-KR`).catch(e => { if (!optional) throw e; return { data: [] }; });
  const [skins, tiers, buddies, sprays, cards, titles, bundles] = await Promise.all([
    get('weapons/skins'), get('contenttiers'), get('buddies', 1), get('sprays', 1), get('playercards', 1), get('playertitles', 1), get('bundles', 1),
  ]);
  const tm = new Map(tiers.data.map(t => [t.uuid, t]));
  const map = new Map();
  for (const s of skins.data) {
    const info = { name: s.displayName, icon: s.displayIcon ?? s.chromas?.[0]?.fullRender ?? s.levels?.[0]?.displayIcon, tier: tm.get(s.contentTierUuid) };
    for (const l of s.levels ?? []) map.set(l.uuid, info);
  }
  for (const b of buddies.data) for (const l of b.levels ?? []) map.set(l.uuid, { name: b.displayName, icon: l.displayIcon ?? b.displayIcon });
  for (const x of sprays.data) map.set(x.uuid, { name: x.displayName, icon: x.fullTransparentIcon ?? x.displayIcon });
  for (const x of cards.data) map.set(x.uuid, { name: x.displayName, icon: x.smallArt ?? x.displayIcon });
  for (const x of titles.data) map.set(x.uuid, { name: x.titleText ?? x.displayName });
  vBundles = new Map(bundles.data.map(b => [b.uuid, { name: b.displayName, icon: b.displayIcon }]));
  vSkins = map; vSkinsAt = Date.now();
  return map;
}
async function vVersion() {
  if (vVer && Date.now() - vVerAt < 36e5) return vVer;
  vVer = (await vjson('https://valorant-api.com/v1/version')).data.riotClientVersion; vVerAt = Date.now();
  return vVer;
}
async function vFetchStore(s) {
  const base = `https://pd.${s.shard}.a.pvp.net/store`;
  const headers = { Authorization: `Bearer ${s.access}`, 'X-Riot-Entitlements-JWT': s.ent, 'X-Riot-ClientPlatform': VAL_PLATFORM, 'X-Riot-ClientVersion': await vVersion(), 'Content-Type': 'application/json' };
  let sf;
  try { sf = await vjson(`${base}/v3/storefront/${s.puuid}`, { method: 'POST', headers, body: '{}' }); }
  catch (e) { if (![400, 404, 405].includes(e.status)) throw e; sf = await vjson(`${base}/v2/storefront/${s.puuid}`, { headers }); } // v3 실패 시 v2
  return { sf, base, headers };
}
// 상점 + 지갑 조회 (버튼으로 탭을 옮겨 다닐 때 API 를 반복 호출하지 않도록 2분 캐시)
async function vStore(s) {
  if (s.cache && Date.now() - s.cache.at < 120000) return s.cache;
  const { sf, base, headers } = await vFetchStore(s);
  const price = new Map(); // 스킨 UUID → 가격(통화별 객체)
  const singles = sf.SkinsPanelLayout?.SingleItemStoreOffers ?? [];
  if (singles.length) for (const o of singles) price.set(o.Rewards?.[0]?.ItemID, o.Cost);
  else { // v2 응답에는 가격이 없어서 별도 조회
    try { for (const o of (await vjson(`${base}/v1/offers/`, { headers })).Offers ?? []) price.set(o.Rewards?.[0]?.ItemID, o.Cost); } catch {}
  }
  let wallet = null;
  try { wallet = (await vjson(`${base}/v1/wallet/${s.puuid}`, { headers })).Balances; } catch {}
  return (s.cache = { at: Date.now(), sf, price, wallet });
}
const vMoney = c => Object.entries(c ?? {}).map(([k, v]) => `${Number(v).toLocaleString()} ${VAL_CUR[k] ?? ''}`.trim()).join(' + ');
// 아이템 카드: 티어 아이콘 + 이름 / 가격 / 오른쪽에 무기 이미지
const vEmbed = (skins, id, desc) => {
  const k = skins.get(id);
  const e = new EmbedBuilder()
    .setAuthor({ name: k?.name ?? '알 수 없는 아이템', iconURL: k?.tier?.displayIcon })
    .setColor(k?.tier?.highlightColor ? parseInt(k.tier.highlightColor.slice(0, 6), 16) : 0x5865f2);
  if (desc) e.setDescription(desc);
  if (k?.icon) e.setThumbnail(k.icon);
  return e;
};
const vOk = (uid, s, r) => `✅ **${s.name}** (${s.shard.toUpperCase()}) 로그인 완료! ${ts(s.exp)} 만료됩니다. (등록된 계정 ${vAccs(uid).length}/${VAL_MAX}개)\n\`/vshop\` 으로 상점을 확인하세요.` +
  (r?.cookie ? '\n🔄 쿠키 자동 갱신이 켜졌어요. 토큰이 만료되면 `/vshop` 을 열 때 자동으로 다시 로그인해요.' : '');
// 로그인 URI(access_token 이 든 주소) → 세션 생성 + 계정 등록. QR 로그인이 사용
async function vDoLogin(uid, text, region, ssid) {
  let flat = String(text ?? '').replace(/\s+/g, ''), ck = COOKIE_KEY ? ckNorm(ssid) : null;
  let at = /access_token=([\w.\-]+)/.exec(flat)?.[1], idt = /id_token=([\w.\-]+)/.exec(flat)?.[1];
  if (!at && ck) { // URL 없이 쿠키만 온 경우: 쿠키로 토큰을 받아옴 (쿠키 검증도 겸함)
    let t = null; try { t = await vCookieTokens(ck); } catch {}
    if (!t) return { ok: false, content: '❌ 쿠키가 올바르지 않거나 만료됐어요. Riot 에 다시 로그인한 뒤 `ssid` 값을 새로 복사해 주세요.' };
    flat = t.uri.replace(/\s+/g, ''); ck = t.cookie;
    at = /access_token=([\w.\-]+)/.exec(flat)?.[1]; idt = /id_token=([\w.\-]+)/.exec(flat)?.[1];
  }
  if (!at) return { ok: false, content: '❌ 로그인 토큰(access_token)을 찾지 못했어요. `/vlogin` 으로 다시 시도해 주세요.' };
  const H = { Authorization: `Bearer ${at}` };
  try {
    const [ent, info] = await Promise.all([
      vjson(VAL_ENTITLEMENTS_URL, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }),
      vjson(VAL_USERINFO_URL, { headers: H }),
    ]);
    const puuid = info.sub, list = vAccs(uid), had = list.find(a => a.puuid === puuid);
    if (!had && list.length >= VAL_MAX) return { ok: false, content: `❌ 계정은 최대 ${VAL_MAX}개까지 등록할 수 있어요. \`/vlogout\` 으로 하나를 삭제한 뒤 다시 시도해 주세요.` };
    // 서버 지역: 직접 입력 > 자동 감지(PAS) > 이전에 등록된 값 > kr
    let shard = VAL_REGIONS.includes(String(region ?? '').toLowerCase()) ? region.toLowerCase() : null;
    if (!shard && idt) {
      try {
        const g = await vjson(VAL_PAS_URL, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idt }) });
        const a = g.affinities?.live; shard = { latam: 'na', br: 'na' }[a] ?? a;
      } catch {}
    }
    if (!VAL_REGIONS.includes(shard)) shard = had?.shard ?? 'kr';
    let exp = Date.now() + 55 * 60000;
    try { const j = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString()); if (j.exp) exp = j.exp * 1000; } catch {}
    const name = info.acct?.game_name ? `${info.acct.game_name}#${info.acct.tag_line}` : (had?.name ?? `계정 ${list.length + 1}`);
    const s = { access: at, ent: ent.entitlements_token, puuid, name, shard, exp, cache: null };
    vSess(uid).set(puuid, s);
    if (had) Object.assign(had, { name, shard }); else list.push({ puuid, name, shard });
    if (ck) list.find(a => a.puuid === puuid).ck = ckEnc(ck); // 쿠키는 암호화해서 계정 정보에만 저장 (토큰은 메모리에만)
    (db.vact ??= {})[uid] = puuid; save(); // 방금 로그인한 계정을 기본 계정으로
    return { ok: true, s, cookie: !!ck };
  } catch {
    return { ok: false, content: '❌ 토큰이 만료됐거나 잘못됐어요. `/vlogin` 으로 다시 진행해 주세요.' };
  }
}
// 선택한 탭에 맞는 메시지 만들기: 첫 카드 `계정#태그 | 갱신까지 남은 시간(디스코드 상대 시각)` + 아이템 카드들
function vBuild(s, st, skins, view) {
  const { sf, price, wallet } = st, now = Date.now();
  const panel = sf.SkinsPanelLayout, bonus = sf.BonusStore, acc = sf.AccessoryStore, fb = sf.FeaturedBundle;
  let sec = 0, items = [], empty = '';
  if (view === 'night') {
    sec = bonus?.BonusStoreRemainingDurationInSeconds;
    items = (bonus?.BonusStoreOffers ?? []).map(b => vEmbed(skins, b.Offer?.Rewards?.[0]?.ItemID,
      `~~${vMoney(b.Offer?.Cost)}~~ → **${vMoney(b.DiscountCosts)}** (-${b.DiscountPercent}%)`));
    empty = '현재 야시장이 열려 있지 않아요.';
  } else if (view === 'weekly') {
    sec = acc?.AccessoryStoreRemainingDurationInSeconds;
    items = (acc?.AccessoryStoreOffers ?? []).map(a => {
      const r = a.Offer?.Rewards?.[0];
      return vEmbed(skins, r?.ItemID, `${VAL_TYPE[r?.ItemTypeID] ?? '아이템'} · **${vMoney(a.Offer?.Cost)}**`);
    });
    empty = '장식상점 정보를 가져오지 못했어요.';
  } else if (view === 'bundle') {
    sec = fb?.BundleRemainingDurationInSeconds;
    items = (fb?.Bundles ?? []).map(b => {
      const meta = vBundles?.get(b.DataAssetID), cur = VAL_CUR[b.CurrencyID] ?? 'VP';
      const lines = (b.Items ?? []).map(it => `• ${skins.get(it.Item?.ItemID)?.name ?? '알 수 없는 아이템'} — ${(it.DiscountedPrice ?? it.BasePrice ?? 0).toLocaleString()} ${cur}`);
      const total = vMoney(b.TotalDiscountedCost), base = vMoney(b.TotalBaseCost);
      const e = new EmbedBuilder().setColor(0xf1c40f).setAuthor({ name: meta?.name ?? '번들' })
        .setDescription(cut(`${lines.join('\n')}\n\n**전체 구매: ${total}**${base && base !== total ? ` (~~${base}~~)` : ''}${b.DurationRemainingInSeconds ? `\n종료 ${ts(now + b.DurationRemainingInSeconds * 1000)}` : ''}`, 4000));
      if (meta?.icon) e.setThumbnail(meta.icon);
      return e;
    });
    empty = '현재 진행 중인 번들 정보를 가져오지 못했어요.';
  } else {
    sec = panel?.SingleItemOffersRemainingDurationInSeconds;
    items = (panel?.SingleItemOffers ?? []).map(id => vEmbed(skins, id, price.has(id) ? vMoney(price.get(id)) : ''));
    empty = '상점 정보를 가져오지 못했어요.';
  }
  const bal = Object.entries(wallet ?? {}).filter(([k]) => VAL_CUR[k]).map(([k, v]) => `${VAL_CUR[k]} ${Number(v).toLocaleString()}`).join(' · ');
  const head = new EmbedBuilder().setColor(0x8fd3ff)
    .setDescription(`**\`${s.name}\`**${sec ? ` | ${ts(now + sec * 1000)}` : ''}${items.length ? '' : `\n${empty}`}`)
    .setFooter({ text: [VIEW_LABEL[view], bal && `💰 ${bal}`].filter(Boolean).join(' · ') });
  return { content: null, embeds: [head, ...items.slice(0, 9)] };
}
// 버튼: 선택된 탭은 비활성(회색), 나머지는 파란색 / 둘째 줄 ⬅️ ➡️ 로 계정 전환. customId 끝에 주인 ID 를 넣어 본인만 조작 가능
function vComponents(uid, puuid, view, night) {
  const tabs = [['daily', '🛒', '상점'], ['weekly', '💎', '장식상점'], ['bundle', '📦', '번들'], ...(night ? [['night', '🌙', '야시장']] : [])];
  const row1 = new ActionRowBuilder().addComponents(...tabs.map(([k, emoji, label]) =>
    new ButtonBuilder().setCustomId(`vs:v:${k}:${puuid}:${uid}`).setEmoji(emoji).setLabel(label)
      .setStyle(k === view ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(k === view)));
  const multi = vAccs(uid).length > 1;
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vs:p:${view}:${puuid}:${uid}`).setEmoji('⬅️').setStyle(ButtonStyle.Primary).setDisabled(!multi),
    new ButtonBuilder().setCustomId(`vs:n:${view}:${puuid}:${uid}`).setEmoji('➡️').setStyle(ButtonStyle.Primary).setDisabled(!multi));
  return [row1, row2];
}
// 저장된 쿠키로 토큰 자동 갱신. 쿠키가 무효면 삭제하고 false, 네트워크 오류면 쿠키를 지우지 않고 false
async function vReauth(uid, a) {
  const ck = COOKIE_KEY && a.ck ? ckDec(a.ck) : null;
  if (!ck) return false;
  let t; try { t = await vCookieTokens(ck); } catch (e) { console.error('[vreauth]', e.message); return false; }
  if (!t) { delete a.ck; save(); return false; }
  const r = await vDoLogin(uid, t.uri, a.shard, t.cookie);
  if (r.ok && r.s.puuid !== a.puuid) return false; // 다른 계정의 쿠키였다면 갱신 실패 처리
  return !!r.ok;
}
// /vshop 과 버튼이 공용으로 쓰는 렌더러
async function vRender(uid, want, view = 'daily') {
  if (!VIEWS.some(([k]) => k === view)) view = 'daily';
  const a = vPick(uid, want);
  if (!a) return { content: '❌ 등록된 계정이 없어요. `/vlogin` 으로 먼저 로그인해 주세요.', components: [], embeds: [] };
  if (db.vact?.[uid] !== a.puuid) { (db.vact ??= {})[uid] = a.puuid; save(); }
  const NEED = () => ({ content: `❌ **${a.name}** 계정의 로그인이 만료됐어요. \`/vlogin\` 으로 다시 로그인해 주세요. (다른 등록 계정은 그대로예요)`, components: [], embeds: [] });
  let s = vSess(uid).get(a.puuid);
  if (!vLive(s)) { vSess(uid).delete(a.puuid); if (await vReauth(uid, a)) s = vSess(uid).get(a.puuid); } // 만료 → 저장된 쿠키가 있으면 자동 재로그인
  if (!vLive(s)) return NEED();
  const skins = await vSkinMap();
  let st;
  try { st = await vStore(s); }
  catch (e) {
    if (![401, 403].includes(e.status)) throw e;
    vSess(uid).delete(a.puuid);
    if (!(await vReauth(uid, a))) return NEED();
    s = vSess(uid).get(a.puuid); st = await vStore(s);
  }
  const night = !!st.sf.BonusStore?.BonusStoreOffers?.length; // 야시장이 열려 있을 때만 🌙 버튼 표시
  return { ...vBuild(s, st, skins, view), components: vComponents(uid, a.puuid, view, night) };
}
def('vlogout', false, 'vlogout [계정|all]', '등록한 발로란트 계정 삭제 (비우면 현재 계정, 슬래시 전용·본인에게만 보임)', m => {
  const uid = m.author.id, list = vAccs(uid), want = m.args0 && m.args0 !== '-' ? m.args0 : null;
  if (!list.length) return m.reply('등록된 계정이 없어요.');
  if (want === 'all') { const n = list.length; vSessions.delete(uid); delete db.vacc[uid]; delete db.vact?.[uid]; save(); return m.reply(`🧹 등록된 계정 ${n}개를 모두 삭제했어요.`); }
  const a = want ? list.find(x => x.puuid === want) : vPick(uid);
  if (!a) return m.reply('❌ 그 계정을 찾지 못했어요. /vaccounts 로 목록을 확인해 주세요.');
  list.splice(list.indexOf(a), 1); vSess(uid).delete(a.puuid);
  if (db.vact?.[uid] === a.puuid) delete db.vact[uid];
  if (!list.length) delete db.vacc[uid];
  save(); m.reply(`🧹 **${a.name}** 계정을 삭제했어요. (남은 계정 ${list.length}개)`);
});
def('vaccounts', false, 'vaccounts', '등록된 발로란트 계정 목록 (슬래시 전용·본인에게만 보임)', m => {
  const uid = m.author.id, list = vAccs(uid);
  if (!list.length) return m.reply('등록된 계정이 없어요. `/vlogin` 으로 QR 로그인해 주세요.');
  const act = vPick(uid)?.puuid;
  m.reply(`**등록된 계정 ${list.length}/${VAL_MAX}**\n` + list.map(a => {
    const s = vSess(uid).get(a.puuid);
    return `${a.puuid === act ? '⭐' : '•'} **${a.name}** (${a.shard.toUpperCase()}) — ${vLive(s) ? `🟢 로그인 유지 중 (${ts(s.exp)} 만료)` : a.ck ? '🔄 만료됨 · /vshop 열면 자동 갱신 (쿠키 등록됨)' : '🔴 재로그인 필요 (/vlogin)'}`;
  }).join('\n') + '\n\n새 계정 추가는 /vlogin, 계정 전환은 /vshop 의 ⬅️ ➡️ 버튼을 사용하세요.');
});
// vshop 은 비공개가 아님: 채널의 모든 사람에게 보이지만, 버튼은 명령어를 쓴 본인만 누를 수 있음
def('vshop', false, 'vshop [계정] [종류]', '발로란트 상점 보기: 상점·장식상점·번들·야시장 (버튼은 본인만 조작)', async (m, args) => {
  const [acc, view] = args.map(a => (a === '-' ? null : a));
  m.reply(await vRender(m.author.id, acc, view ?? 'daily'));
});
/* ── QR 로그인 (Riot Mobile 앱으로 스캔, 비공식 엔드포인트라 Riot 쪽 변경 시 깨질 수 있음) ── */
const QR_UA = 'RiotGamesApi/24.10.1.4471 rso-authenticator (Windows;10;;Professional, x64) riot_client/0';
const AUTH_UA = 'RiotGamesApi/24.10.1.4471 rso-auth (Windows;10;;Professional, x64) riot_client/0';
const hexId = n => crypto.randomBytes(n).toString('hex');
const qrHdr = (sid, ua) => ({ 'user-agent': ua, accept: 'application/json', 'content-type': 'application/json', baggage: `sdksid=${sid}`, traceparent: `00-${hexId(16)}-${hexId(8)}-00`, 'country-code': 'ko-KR' });
async function jarFetch(jar, url, opt = {}) { // 쿠키를 유지하는 fetch
  const headers = { ...opt.headers };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(url, { ...opt, headers, signal: AbortSignal.timeout(15000) });
  for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^([^=]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
  return r;
}
async function qrStart() {
  const sid = crypto.randomUUID(), jar = new Map();
  const r = await jarFetch(jar, 'https://authenticate.riotgames.com/api/v1/login', {
    method: 'POST', headers: qrHdr(sid, QR_UA),
    body: JSON.stringify({ client_id: 'riot-client', language: 'ko_KR', platform: 'windows', remember: false, type: 'auth', qrcode: {} }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.cluster || !j.suuid || !j.timestamp) throw new Error('QR 생성에 실패했어요.');
  return { sid, jar, url: `https://qrlogin.riotgames.com/riotmobile?cluster=${j.cluster}&suuid=${j.suuid}&timestamp=${j.timestamp}&utm_source=riotclient&utm_medium=client&utm_campaign=qrlogin-riotmobile` };
}
async function qrPoll(s) { // 승인되면 { type: 'success', success: { login_token } }
  const r = await jarFetch(s.jar, 'https://authenticate.riotgames.com/api/v1/login', { headers: qrHdr(s.sid, QR_UA) });
  return r.ok ? r.json().catch(() => null) : null;
}
async function qrAccess(loginToken) { // login_token → access_token/id_token 이 든 URI
  const sid = crypto.randomUUID(), jar = new Map();
  const r1 = await jarFetch(jar, 'https://auth.riotgames.com/api/v1/login-token', {
    method: 'POST', headers: qrHdr(sid, AUTH_UA),
    body: JSON.stringify({ authentication_type: null, code_verifier: '', login_token: loginToken, persist_login: false }),
  });
  if (r1.status !== 204) throw new Error('로그인 토큰 제출에 실패했어요.');
  const r2 = await jarFetch(jar, 'https://auth.riotgames.com/api/v1/authorization', {
    method: 'POST', headers: qrHdr(sid, AUTH_UA),
    body: JSON.stringify({ acr_values: '', claims: '', client_id: 'riot-client', code_challenge: '', code_challenge_method: '', nonce: crypto.randomUUID(), redirect_uri: 'http://localhost/redirect', response_type: 'token id_token', scope: 'openid link ban lol_region account' }),
  });
  const uri = (await r2.json().catch(() => ({})))?.response?.parameters?.uri;
  if (!r2.ok || !uri) throw new Error('액세스 토큰을 받지 못했어요.');
  return uri;
}
const qrBusy = new Set(); // 유저당 QR 로그인 1개만 동시에
def('vlogin', false, 'vlogin', 'QR 코드로 발로란트 계정 로그인/추가 (최대 5개, Riot Mobile 앱으로 스캔, 슬래시 전용·본인에게만 보임)', async m => {
  let QRCode; try { QRCode = require('qrcode'); } catch { return m.reply('❌ QR 기능을 쓰려면 서버에서 `npm i qrcode` 후 봇을 재시작해 주세요.'); }
  const uid = m.author.id;
  if (qrBusy.has(uid)) return m.reply('⏳ 이미 진행 중인 QR 로그인이 있어요. 끝나거나 만료된 뒤에 다시 실행해 주세요.');
  qrBusy.add(uid);
  try {
    const s = await qrStart();
    const png = await QRCode.toBuffer(s.url, { width: 200, margin: 1, errorCorrectionLevel: 'L' }); // 작게 + 오류정정 낮춰서 칸 수 줄임
    const msg = await m.reply({
      content: '📱 **Riot Mobile 앱**으로 아래 QR을 스캔하고 승인해 주세요. (2분 안에)\n⚠️ 이 QR은 본인 계정 로그인용이에요. 다른 사람에게 보내지 마세요.',
      files: [new AttachmentBuilder(png, { name: 'qr.png' })],
    });
    for (let n = 0; n < 40; n++) {
      await new Promise(r => setTimeout(r, 3000));
      const j = await qrPoll(s).catch(() => null);
      if (j?.type !== 'success') continue;
      try {
        const uri = await qrAccess(j.success.login_token);
        const r = await vDoLogin(uid, uri, null);
        return await msg.edit({ content: r.ok ? vOk(uid, r.s, r) : r.content, files: [] });
      } catch (e) { return await msg.edit({ content: '❌ ' + e.message, files: [] }); }
    }
    await msg.edit({ content: '⌛ QR이 만료됐어요. `/vlogin` 을 다시 실행해 주세요.', files: [] });
  } finally { qrBusy.delete(uid); }
});
for (const n of ['vlogin', 'vlogout', 'vaccounts']) C[n].private = true; // 이 셋만 슬래시 전용 + 본인에게만 보이는 응답

/* ───────── 슬래시 커맨드 (접두사 명령어와 같은 핸들러 공유) ───────── */
const U = (name = 'user', desc = '대상 유저', req = true) => ({ t: 'user', name, desc, req });
const S = (name, desc, req = false, choices) => ({ t: 'str', name, desc, req, choices });
const SA = (name, desc) => ({ t: 'str', name, desc, req: false, auto: true }); // 자동완성 문자열 옵션
const REASON = S('reason', '사유');
const TEXT_CH = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const SLASH = {
  ban: { opts: [U(), REASON] },
  unban: { opts: [S('user_id', '차단 해제할 유저 ID', true), REASON] },
  kick: { opts: [U(), REASON] },
  mute: { opts: [U(), S('duration', '예: 30s, 10m, 2h, 1d (생략 시 28일)'), REASON] },
  unmute: { opts: [U(), REASON] },
  warn: { opts: [U(), REASON] },
  warnings: { opts: [U()] },
  clearwarns: { opts: [U()] },
  purge: { opts: [{ t: 'int', name: 'count', desc: '삭제 개수(1~100)', req: true, min: 1, max: 100 }, U('user', '이 유저의 메시지만', false)] },
  slowmode: { opts: [{ t: 'int', name: 'seconds', desc: '초 (0=해제)', req: true, min: 0, max: 21600 }] },
  lock: { opts: [] },
  unlock: { opts: [] },
  setlog: {
    opts: [{ t: 'ch', name: 'channel', desc: '로그 채널 (비우면 해제)', types: [ChannelType.GuildText] }],
    toArgs: i => { const c = i.options.getChannel('channel'); return c ? `<#${c.id}>` : 'off'; },
  },
  announce: {
    opts: [
      { t: 'ch', name: 'channel', desc: '공지 채널', req: true, types: TEXT_CH },
      S('message', '내용 (줄바꿈은 \\n 입력)', true),
      S('title', '제목'),
      { t: 'att', name: 'image', desc: '첨부할 이미지' },
      S('ping', '전체 멘션', false, ['@everyone', '@here']),
      { t: 'role', name: 'role', desc: '멘션할 역할' },
      U('user', '멘션할 유저', false),
    ],
    toArgs: i => {
      const pings = [i.options.getString('ping'), i.options.getRole('role') && `<@&${i.options.getRole('role').id}>`,
        i.options.getUser('user') && `<@${i.options.getUser('user').id}>`].filter(Boolean);
      const title = i.options.getString('title'), msg = i.options.getString('message').replace(/\\n/g, '\n');
      return `<#${i.options.getChannel('channel').id}> ${title ? title + ' | ' : ''}${pings.join(' ')} ${msg}`.trim();
    },
  },
  incident: { opts: [S('target', '대상 (resolve = 해제)', true, ['gateway', 'commands', 'music', 'resolve']), S('level', '심각도', false, ['degraded', 'down']), { t: 'int', name: 'minutes', desc: '지속 시간(분, 기본 5)', min: 1, max: 180 }] },
  help: { opts: [] },
  ping: { opts: [] },
  userinfo: { opts: [U('user', '대상 유저', false)] },
  serverinfo: { opts: [] },
  play: { opts: [S('query', '검색어 또는 유튜브 링크', true)] },
  skip: { opts: [] },
  stop: { opts: [] },
  leave: { opts: [] },
  pause: { opts: [] },
  resume: { opts: [] },
  queue: { opts: [] },
  np: { opts: [] },
  loop: { opts: [S('mode', '반복 모드', true, ['off', 'track', 'queue'])] },
  volume: { opts: [{ t: 'int', name: 'level', desc: '음량 0~150 (비우면 현재 값 확인)', min: 0, max: 150 }] },
  vlogin: { opts: [] },
  vlogout: {
    opts: [SA('account', '삭제할 계정 (비우면 현재 선택된 계정)')],
    toArgs: i => i.options.getString('account') || '-',
  },
  vaccounts: { opts: [] },
  vshop: {
    opts: [
      SA('account', '조회할 계정 (비우면 마지막으로 본 계정)'),
      S('view', '볼 상점 (기본: 오늘의 상점)', false, [['오늘의 상점', 'daily'], ['장식상점', 'weekly'], ['번들', 'bundle'], ['야시장', 'night']]),
    ],
    toArgs: i => ['account', 'view'].map(n => i.options.getString(n) || '-').join(' '),
  },
};
for (const [n, sp] of Object.entries(SLASH)) C[n].slash = sp;
function buildSlash(name, cmd) {
  const b = new SlashCommandBuilder().setName(name).setDescription(cmd.desc.slice(0, 100));
  if (cmd.admin) b.setDefaultMemberPermissions(P.Administrator); // 관리자가 아니면 목록에서 아예 안 보임
  for (const o of cmd.slash.opts) {
    const base = x => x.setName(o.name).setDescription(o.desc).setRequired(!!o.req);
    if (o.t === 'user') b.addUserOption(base);
    else if (o.t === 'role') b.addRoleOption(base);
    else if (o.t === 'att') b.addAttachmentOption(base);
    else if (o.t === 'str') b.addStringOption(x => {
      base(x);
      if (o.choices) x.addChoices(...o.choices.map(c => (Array.isArray(c) ? { name: c[0], value: c[1] } : { name: c, value: c })));
      if (o.auto) x.setAutocomplete(true);
      return x;
    });
    else if (o.t === 'int') b.addIntegerOption(x => { base(x); if (o.min != null) x.setMinValue(o.min); if (o.max != null) x.setMaxValue(o.max); return x; });
    else if (o.t === 'ch') b.addChannelOption(x => { base(x); if (o.types) x.addChannelTypes(...o.types); return x; });
  }
  return b;
}
function defaultToArgs(cmd, i) {
  const out = [];
  for (const o of cmd.slash.opts) {
    if (o.t === 'user') { const u = i.options.getUser(o.name); if (u) out.push(`<@${u.id}>`); }
    else if (o.t === 'str') { const v = i.options.getString(o.name); if (v) out.push(v); }
    else if (o.t === 'int') { const v = i.options.getInteger(o.name); if (v != null) out.push(String(v)); }
    else if (o.t === 'ch') { const c = i.options.getChannel(o.name); if (c) out.push(`<#${c.id}>`); }
  }
  return out.join(' ');
}
// 슬래시 interaction 을 메시지처럼 쓸 수 있게 감싸는 어댑터
function wrapInteraction(i, cmd, args0) {
  const first = t => { const o = cmd.slash.opts.find(x => x.t === t); return o ? (t === 'user' ? i.options.getUser(o.name) : i.options.getChannel(o.name)) : null; };
  const mk = x => { const p = typeof x === 'string' ? { content: x } : { ...x }; p.allowedMentions ??= { parse: [] }; return p; };
  let firstReply = true;
  const attachments = new Collection();
  for (const o of cmd.slash.opts) if (o.t === 'att') { const a = i.options.getAttachment(o.name); if (a) attachments.set(a.id, a); }
  return {
    isSlash: true, id: i.id, client, author: i.user, member: i.member, guild: i.guild, channel: i.channel, attachments, args0,
    mentions: { users: { first: () => first('user') }, channels: { first: () => first('ch') } },
    async reply(x) {
      const p = mk(x);
      if (firstReply) { firstReply = false; await i.editReply(p); } else await i.followUp(p);
      return { edit: y => i.editReply(mk(y)) };
    },
  };
}
const slashBody = () => Object.entries(C).filter(([, c]) => c.slash).map(([n, c]) => buildSlash(n, c).toJSON());
async function registerGuild(g) {
  try { await g.commands.set(slashBody()); console.log(`[slash] 등록 완료: ${g.name}`); }
  catch (e) { console.error(`[slash] ${g.name} 등록 실패: ${e.message}\n  → 봇을 applications.commands 스코프로 다시 초대하세요. (접두사 ! 명령어는 그대로 동작)`); }
}

/* ───────── GitHub Pages 상태 (status.json 을 저장소 브랜치에 푸시) ───────── */
const GH_TOKEN = process.env.GH_TOKEN, GH_REPO = process.env.GH_REPO; // GH_REPO = "아이디/저장소"
const GH_BRANCH = process.env.GH_BRANCH || 'status-data';
const STATUS_EVERY = (+process.env.STATUS_INTERVAL || 30) * 1000;
const startedAt = Date.now();
async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${url}`, {
    method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'discord-bot-status' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status} ${j.message ?? ''}`), { status: r.status });
  return j;
}
const health = { manual: null, cmds: 0, errs: 0, lastErr: null, music: { ok: null, err: null } };
// 디스코드 온라인 여부: 게이트웨이가 Ready 상태일 때만 true (프로세스 생존 여부와 무관)
const dcUp = () => client.isReady() && client.ws.status === 0;
const PROBE_EVERY = (+process.env.PROBE_INTERVAL || 60) * 1000; // 음악 자체 점검 주기(기본 60초)
let probing = false;
const probeMusic = () => probing ? null : new Promise(res => (probing = true, execFile(YTDLP, ['-f', '251/250/249/bestaudio[acodec=opus]', '-g', '--no-playlist', '--no-warnings', ...EXTRA, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  { timeout: 60000, env: ytEnv() }, (e, out, err) => { // 주기적으로 실제 스트림 주소 추출 테스트
    if (e) { health.music.err = Date.now(); console.error('[music] 점검 실패:', String(err || e.message).slice(-300)); } else health.music.ok = Date.now();
    probing = false; res();
  })));
// 기능별 실제 상태: operational / degraded / down
function components() {
  const gw = dcUp(); // 디스코드 게이트웨이 연결 여부
  const m = health.music;
  const music = !V ? 'down' : !ytChecked ? 'operational' : !ytReady ? 'down' : m.err && (!m.ok || m.err > m.ok) ? 'degraded' : 'operational';
  const cmd = health.lastErr && Date.now() - health.lastErr < 600000 ? 'degraded' : 'operational';
  const out = { gateway: gw ? 'operational' : 'down', commands: gw ? cmd : 'down', music: gw ? music : 'down' };
  const mn = health.manual; // !incident 로 수동 지정한 장애
  if (mn && Date.now() < mn.until) out[mn.comp] = mn.level; else health.manual = null;
  return out;
}
// 90일 일별 가동 기록 + 사고(incident) 이력 (data.json 에 저장, 날짜는 KST 기준)
const TZ = 9 * 36e5;
function recordBeat(state, comp) {
  const st = (db.status ??= {}); st.days ??= {}; st.incidents ??= []; st.since ??= Date.now();
  const now = Date.now(), k = Math.floor((now + TZ) / 864e5);
  const d = (st.days[k] ??= { n: 0, g: 0, c: 0, m: 0 });
  d.n++; if (comp.gateway !== 'operational') d.g++; if (comp.commands !== 'operational') d.c++; if (comp.music !== 'operational') d.m++;
  for (const x of Object.keys(st.days)) if (x < k - 95) delete st.days[x];
  const open = st.incidents.find(i => !i.end), bad = Object.entries(comp).filter(([, v]) => v !== 'operational').map(([n]) => n);
  if (bad.length && !open) st.incidents.push({ id: now.toString(36), start: now, end: null, impact: state, comps: bad });
  else if (bad.length) { open.impact = state === 'down' || open.impact === 'down' ? 'down' : 'degraded'; open.comps = [...new Set([...open.comps, ...bad])]; }
  else if (open) open.end = now;
  st.incidents = st.incidents.slice(-60);
  if (comp.gateway === 'operational') st.last = now; // 마지막으로 디스코드에 온라인이었던 시각 (크래시 시 오프라인 시작점)
  save();
}
// 부팅 시: 꺼져 있던 시간을 "오프라인" 사고로 기록 (정상 종료는 종료 시각부터, 크래시는 마지막 디스코드 온라인 시각부터)
function checkGap() {
  const st = db.status; if (!st?.last) return;
  const now = Date.now(), start = st.offlineAt ?? st.last, min = st.offlineAt ? 15000 : STATUS_EVERY * 1.5;
  const gap = now - start; st.offlineAt = null;
  if (gap < min) return save();
  const open = (st.incidents ??= []).find(i => !i.end);
  if (open?.comps.includes('gateway')) { // 디스코드 끊김 사고가 이미 열려 있으면 그대로 이어서 종료 처리
    open.end = now; open.impact = 'down'; open.offline = true; open.comps = ['gateway', 'commands', 'music'];
    return save();
  }
  if (open) open.end = Math.max(open.start, start);
  st.incidents.push({ id: 'o' + now.toString(36), start, end: now, impact: 'down', comps: ['gateway', 'commands', 'music'], offline: true }); save();
}
// 공개 JSON 이므로 서버 이름·ID·유저 정보는 넣지 않고 숫자만 보냄
function snapshot(online) {
  const comp = components(), vals = Object.values(comp);
  const dcOn = online && dcUp(); // 프로세스 생존 + 디스코드 연결
  const state = !dcOn ? 'down' : vals.every(v => v === 'operational') ? 'operational' : 'degraded';
  if (online) recordBeat(state, comp); // 프로세스가 살아 있으면 가동 기록은 계속 (게이트웨이 끊김은 g 로 집계됨)
  const st = db.status ?? {};
  return {
    online: dcOn, state, components: comp, updated: Date.now(), startedAt, interval: STATUS_EVERY / 1000, ping: client.ws.ping,
    guilds: client.guilds.cache.size, members: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
    voice: queues.size, playing: [...queues.values()].filter(q => q.current).length,
    memMB: Math.round(process.memoryUsage().rss / 1048576), node: process.version,
    cmds: health.cmds, errs: health.errs, lastErr: health.lastErr, musicOk: health.music.ok, musicErr: health.music.err,
    since: st.since, days: Object.entries(st.days ?? {}).map(([k, v]) => [+k, v.n, v.g, v.c, v.m]), incidents: (st.incidents ?? []).slice(-40),
    bot: { name: client.user?.username, avatar: client.user?.displayAvatarURL({ size: 128 }) },
  };
}
let pushing = false;
async function pushStatus(online = true) {
  if (!GH_TOKEN || !GH_REPO) return;
  if (pushing && online) { pushStatus.dirty = true; return; }
  pushing = true;
  try { // 매번 부모 없는 커밋으로 브랜치를 덮어써서 커밋 기록이 쌓이지 않음
    const blob = await gh('POST', '/git/blobs', { content: JSON.stringify(snapshot(online), null, 1), encoding: 'utf-8' });
    const tree = await gh('POST', '/git/trees', { tree: [{ path: 'status.json', mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await gh('POST', '/git/commits', { message: `status ${new Date().toISOString()}`, tree: tree.sha, parents: [] });
    try { await gh('PATCH', `/git/refs/heads/${GH_BRANCH}`, { sha: commit.sha, force: true }); }
    catch (e) { if (e.status !== 404 && e.status !== 422) throw e; await gh('POST', '/git/refs', { ref: `refs/heads/${GH_BRANCH}`, sha: commit.sha }); }
    if (!pushStatus.ok) { pushStatus.ok = true; console.log('[status] 상태 전송 성공'); }
  } catch (e) { console.error('[status] 푸시 실패:', e.message); }
  finally { pushing = false; if (pushStatus.dirty) { pushStatus.dirty = false; pushStatus(); } }
}

// 웹 콘솔 표시용: 명령어가 어느 파일(모듈)에서 등록됐는지 기록
const CMD_SRC = {};
const markSrc = label => { for (const k of Object.keys(C)) if (!(k in CMD_SRC)) CMD_SRC[k] = label; };
markSrc('index');

// 채널 지정형 음악 패널 + 5분 자동 퇴장 + 내보내면 즉시 정리 (musicpanel.js 가 같은 폴더에 있어야 함)
try { require('./musicpanel')({ client, C, def, db, G, save, queues, V, VOL_OK, fmtDur, cut, quietDelete }); }
catch (e) { console.error('[musicpanel] 불러오기 실패 (musicpanel.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('musicpanel');

// 티켓 시스템 (TicketTool 스타일, tickets.js 가 같은 폴더에 있어야 함)
try { require('./tickets')({ client, C, def, db, G, save, cut }); }
catch (e) { console.error('[tickets] 불러오기 실패 (tickets.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('tickets');

// 발로란트 내전 (scrim.js 가 같은 폴더에 있어야 함)
try { require('./scrim')({ client, C, def, db, G, save, cut, ts }); }
catch (e) { console.error('[scrim] 불러오기 실패 (scrim.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('scrim');

// 초대 추적 (invites.js 가 같은 폴더에 있어야 함)
try { require('./invites')({ client, C, def, db, G, save, cut }); }
catch (e) { console.error('[invites] 불러오기 실패 (invites.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('invites');

// 발로란트 전적 조회 (valstats.js 가 같은 폴더에 있어야 함)
try { require('./valstats')({ client, C, def, cut }); }
catch (e) { console.error('[valstats] 불러오기 실패 (valstats.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('valstats');

// 가상화폐 경제 시스템 + 수학 문제 보상 (economy.js 가 같은 폴더에 있어야 함)
try { require('./economy')({ client, C, def, db, G, save, cut }); }
catch (e) { console.error('[economy] 불러오기 실패 (economy.js 가 index.js 옆에 있는지 확인):', e.message); }
markSrc('economy');

// 웹 콘솔용 API (webapi.js 가 같은 폴더에 있어야 함)
try { require('./webapi')({ client, queues, C, db, vApi: { qrStart, qrPoll, qrAccess, vDoLogin }, src: CMD_SRC }); }
catch (e) { console.error('[webapi] 불러오기 실패:', e.message); }

let closing = false;

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { // 종료 시 오프라인으로 표시
  if (closing) return; closing = true;
  if (db.status) { db.status.offlineAt = Date.now(); try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); } catch {} } // 종료 시각 즉시 저장
  await Promise.race([pushStatus(false), new Promise(r => setTimeout(r, 4000))]);
  process.exit(0);
});

/* ───────── 이벤트 ───────── */
client.once(Events.ClientReady, async c => {
  console.log(`로그인: ${c.user.tag} (접두사 ${PREFIX} + 슬래시)`);
  if (V && !VOL_OK) console.warn('[music] 음량 조절 비활성화: npm i opusscript prism-media 를 설치하면 /volume 을 쓸 수 있어요.');
  for (const g of c.guilds.cache.values()) await registerGuild(g);
  if (V) ensureYtdlp().then(() => { if (ytReady) { probeMusic(); setInterval(probeMusic, PROBE_EVERY); } });
  checkGap();
  if (GH_TOKEN && GH_REPO) {
    console.log(`[status] ${GH_REPO}@${GH_BRANCH} 로 ${STATUS_EVERY / 1000}초마다 상태 전송`);
    pushStatus(); setInterval(pushStatus, STATUS_EVERY);
    let sig = '';
    setInterval(() => {
      const n = JSON.stringify([components(), [...queues.values()].filter(q => q.current).length]);
      if (n !== sig) { if (sig) pushStatus(); sig = n; }
    }, 3000);
  } else console.warn('[status] .env 에 GH_TOKEN / GH_REPO 가 없어서 상태를 전송하지 않아요.');
});
client.on(Events.GuildCreate, registerGuild);
for (const ev of [Events.ShardDisconnect, Events.ShardReconnecting, Events.ShardResume, Events.ShardReady, Events.Invalidated])
  client.on(ev, () => setTimeout(pushStatus, 500));

client.on(Events.InteractionCreate, async i => {
  // 자동완성 (vshop / vlogout 의 account 옵션)
  if (i.isAutocomplete()) {
    if (!['vshop', 'vlogout'].includes(i.commandName)) return;
    const uid = i.user.id, q = String(i.options.getFocused() ?? '').toLowerCase(), list = vAccs(uid);
    const ch = list.map(a => ({ name: `${a.name} (${a.shard.toUpperCase()})${vLive(vSess(uid).get(a.puuid)) || a.ck ? '' : ' · 로그인 필요'}`.slice(0, 100), value: a.puuid }))
      .filter(c => c.name.toLowerCase().includes(q));
    if (i.commandName === 'vlogout' && list.length > 1) ch.push({ name: '전체 삭제', value: 'all' });
    return i.respond(ch.slice(0, 25)).catch(() => {});
  }
  // 상점 버튼 (vs:<종류>:<탭>:<puuid>:<주인ID>) — 명령어를 쓴 본인만 조작 가능
  if (i.isButton() && i.customId.startsWith('vs:')) {
    const [, kind, view, puuid, owner] = i.customId.split(':');
    if (owner !== i.user.id)
      return i.reply({ content: '🔒 이 상점은 명령어를 사용한 본인만 조작할 수 있어요. `/vshop` 으로 직접 열어보세요.', flags: MessageFlags.Ephemeral }).catch(() => {});
    await i.deferUpdate().catch(() => {});
    let want = puuid;
    if (kind === 'p' || kind === 'n') { // ⬅️ ➡️ 계정 전환
      const l = vAccs(owner), k = l.findIndex(a => a.puuid === puuid);
      want = l[(k + (kind === 'n' ? 1 : l.length - 1)) % l.length]?.puuid ?? puuid;
    }
    try { await i.editReply(await vRender(owner, want, view)); }
    catch (e) {
      health.errs++; health.lastErr = Date.now(); console.error('[vshop]', e);
      i.followUp({ content: '⚠️ 오류: ' + String(e.message || e).slice(0, 200), flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  // 슬래시 명령어
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  const cmd = C[i.commandName]; if (!cmd?.slash) return;
  if (cmd.admin && !i.memberPermissions.has(P.Administrator))
    return i.reply({ content: '❌ 관리자만 사용할 수 있어요.', flags: MessageFlags.Ephemeral }).catch(() => {});
  await i.deferReply(cmd.private ? { flags: MessageFlags.Ephemeral } : undefined).catch(() => {});
  health.cmds++;
  const argStr = cmd.slash.toArgs ? cmd.slash.toArgs(i) : defaultToArgs(cmd, i);
  const args = argStr.split(/\s+/).filter(Boolean);
  try { await cmd.run(wrapInteraction(i, cmd, args[0]), args, argStr); }
  catch (e) {
    health.errs++; health.lastErr = Date.now(); console.error(`[/${i.commandName}]`, e);
    i.editReply('⚠️ 오류: ' + String(e.message || e).slice(0, 200)).catch(() => {});
  }
});

client.on(Events.MessageCreate, async m => {
  if (m.author.bot || !m.guild || !m.member || !m.content.startsWith(PREFIX)) return;
  const body = m.content.slice(PREFIX.length).trim();
  const word = body.split(/\s+/)[0]?.toLowerCase(); if (!word) return;
  const cmd = C[ALIAS[word] ?? word]; if (!cmd) return;
  if (cmd.admin && !m.member.permissions.has(P.Administrator)) return;
  if (cmd.private) { quietDelete(m); return tempReply(m.channel, '🔒 이 명령어는 보안을 위해 슬래시(/)로만 사용할 수 있어요.'); }
  const argStr = body.slice(word.length).trim();
  m.isSlash = false; m.args0 = argStr.split(/\s+/)[0] || null;
  health.cmds++;
  try { await cmd.run(m, argStr.split(/\s+/).filter(Boolean), argStr); }
  catch (e) {
    health.errs++; health.lastErr = Date.now(); console.error(`[${word}]`, e);
    m.reply('⚠️ 오류: ' + String(e.message || e).slice(0, 200)).catch(() => {});
  }
});

// ── 관리 로그 ──
client.on(Events.MessageDelete, m => {
  if (!m.guild || m.partial || m.author?.bot || silentDel.has(m.id)) return;
  log(m.guild, new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 메시지 삭제').addFields(
    { name: '작성자', value: `${m.author} (${m.author.id})`, inline: true }, { name: '채널', value: `${m.channel}`, inline: true },
    { name: '내용', value: cut(m.content) },
    ...(m.attachments.size ? [{ name: '첨부', value: cut(m.attachments.map(a => a.url).join('\n')) }] : [])));
});
client.on(Events.MessageUpdate, (o, n) => {
  if (!n.guild || o.partial || n.author?.bot || o.content === n.content) return;
  log(n.guild, new EmbedBuilder().setColor(0x3498db).setTitle('✏️ 메시지 수정').setURL(n.url).addFields(
    { name: '작성자', value: `${n.author}`, inline: true }, { name: '채널', value: `${n.channel}`, inline: true },
    { name: '수정 전', value: cut(o.content) }, { name: '수정 후', value: cut(n.content) }));
});
client.on(Events.GuildMemberAdd, m => log(m.guild, new EmbedBuilder().setColor(0x2ecc71).setTitle('📥 멤버 입장')
  .setDescription(`${m.user} (${m.user.tag})\n계정 생성: ${ts(m.user.createdTimestamp)}`).setThumbnail(m.user.displayAvatarURL())));
client.on(Events.GuildMemberRemove, m => log(m.guild, new EmbedBuilder().setColor(0x95a5a6).setTitle('📤 멤버 퇴장')
  .setDescription(`${m.user} (${m.user.tag})`).setThumbnail(m.user.displayAvatarURL())));
client.on(Events.VoiceStateUpdate, (o, n) => {
  if (o.channelId === n.channelId || n.member?.user.bot) return;
  const t = !o.channelId ? `🔊 ${n.member} → ${n.channel} 입장` : !n.channelId ? `🔇 ${o.member} ← ${o.channel} 퇴장` : `🔀 ${n.member}: ${o.channel} → ${n.channel}`;
  log(n.guild, new EmbedBuilder().setColor(0x9b59b6).setTitle('🎙️ 음성 채널').setDescription(t));
});
async function auditExec(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return logs.entries.find(e => e.target?.id === targetId && Date.now() - e.createdTimestamp < 15000);
  } catch { return null; }
}
for (const [ev, type, title, color] of [[Events.GuildBanAdd, AuditLogEvent.MemberBanAdd, '🔨 차단 (외부)', 0xe74c3c], [Events.GuildBanRemove, AuditLogEvent.MemberBanRemove, '✅ 차단 해제 (외부)', 0x2ecc71]])
  client.on(ev, async b => {
    const e = await auditExec(b.guild, type, b.user.id);
    if (e?.executor?.id === client.user.id) return;
    log(b.guild, new EmbedBuilder().setColor(color).setTitle(title).addFields(
      { name: '대상', value: `${b.user} (${b.user.id})`, inline: true }, { name: '관리자', value: e?.executor ? `${e.executor}` : '알 수 없음', inline: true },
      { name: '사유', value: cut(e?.reason ?? b.reason) }));
  });

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
client.login(TOKEN);
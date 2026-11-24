// 웹 콘솔 연동 (봇 쪽). index.js 에서: require('./webapi')({ client, queues, C })
// .env 필요: WEB_SYNC_URL, WEB_SYNC_SECRET, WEB_GUILD_ID (콘솔이 조작할 서버 ID)
const { PermissionFlagsBits: P } = require('discord.js');
const crypto = require('crypto');

module.exports = ({ client, queues, C, db, vApi }) => {
  const BASE = (process.env.WEB_SYNC_URL || '').replace(/\/$/, ''), SECRET = process.env.WEB_SYNC_SECRET;
  const GUILD_ID = process.env.WEB_GUILD_ID;
  const EVERY = Math.max(2, +process.env.WEB_POLL_SEC || 5) * 1000;
  if (!BASE || !SECRET) return console.warn('[webapi] .env 에 WEB_SYNC_URL / WEB_SYNC_SECRET 이 없어서 웹 연동을 켜지 않아요.');
  if (!GUILD_ID) return console.warn('[webapi] .env 에 WEB_GUILD_ID 가 없어서 웹 연동을 켜지 않아요. (콘솔이 조작할 서버 ID)');

  const guild = () => client.guilds.cache.get(GUILD_ID);
  const qrs = new Map(); // 웹 QR 로그인 진행 상태: id -> { uid, status(pending|done|error|expired), msg }
  const capture = () => { const o = { v: null }; o.fn = async x => { o.v = x; return { edit: async y => { o.v = y; } }; }; return o; };
  // 명령어 run() 이 기대하는 모양의 가짜 메시지 객체. index.js 의 target()/check()/modLog() 등은
  // 전부 index.js 내부 클로저라 여기서 다시 구현하지 않고, C[cmd].run() 을 그대로 호출해 재사용함.
  async function fakeM(actingId, voiceChannelId) {
    const g = guild(); if (!g) throw new Error('봇이 그 서버에 없어요.');
    const member = await g.members.fetch(actingId).catch(() => null);
    if (!member) throw new Error('그 서버의 멤버가 아니에요. 먼저 디스코드 서버에 들어와 주세요.');
    const rep = capture();
    return {
      m: {
        guild: g, author: member.user, member, isSlash: true,
        channel: g.channels.cache.get(process.env.WEB_TEXT_CHANNEL_ID) ?? { send: async () => null }, // 선택: .env 의 WEB_TEXT_CHANNEL_ID 채널에 봇 안내 메시지(재생 시작 등)가 올라감
        mentions: { users: { first: () => null }, channels: { first: () => null } },
        reply: rep.fn,
        ...(voiceChannelId ? { member: Object.assign(member, {}) } : {}),
      },
      rep, member,
    };
  }
  function withVoice(m, member, g, channelId) {
    // play 명령어는 m.member.voice.channel 만 읽으므로, 실제 음성 채널 객체를 그 자리에 끼워 넣음
    const ch = g.channels.cache.get(channelId);
    return { ...m, member: { ...member, voice: { channel: ch } } };
  }

  // 작업 종류 → { admin(관리자 권한 필요 여부), build(data) => { cmd, args, argStr, voiceChannelId } }
  const JOBS = {
    status: { build: () => ({ cmd: null }) }, // 아래서 특별 처리
    channels: { build: () => ({ cmd: null }) },
    play: { build: d => ({ cmd: 'play', args: [String(d.query ?? '')], argStr: String(d.query ?? ''), voiceChannelId: d.channelId }) },
    skip: { build: () => ({ cmd: 'skip', args: [], argStr: '' }) },
    pause: { build: () => ({ cmd: 'pause', args: [], argStr: '' }) },
    resume: { build: () => ({ cmd: 'resume', args: [], argStr: '' }) },
    stop: { build: () => ({ cmd: 'stop', args: [], argStr: '' }) },
    queue: { build: () => ({ cmd: 'queue', args: [], argStr: '' }) },
    vaccounts: { build: () => ({ cmd: null }) }, // 아래서 특별 처리
    loop: { build: d => ({ cmd: 'loop', args: [String(d.mode ?? '')], argStr: String(d.mode ?? '') }) },
    leave: { build: () => ({ cmd: 'leave', args: [], argStr: '' }) },
    kick: { admin: true, build: d => ({ cmd: 'kick', args: [String(d.userId ?? ''), d.reason ?? ''], argStr: `${d.userId ?? ''} ${d.reason ?? ''}`.trim() }) },
    clearwarns: { admin: true, build: d => ({ cmd: 'clearwarns', args: [String(d.userId ?? '')], argStr: String(d.userId ?? '') }) },
    overview: { build: () => ({ cmd: null }) },
    music: { build: () => ({ cmd: null }) },
    members: { admin: true, build: () => ({ cmd: null }) },
    warnings: { admin: true, build: () => ({ cmd: null }) },
    qrstart: { build: () => ({ cmd: null }) },
    qrstatus: { build: () => ({ cmd: null }) },
    shop: { build: d => ({ cmd: 'vshop', args: [String(d.account || '-'), String(d.view || 'daily')], argStr: `${d.account || '-'} ${d.view || 'daily'}` }) }, // 발로란트 상점 (본인 계정만)
    volume: { build: d => ({ cmd: 'volume', args: [String(d.level ?? '')], argStr: String(d.level ?? '') }) },
    warn: { admin: true, build: d => ({ cmd: 'warn', args: [String(d.userId ?? ''), d.reason ?? ''], argStr: `${d.userId ?? ''} ${d.reason ?? ''}`.trim() }) },
    ban: { admin: true, build: d => ({ cmd: 'ban', args: [String(d.userId ?? ''), d.reason ?? ''], argStr: `${d.userId ?? ''} ${d.reason ?? ''}`.trim() }) },
    unban: { admin: true, build: d => ({ cmd: 'unban', args: [String(d.userId ?? ''), d.reason ?? ''], argStr: `${d.userId ?? ''} ${d.reason ?? ''}`.trim() }) },
    mute: { admin: true, build: d => ({ cmd: 'mute', args: [String(d.userId ?? ''), d.duration ?? '', d.reason ?? ''].filter(Boolean), argStr: `${d.userId ?? ''} ${d.duration ?? ''} ${d.reason ?? ''}`.trim() }) },
    unmute: { admin: true, build: d => ({ cmd: 'unmute', args: [String(d.userId ?? '')], argStr: String(d.userId ?? '') }) },
  };

  async function runJob(job) {
    const def = JOBS[job.type]; if (!def) return { error: '알 수 없는 작업: ' + job.type };
    const actingId = job.actingUserId; if (!actingId) return { error: '로그인 정보가 없어요. 다시 로그인해 주세요.' };
    const g = guild(); if (!g) return { error: '봇이 설정된 서버에 없어요.' };

    if (job.type === 'status') return { ok: true, ping: client.ws.ping, guilds: client.guilds.cache.size, voice: queues.size, uptimeSec: Math.round(process.uptime()) };
    if (job.type === 'channels') return { channels: [...g.channels.cache.filter(c => c.isVoiceBased()).values()].map(c => ({ id: c.id, name: c.name })) };

    const member = await g.members.fetch(actingId).catch(() => null);
    if (!member) return { error: '서버 멤버가 아니에요.' };
    if (def.admin && !member.permissions.has(P.Administrator)) return { error: '❌ 관리자 권한이 필요해요.' };
    if (job.type === 'vaccounts') // 로그인한 본인이 /vlogin 으로 등록한 계정 목록 (토큰/쿠키는 보내지 않음)
      return { accounts: (db?.vacc?.[actingId] ?? []).map(a => ({ puuid: a.puuid, name: a.name, shard: a.shard })), active: db?.vact?.[actingId] ?? null };
    if (job.type === 'qrstart') { // 발로란트 QR 로그인 시작: QR 이미지를 돌려주고, 승인 대기는 봇이 백그라운드에서 처리
      if (!vApi) return { error: '봇의 index.js 를 새 버전으로 교체해 주세요. (QR 로그인 연결 누락)' };
      let QRCode; try { QRCode = require('qrcode'); } catch { return { error: '서버에서 npm i qrcode 를 실행한 뒤 봇을 재시작해 주세요.' }; }
      for (const v of qrs.values()) if (v.uid === actingId && v.status === 'pending') return { error: '이미 진행 중인 QR 로그인이 있어요. 끝나거나 만료된 뒤에 다시 시도해 주세요.' };
      const s = await vApi.qrStart(), id = crypto.randomUUID(), st = { uid: actingId, status: 'pending', msg: '' };
      qrs.set(id, st);
      (async () => {
        try {
          for (let n = 0; n < 40; n++) { // 3초 간격 최대 2분
            await new Promise(r => setTimeout(r, 3000));
            const j = await vApi.qrPoll(s).catch(() => null);
            if (j?.type !== 'success') continue;
            const r = await vApi.vDoLogin(actingId, await vApi.qrAccess(j.success.login_token), null);
            if (r.ok) { st.status = 'done'; st.msg = `${r.s.name} (${r.s.shard.toUpperCase()}) 로그인 완료`; } else { st.status = 'error'; st.msg = r.content; }
            return;
          }
          st.status = 'expired'; st.msg = 'QR 이 만료됐어요. 닫고 다시 시도해 주세요.';
        } catch (e) { st.status = 'error'; st.msg = String(e.message || e); }
        finally { setTimeout(() => qrs.delete(id), 600000); }
      })();
      return { id, png: await QRCode.toDataURL(s.url, { width: 240, margin: 1, errorCorrectionLevel: 'L' }) };
    }
    if (job.type === 'qrstatus') {
      const st = qrs.get(String(job.data?.id ?? ''));
      return !st || st.uid !== actingId ? { status: 'none' } : { status: st.status, msg: st.msg };
    }
    if (job.type === 'overview') return { name: g.name, members: g.memberCount, channels: g.channels.cache.size, roles: g.roles.cache.size, ping: client.ws.ping, uptimeSec: Math.round(process.uptime()), voice: queues.size, playing: [...queues.values()].filter(q => q.current).length };
    if (job.type === 'music') { // 재생 상태를 구조화해서 전달 (웹에서 진행 막대/대기열을 그림)
      const q = queues.get(g.id), cur = q?.current;
      return { active: !!q, status: q?.player?.state?.status ?? 'idle', loop: q?.loop ?? 'off', volume: q ? Math.round(q.volume * 100) : (db?.guilds?.[g.id]?.volume ?? 50),
        current: cur ? { title: cur.title, url: cur.url, duration: cur.duration, by: cur.by } : null, elapsed: cur && q.startedAt ? (Date.now() - q.startedAt) / 1000 : 0,
        songs: (q?.songs ?? []).slice(0, 15).map(s => ({ title: s.title, duration: s.duration, by: s.by })), total: q?.songs?.length ?? 0 };
    }
    if (job.type === 'members') { // 멤버 검색 (관리자 전용)
      const query = String(job.data?.query ?? '').slice(0, 32); if (!query) return { members: [] };
      const found = await g.members.search({ query, limit: 8 });
      return { members: [...found.values()].map(m => ({ id: m.id, name: m.displayName, tag: m.user.username, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot, muted: m.isCommunicationDisabled() })) };
    }
    if (job.type === 'warnings') { // 경고 기록 (관리자 전용)
      const list = db?.guilds?.[g.id]?.warns?.[String(job.data?.userId ?? '')] ?? [];
      return { total: list.length, warnings: list.slice(-10).reverse().map(w => ({ reason: w.reason, date: w.date })) };
    }

    const { cmd, args, argStr, voiceChannelId } = def.build(job.data ?? {});
    const made = await fakeM(actingId, voiceChannelId).catch(e => ({ error: e.message }));
    if (made.error) return { error: made.error };
    const { m, rep } = made;
    const useM = voiceChannelId ? withVoice(m, member, g, voiceChannelId) : m;
    try {
      if (!C[cmd]) return { error: '봇에 없는 명령어예요: ' + cmd };
      await C[cmd].run(useM, args, argStr);
      const msg = rep.v;
      if (typeof msg === 'string' && msg.startsWith('❌')) return { error: msg.replace(/^❌\s*/, '') }; // 명령어가 거부한 경우는 오류로 표시
      return { ok: true, message: msg && typeof msg === 'object' ? { ...msg, components: undefined } : msg }; // 버튼(components)은 웹에서 안 쓰므로 제외
    } catch (e) { console.error(`[webapi] ${job.type} 작업 오류:`, e); return { error: String(e.message || e) }; } // 원인 추적용: 자세한 오류는 봇 콘솔에 남김
  }

  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'x-secret': SECRET, 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
  };

  let busy = false, state = null;
  setInterval(async () => {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      const { jobs } = await call('/bot/jobs');
      if (state !== 'ok') { state = 'ok'; console.log('[webapi] 웹 콘솔 연결됨'); }
      for (const j of jobs) await call('/bot/result', { id: j.id, result: await runJob(j).catch(e => { console.error(`[webapi] ${j.type} 작업 오류:`, e); return { error: String(e.message || e) }; }) });
    } catch (e) {
      if (state !== e.message) { state = e.message; console.error('[webapi] 웹 콘솔 연결 실패:', e.message); }
    } finally { busy = false; }
  }, EVERY);
  console.log(`[webapi] ${BASE} 를 ${EVERY / 1000}초마다 확인해요 (서버: ${GUILD_ID})`);
};

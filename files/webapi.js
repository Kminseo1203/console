// 웹 콘솔 연동 (봇 쪽). index.js 에서: require('./webapi')({ client, queues, C })
// .env 필요: WEB_SYNC_URL, WEB_SYNC_SECRET, WEB_GUILD_ID (콘솔이 조작할 서버 ID)
const { PermissionFlagsBits: P, Collection } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');

module.exports = ({ client, queues, C, db, vApi, src }) => {
  const BASE = (process.env.WEB_SYNC_URL || '').replace(/\/$/, ''), SECRET = process.env.WEB_SYNC_SECRET;
  const GUILD_ID = process.env.WEB_GUILD_ID;
  const EVERY = Math.max(2, +process.env.WEB_POLL_SEC || 5) * 1000;
  if (!BASE || !SECRET) return console.warn('[webapi] .env 에 WEB_SYNC_URL / WEB_SYNC_SECRET 이 없어서 웹 연동을 켜지 않아요.');
  if (!GUILD_ID) return console.warn('[webapi] .env 에 WEB_GUILD_ID 가 없어서 웹 연동을 켜지 않아요. (콘솔이 조작할 서버 ID)');

  const guild = () => client.guilds.cache.get(GUILD_ID);
  const qrs = new Map(); // 웹 QR 로그인 진행 상태: id -> { uid, status(pending|done|error|expired), msg }
  const capture = () => { const o = { v: null, all: [] }; o.fn = async x => { o.v = x; const k = o.all.push(x) - 1; return { edit: async y => { o.v = y; o.all[k] = y; } }; }; return o; };
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
    cmdlist: { build: () => ({ cmd: null }) },
    cmd: { build: () => ({ cmd: null }) },
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


  // ── 모든 명령어(C 의 slash 정의)를 웹에서 실행: 폼 정보(cmdlist)와 실행(cmd) ──
  const EXCLUDE = new Set(['vlogin', 'help']); // vlogin 은 웹 전용 QR 로그인이 따로 있음
  const NEED_CH = new Set(['purge', 'slowmode', 'lock', 'unlock']); // 실제 텍스트 채널이 필요한 명령어
  const optSchema = o => ({ name: o.name, t: o.t, desc: o.desc, req: !!o.req, min: o.min, max: o.max, choices: o.choices?.map(c => (Array.isArray(c) ? { name: c[0], value: c[1] } : { name: String(c), value: String(c) })) });
  const findUser = async (g, v) => {
    const id = /^<@!?(\d+)>$/.exec(v)?.[1] ?? (/^\d{15,20}$/.test(v) ? v : null);
    if (id) return client.users.fetch(id).catch(() => null);
    const found = await g.members.search({ query: v.slice(0, 32), limit: 1 }).catch(() => null);
    return found?.first?.()?.user ?? [...(found?.values?.() ?? [])][0]?.user ?? null;
  };
  const defaultArgs = (cmd, o) => {
    const out = [];
    for (const x of cmd.slash.opts) {
      if (x.t === 'user') { const u = o.getUser(x.name); if (u) out.push(`<@${u.id}>`); }
      else if (x.t === 'str') { const v = o.getString(x.name); if (v) out.push(v); }
      else if (x.t === 'int') { const v = o.getInteger(x.name); if (v != null) out.push(String(v)); }
      else if (x.t === 'ch') { const c = o.getChannel(x.name); if (c) out.push(`<#${c.id}>`); }
    }
    return out.join(' ');
  };

  // 명령어 응답의 첨부 이미지(files)와 임베드의 attachment:// 이미지를 웹에서 볼 수 있게 data URL 로 변환 (너무 크면 생략)
  const mimeOf = n => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[String(n).split('.').pop().toLowerCase()];
  function packMsg(x) {
    if (!x || typeof x !== 'object') return x;
    const byName = {}, images = []; let total = 0, tooBig = false;
    for (const f of x.files ?? []) {
      const name = String(f?.name ?? ''), mime = mimeOf(name); let a = f?.attachment, src = null;
      if (typeof a === 'string' && !/^https?:\/\//.test(a)) { try { a = fs.readFileSync(a); } catch { a = null; } }
      if (mime && (Buffer.isBuffer(a) || a instanceof Uint8Array)) src = `data:${mime};base64,${Buffer.from(a).toString('base64')}`;
      else if (typeof a === 'string' && /^https:\/\//.test(a)) src = a;
      if (!src) continue;
      total += src.length; if (total > 1500000) { tooBig = true; break; }
      byName[name] = src; images.push({ name, src });
    }
    const embeds = (x.embeds ?? []).map(e => {
      const p = e?.toJSON ? e.toJSON() : { ...e };
      for (const k of ['image', 'thumbnail']) { const u = p[k]?.url; if (typeof u === 'string' && u.startsWith('attachment://')) p[k] = byName[u.slice(13)] ? { ...p[k], url: byName[u.slice(13)] } : undefined; }
      return p;
    });
    const used = new Set(embeds.flatMap(e => [e.image?.url, e.thumbnail?.url]));
    return { content: x.content ?? null, embeds, images: images.filter(i => !used.has(i.src)), note: tooBig ? '이미지가 너무 커서 웹에 표시하지 못했어요. 디스코드에서 확인해 주세요.' : undefined };
  }

  async function runCmd(job, g, member) {
    const d = job.data ?? {}, name = String(d.name ?? ''), cmd = C[name];
    if (!cmd?.slash || EXCLUDE.has(name)) return { error: '웹에서 쓸 수 없는 명령어예요: ' + name };
    if (cmd.admin && !member.permissions.has(P.Administrator)) return { error: '관리자 권한이 필요해요.' };
    const vals = d.values ?? {}, res = {};
    for (const o of cmd.slash.opts) {
      const v = String(vals[o.name] ?? '').trim();
      if (!v) { if (o.req && o.t !== 'att') return { error: `'${o.desc}' 항목을 입력해 주세요.` }; continue; }
      if (o.t === 'str') res[o.name] = v;
      else if (o.t === 'int') { const n = parseInt(v); if (!Number.isFinite(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max)) return { error: `'${o.desc}' 에 올바른 숫자를 입력해 주세요.` }; res[o.name] = n; }
      else if (o.t === 'user') { const u = await findUser(g, v); if (!u) return { error: `유저를 찾지 못했어요: ${v}` }; res[o.name] = u; }
      else if (o.t === 'ch') { const c = g.channels.cache.get(v) ?? g.channels.cache.find(x => x.name === v); if (!c) return { error: '채널을 찾지 못했어요.' }; res[o.name] = c; }
      else if (o.t === 'role') { const r = g.roles.cache.get(v) ?? g.roles.cache.find(x => x.name === v); if (!r) return { error: `역할을 찾지 못했어요: ${v}` }; res[o.name] = r; }
    }
    const by = t => n => (cmd.slash.opts.find(o => o.name === n)?.t === t ? res[n] ?? null : null);
    const options = { getString: by('str'), getInteger: by('int'), getUser: by('user'), getChannel: by('ch'), getRole: by('role'), getAttachment: () => null };
    const argStr = cmd.slash.toArgs ? cmd.slash.toArgs({ options, user: member.user, member, guild: g }) : defaultArgs(cmd, options);
    const args = argStr.split(/\s+/).filter(Boolean);
    const pick = id => { const c = id && g.channels.cache.get(String(id)); return c?.isTextBased?.() ? c : null; };
    const channel = pick(d.channelId) ?? pick(process.env.WEB_TEXT_CHANNEL_ID);
    if (NEED_CH.has(name) && !pick(d.channelId)) return { error: '실행할 채널을 골라 주세요.' };
    const vc = d.voiceChannelId && g.channels.cache.get(String(d.voiceChannelId));
    const first = t => { const o = cmd.slash.opts.find(x => x.t === t); return o ? res[o.name] ?? null : null; };
    const rep = capture();
    const m = {
      isSlash: true, id: job.id, client, author: member.user, guild: g, channel: channel ?? { send: async () => null }, attachments: new Collection(), args0: args[0],
      member: vc ? Object.create(member, { voice: { value: { channel: vc } } }) : member,
      mentions: { users: { first: () => first('user') }, channels: { first: () => first('ch') } }, reply: rep.fn,
    };
    await Promise.race([cmd.run(m, args, argStr), new Promise((_, rej) => setTimeout(() => rej(new Error('명령어 처리가 너무 오래 걸려요. (60초 초과)')), 60000))]);
    const last = rep.all.at(-1);
    if (typeof last === 'string' && last.startsWith('❌')) return { error: last.replace(/^❌\s*/, '') };
    const messages = rep.all.map(packMsg), nImg = messages.reduce((a, x) => a + (x?.images?.length ?? 0) + (x?.embeds ?? []).filter(e => e.image?.url?.startsWith?.('data:')).length, 0);
    let summary = ''; for (const x of messages) { const t = typeof x === 'string' ? x : (x?.content || x?.embeds?.[0]?.title || x?.embeds?.[0]?.description || ''); if (t) { summary = String(t).replace(/[*_`~]/g, '').replace(/<[^>]+>/g, '').slice(0, 100); break; } }
    if (nImg) summary = (summary ? summary + ' ' : '') + `(이미지 ${nImg}장)`;
    return { summary: summary || '완료', ok: true, messages }; // summary 를 맨 앞에 둠: 최근 실행 목록에서 사용
  }

  async function runJob(job) {
    const def = JOBS[job.type]; if (!def) return { error: '알 수 없는 작업: ' + job.type };
    const actingId = job.actingUserId; if (!actingId) return { error: '로그인 정보가 없어요. 다시 로그인해 주세요.' };
    const g = guild(); if (!g) return { error: '봇이 설정된 서버에 없어요.' };

    if (job.type === 'status') return { ok: true, ping: client.ws.ping, guilds: client.guilds.cache.size, voice: queues.size, uptimeSec: Math.round(process.uptime()) };
    if (job.type === 'channels') return { channels: [...g.channels.cache.filter(c => c.isVoiceBased()).values()].map(c => ({ id: c.id, name: c.name })), text: [...g.channels.cache.filter(c => c.isTextBased() && !c.isVoiceBased() && !c.isThread?.()).values()].map(c => ({ id: c.id, name: c.name })) };

    const member = await g.members.fetch(actingId).catch(() => null);
    if (!member) return { error: '서버 멤버가 아니에요.' };
    if (def.admin && !member.permissions.has(P.Administrator)) return { error: '❌ 관리자 권한이 필요해요.' };
    if (job.type === 'vaccounts') // 로그인한 본인이 /vlogin 으로 등록한 계정 목록 (토큰/쿠키는 보내지 않음)
      return { accounts: (db?.vacc?.[actingId] ?? []).map(a => ({ puuid: a.puuid, name: a.name, shard: a.shard })), active: db?.vact?.[actingId] ?? null };
    if (job.type === 'cmdlist') {
      const isAdmin = member.permissions.has(P.Administrator);
      return { commands: Object.entries(C).filter(([n, c]) => c.slash && !EXCLUDE.has(n) && (isAdmin || !c.admin)).map(([n, c]) => ({ name: n, desc: c.desc, admin: !!c.admin, src: src?.[n] ?? 'index', opts: c.slash.opts.map(optSchema) })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (job.type === 'cmd') return runCmd(job, g, member);
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
      return { ok: true, message: msg && typeof msg === 'object' ? { ...msg, components: undefined, files: undefined } : msg }; // 버튼(components)은 웹에서 안 쓰므로 제외
    } catch (e) { console.error(`[webapi] ${job.type} 작업 오류:`, e); return { error: String(e.message || e) }; } // 원인 추적용: 자세한 오류는 봇 콘솔에 남김
  }

  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'x-secret': SECRET, 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) }); // 이미지 결과를 올릴 때를 위해 넉넉히
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

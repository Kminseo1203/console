// Cloudflare Worker: 웹 콘솔 ↔ D1 ↔ 봇 중계. 로그인은 "Discord로 로그인"(OAuth2) 만 사용 —
// 비밀번호를 따로 만들지 않고, "이 사람이 디스코드의 누구인지"만 확인함.
// 관리자 권한(경고/밴/뮤트)은 이 Worker 가 아니라 "봇"이 서버 멤버 정보로 직접 재검증함 (webapi.js).
//
// 필요한 설정 (Cloudflare Pages/Workers 프로젝트 → Settings):
//   D1 바인딩 이름: DB
//   환경변수(Secret 권장): BOT_SYNC_SECRET, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, COOKIE_SECURE(선택, 기본 true)
//   DISCORD_REDIRECT_URI 는 "https://이프로젝트주소/auth/callback" 이어야 하고,
//   디스코드 개발자 포털 → 해당 봇 앱 → OAuth2 → Redirects 에도 똑같이 등록해야 함.
const json = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const same = (a, b) => { a = String(a ?? ''); b = String(b ?? ''); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const PANELS = ['/shop', '/music', '/mod', '/cmd']; // 패널별 주소 (모두 같은 index.html 을 보여주고 화면에서 패널을 고름)
const cookie = (req, name) => (req.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='))?.slice(name.length + 1);

async function getSession(env, req) {
  const token = cookie(req, 'session'); if (!token) return null;
  const row = await env.DB.prepare('SELECT discord_id, username FROM sessions WHERE token = ? AND created > ?').bind(token, Date.now() - 604800000).first(); // 7일 지난 세션은 무효
  return row ? { discordId: row.discord_id, username: row.username } : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    const secureFlag = env.COOKIE_SECURE === '0' ? '' : ' Secure;';

    /* ── 디스코드 로그인 (OAuth2, identify 스코프만 — 서버 목록/권한은 요청하지 않음) ── */
    if (p === '/auth/login') {
      const u = new URL('https://discord.com/oauth2/authorize');
      u.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
      u.searchParams.set('redirect_uri', env.DISCORD_REDIRECT_URI);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'identify');
      const state = crypto.randomUUID(); // 로그인 요청 위조(CSRF) 방지
      u.searchParams.set('state', state);
      const next = url.searchParams.get('next'); // 로그인 끝나면 돌아갈 패널
      const lh = new Headers({ Location: u.toString() });
      lh.append('Set-Cookie', `oauth_state=${state}; HttpOnly;${secureFlag} Path=/auth; Max-Age=600; SameSite=Lax`);
      lh.append('Set-Cookie', `oauth_next=${PANELS.includes(next) ? next : '/'}; HttpOnly;${secureFlag} Path=/auth; Max-Age=600; SameSite=Lax`);
      return new Response(null, { status: 302, headers: lh });
    }
    if (p === '/auth/callback') {
      const code = url.searchParams.get('code'); if (!code) return json({ error: 'missing code' }, 400);
      const st = url.searchParams.get('state');
      if (!st || !same(st, cookie(request, 'oauth_state'))) return json({ error: '로그인 요청이 올바르지 않아요. 다시 시도해 주세요.' }, 400);
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: env.DISCORD_REDIRECT_URI }),
      });
      if (!tokenRes.ok) return json({ error: '디스코드 인증에 실패했어요.' }, 401);
      const { access_token } = await tokenRes.json();
      const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
      if (!meRes.ok) return json({ error: '사용자 정보를 가져오지 못했어요.' }, 401);
      const me = await meRes.json();
      const token = crypto.randomUUID() + crypto.randomUUID();
      await env.DB.prepare('DELETE FROM sessions WHERE created < ?').bind(Date.now() - 604800000).run();
      await env.DB.prepare('INSERT INTO sessions (token, discord_id, username, created) VALUES (?, ?, ?, ?)').bind(token, me.id, `${me.username}`, Date.now()).run();
      const nx = cookie(request, 'oauth_next');
      const h = new Headers({ Location: PANELS.includes(nx) ? nx : '/' });
      h.append('Set-Cookie', `session=${token}; HttpOnly;${secureFlag} Path=/; Max-Age=604800; SameSite=Lax`);
      h.append('Set-Cookie', `oauth_state=; HttpOnly;${secureFlag} Path=/auth; Max-Age=0`);
      h.append('Set-Cookie', `oauth_next=; HttpOnly;${secureFlag} Path=/auth; Max-Age=0`);
      return new Response(null, { status: 302, headers: h });
    }
    if (p === '/auth/logout') {
      const token = cookie(request, 'session'); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': `session=; HttpOnly;${secureFlag} Path=/; Max-Age=0` } });
    }
    if (p === '/auth/me') { const s = await getSession(env, request); return json(s ? { loggedIn: true, username: s.username } : { loggedIn: false }); }

    if (PANELS.includes(p.replace(/\/+$/, ''))) return env.ASSETS.fetch(new Request(new URL('/', request.url), request)); // /shop 등은 index.html 로
    if (!p.startsWith('/api/') && !p.startsWith('/bot/')) return env.ASSETS.fetch(request);
    if (!env.DB) return json({ error: 'D1 바인딩 DB 가 없어요 (Settings → Bindings)' }, 500);

    try {
      /* ── 봇 전용 (공유 비밀키로만 접근) ── */
      if (p.startsWith('/bot/')) {
        if (!env.BOT_SYNC_SECRET || !same(request.headers.get('x-secret'), env.BOT_SYNC_SECRET)) return json({ error: 'unauthorized' }, 401);
        if (p === '/bot/jobs') {
          const { results } = await env.DB.prepare("SELECT id, type, data, actor FROM jobs WHERE status = 'pending' ORDER BY created LIMIT 10").all();
          for (const j of results) await env.DB.prepare("UPDATE jobs SET status = 'taken' WHERE id = ?").bind(j.id).run();
          if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM jobs WHERE created < ?').bind(Date.now() - 3600000).run(); // 1시간 지난 기록 정리 (가끔만)
          return json({ jobs: results.map(j => ({ id: j.id, type: j.type, data: j.data ? JSON.parse(j.data) : null, actingUserId: j.actor })) });
        }
        if (p === '/bot/result' && request.method === 'POST') {
          const b = await request.json();
          await env.DB.prepare("UPDATE jobs SET status = 'done', result = ? WHERE id = ?").bind(JSON.stringify(b.result ?? null), String(b.id)).run();
          return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
      }

      /* ── 브라우저용: 로그인(세션 쿠키) 필요 ── */
      const session = await getSession(env, request);
      if (!session) return json({ error: '로그인이 필요해요.' }, 401);

      if (p === '/api/job' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type ?? '');
        if (!type || type.length > 40) return json({ error: '잘못된 요청이에요.' }, 400);
        const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE actor = ? AND created > ?').bind(session.discordId, Date.now() - 60000).first();
        if ((recent?.n ?? 0) >= 20) return json({ error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }, 429);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO jobs (id, type, data, actor, status, created) VALUES (?, ?, ?, ?, 'pending', ?)")
          .bind(id, type, JSON.stringify(b.data ?? {}), session.discordId, Date.now()).run();
        return json({ id });
      }
      if (p === '/api/result') {
        const row = await env.DB.prepare('SELECT status, result FROM jobs WHERE id = ? AND actor = ?').bind(url.searchParams.get('id') ?? '', session.discordId).first(); // 본인이 만든 작업만 조회
        if (!row) return json({ status: 'none' }, 404);
        return json({ status: row.status, result: row.result ? JSON.parse(row.result) : null });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

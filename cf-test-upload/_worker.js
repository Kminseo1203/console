// 폴링 방식 시험: 브라우저 → (작업 등록) → D1 → 봇이 5초마다 가져가 실행 → 결과 저장 → 브라우저가 조회
// 필요한 설정: D1 바인딩 이름 DB, 시크릿 BOT_SYNC_SECRET
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });
const same = (a, b) => {
  a = String(a ?? ''); b = String(b ?? '');
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    if (!p.startsWith('/api/') && !p.startsWith('/bot/')) return env.ASSETS.fetch(request);
    if (!env.DB) return json({ error: 'D1 바인딩 DB 가 없어요 (Settings → Bindings)' }, 500);
    try {
      // ── 봇 전용 (비밀 키 필요) ──
      if (p.startsWith('/bot/')) {
        if (!env.BOT_SYNC_SECRET || !same(request.headers.get('x-secret'), env.BOT_SYNC_SECRET)) return json({ error: 'unauthorized' }, 401);
        if (p === '/bot/jobs') {
          const { results } = await env.DB.prepare("SELECT id, type, data FROM jobs WHERE status = 'pending' ORDER BY created LIMIT 10").all();
          for (const j of results) await env.DB.prepare("UPDATE jobs SET status = 'taken' WHERE id = ?").bind(j.id).run();
          await env.DB.prepare('DELETE FROM jobs WHERE created < ?').bind(Date.now() - 3600000).run(); // 1시간 지난 기록 정리
          return json({ jobs: results.map(j => ({ id: j.id, type: j.type, data: j.data ? JSON.parse(j.data) : null })) });
        }
        if (p === '/bot/result' && request.method === 'POST') {
          const b = await request.json();
          await env.DB.prepare("UPDATE jobs SET status = 'done', result = ? WHERE id = ?").bind(JSON.stringify(b.result ?? null), String(b.id)).run();
          return json({ ok: true });
        }
        return json({ error: 'not found' }, 404);
      }
      // ── 브라우저용 (시험: 인증 없음, ping 작업만 가능) ──
      if (p === '/api/ping' && request.method === 'POST') {
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO jobs (id, type, data, status, created) VALUES (?, 'ping', NULL, 'pending', ?)").bind(id, Date.now()).run();
        return json({ id });
      }
      if (p === '/api/result') {
        const row = await env.DB.prepare('SELECT status, result FROM jobs WHERE id = ?').bind(url.searchParams.get('id') ?? '').first();
        if (!row) return json({ status: 'none' }, 404);
        return json({ status: row.status, result: row.result ? JSON.parse(row.result) : null });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

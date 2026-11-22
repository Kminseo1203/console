// 시험용: Pages → WeirdHost 봇(26130) 연결 확인. 확인 후 삭제/교체할 것.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/botping') {
      if (!env.BOT_URL || !env.BOT_SYNC_SECRET)
        return new Response('환경변수 BOT_URL / BOT_SYNC_SECRET 이 없어요', { status: 500 });
      try {
        const r = await fetch(env.BOT_URL.replace(/\/$/, '') + '/ping', {
          headers: { 'x-secret': env.BOT_SYNC_SECRET },
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response('fetch 실패: ' + e.message, { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};

// Cloudflare Worker：每天定点触发 GitHub Actions workflow_dispatch
// 为什么用这个：GitHub 原生 schedule 不保证准时/必跑，尤其新仓库常漏触发。
// 手动 workflow_dispatch 是 100% 可靠的，所以用一个可靠的外部定时器去"戳"它。
//
// 部署后需在 Worker 的 Settings -> Variables 里配置以下变量（无需重启）：
//   GITHUB_TOKEN   : 你的 Personal Access Token（需 repo 权限）
//   REPO           : 仓库全名，如 chenrenkang702-afk/douyin-auto-fire
//   WORKFLOW_FILE  : 工作流文件名，如 send.yml
//   BRANCH         : 触发分支，如 main
//   TZ_OFFSET      : 你所在的时区相对 UTC 的偏移（小时），北京时间填 8
//   SCHEDULE_HOUR  : 想触发的"当地时间"小时，如 19
//   SCHEDULE_MIN   : 想触发的"当地时间"分钟，如 41
//
// Cloudflare Worker 的 cron 只支持 UTC，且最小粒度是分钟，但无法精确到"某时区某分"。
// 所以这里用 Worker Cron Trigger 每分钟跑一次，在代码里判断"当前 UTC 时间是否等于目标时间"，
// 等于才真正发请求，避免重复触发（用 KV 记录当天是否已触发）。

export default {
  async scheduled(event, env, ctx) {
    await trigger(env);
  },
  // 也支持手动访问 worker 域名立即触发（方便测试），但需绑定路由
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const r = await trigger(env);
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }
    return new Response("OK - worker running. Visit /trigger to fire manually.", { status: 200 });
  },
};

async function trigger(env) {
  const token = env.GITHUB_TOKEN;
  const repo = env.REPO;
  const workflow = env.WORKFLOW_FILE || "send.yml";
  const branch = env.BRANCH || "main";
  const tzOffset = parseInt(env.TZ_OFFSET || "8", 10);
  const targetHour = parseInt(env.SCHEDULE_HOUR || "19", 10);
  const targetMin = parseInt(env.SCHEDULE_MIN || "41", 10);

  if (!token || !repo) {
    return { ok: false, error: "缺少 GITHUB_TOKEN 或 REPO 变量" };
  }

  // 计算"目标时区"下的当前时间
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000; // 转 UTC 毫秒
  const local = new Date(utcMs + tzOffset * 3600000);
  const localHour = local.getHours();
  const localMin = local.getMinutes();
  const dayKey = local.toISOString().slice(0, 10); // 当天日期，用于防重复

  // 判断是否到达目标分钟
  if (localHour !== targetHour || localMin !== targetMin) {
    return { ok: true, fired: false, reason: `当前本地时间 ${localHour}:${String(localMin).padStart(2,"0")} 非目标 ${targetHour}:${String(targetMin).padStart(2,"0")}` };
  }

  // 可选：用 KCF_KV 防止同一天重复触发（需要绑定一个 KV namespace 名为 KV）
  if (env.KV) {
    const done = await env.KV.get(dayKey);
    if (done === "1") {
      return { ok: true, fired: false, reason: `今天 ${dayKey} 已触发过，跳过` };
    }
  }

  const apiUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-worker-trigger",
    },
    body: JSON.stringify({ ref: branch }),
  });

  const status = res.status;
  let body = "";
  try { body = await res.text(); } catch (e) {}

  if (env.KV && status >= 200 && status < 300) {
    await env.KV.put(dayKey, "1");
  }

  return {
    ok: status >= 200 && status < 300,
    fired: true,
    status,
    body: body.slice(0, 500),
    time: local.toISOString(),
  };
}

// Cloudflare Worker — бэкенд для MetaScalp Changelog Generator
//
// Деплой: Cloudflare Dashboard -> Workers & Pages -> metascalp-changelog -> Edit code -> вставить этот файл
//
// Секреты (Settings -> Variables and Secrets, тип Secret):
//   ANTHROPIC_API_KEY  — ключ API Anthropic (console.anthropic.com)
//   GH_TOKEN           — fine-grained GitHub token с доступом Contents: Read/Write только к репо amiinasya/metascalp-changelog
//   JIRA_EMAIL         — email аккаунта Atlassian
//   JIRA_API_TOKEN     — API-токен Atlassian (id.atlassian.com/manage-profile/security/api-tokens)
//
// Переменные (тип Plaintext):
//   GH_REPO   = amiinasya/metascalp-changelog
//   JIRA_SITE = finncraft.atlassian.net

const PAGES_URL = 'https://amiinasya.github.io/metascalp-changelog/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/' ) return Response.redirect(PAGES_URL, 302);

    // ── Прокси к Claude API ────────────────────────────────
    if (url.pathname === '/v1/messages' && request.method === 'POST') {
      const body = await request.text();
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // ── Чтение задач из Jira (REST API, токен не истекает) ──
    if (url.pathname === '/jira' && request.method === 'GET') {
      const keys = (url.searchParams.get('keys') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!keys.length) return json({ error: 'no keys' }, 400);
      const auth = 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
      const issues = await Promise.all(keys.map(async (k) => {
        const r = await fetch(
          `https://${env.JIRA_SITE}/rest/api/3/issue/${encodeURIComponent(k)}?fields=summary,description,issuetype,status`,
          { headers: { Authorization: auth, Accept: 'application/json' } }
        );
        if (!r.ok) return { key: k, error: `HTTP ${r.status}` };
        const d = await r.json();
        return {
          key: k,
          type: d.fields.issuetype && d.fields.issuetype.name,
          status: d.fields.status && d.fields.status.name,
          summary: d.fields.summary,
          description: adfToText(d.fields.description).trim(),
        };
      }));
      return json({ issues });
    }

    // ── Хранилище memory.json / feedback.json в репо ───────
    if (url.pathname.startsWith('/storage/')) {
      const file = url.pathname.slice('/storage/'.length);
      if (!/^(memory|feedback)\.json$/.test(file)) return json({ error: 'bad file' }, 400);
      const ghUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/data/${file}`;
      const ghHeaders = {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'metascalp-changelog-worker',
      };

      if (request.method === 'GET') {
        const r = await fetch(ghUrl, { headers: ghHeaders });
        if (!r.ok) return json({ content: [], sha: null });
        const d = await r.json();
        let content = [];
        try { content = JSON.parse(atob(d.content.replace(/\n/g, ''))); } catch (e) {}
        return json({ content, sha: d.sha });
      }

      if (request.method === 'PUT') {
        const { data, sha } = await request.json();
        const body = {
          message: 'update ' + file,
          content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
        };
        if (sha) body.sha = sha;
        const r = await fetch(ghUrl, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        return json({ ok: r.ok, sha: d.content && d.content.sha }, r.ok ? 200 : r.status);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// Jira отдаёт description в формате Atlassian Document Format — разворачиваем в плоский текст
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.type === 'text') out += node.text || '';
  if (Array.isArray(node.content)) out += node.content.map(adfToText).join('');
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') out += '\n';
  return out;
}

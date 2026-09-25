function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function feishuClient() {
  const appId = Netlify.env.get('LARK_APP_ID');
  const appSecret = Netlify.env.get('LARK_APP_SECRET');
  if (!appId || !appSecret) throw new Error('Missing Feishu credentials');
  let token;
  async function request(path, { method = 'GET', body, authenticate = true } = {}) {
    if (authenticate && !token) {
      const auth = await request('/auth/v3/tenant_access_token/internal', {
        method: 'POST', body: { app_id: appId, app_secret: appSecret }, authenticate: false
      });
      token = auth.tenant_access_token;
    }
    const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(authenticate ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      console.error('Feishu request failed', { path, status: response.status, code: result.code });
      throw new Error('Feishu request failed');
    }
    return result;
  }
  return request;
}

function recordsPath() {
  const base = Netlify.env.get('LARK_BASE_TOKEN') || 'KaMBb89xMaVJt3s7EM8cjCpunje';
  const table = Netlify.env.get('LARK_TABLE_ID') || 'tblcYNomjoVNwNgT';
  return `/bitable/v1/apps/${base}/tables/${table}/records`;
}

async function getRecords(client) {
  const records = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ page_size: '500' });
    if (pageToken) params.set('page_token', pageToken);
    const { data } = await client(`${recordsPath()}?${params}`);
    records.push(...data.items);
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return records;
}

async function notify(client, name, status) {
  const chatId = Netlify.env.get('LARK_CHAT_ID') || 'oc_6c95c15290580989e26de5639ecc1a7e';
  const emojis = { '睡觉中': '😴', '学习中': '📚', '外出中': '🚶', '正常/空闲': '😊', '勿扰': '🚫', '吃饭中': '🍜' };
  await client('/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({
      text: `🏠 室友状态更新\n\n${name} 的状态更新为：${emojis[status] || '❓'} ${status}\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    }) }
  });
}

export default async function handler(request, context) {
  const path = new URL(request.url).pathname;
  if (path === '/api/health' && request.method === 'GET') return json({ ok: true });
  const collection = path === '/api/roommates';
  const member = /^\/api\/roommates\/([^/]+)$/.exec(path);
  if (!collection && !member) return json({ error: 'Not found' }, 404);
  if (!(collection && ['GET', 'POST'].includes(request.method)) && !(member && request.method === 'DELETE')) {
    return json({ error: 'Method not allowed' }, 405);
  }
  let body;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }
    if (!body || typeof body.name !== 'string' || !body.name.trim() || typeof body.status !== 'string' || !body.status.trim() || (body.avatar !== undefined && typeof body.avatar !== 'string')) {
      return json({ error: '名字和状态不能为空，头像须为文本' }, 400);
    }
  }
  try {
    const client = feishuClient();
    const records = await getRecords(client);
    if (request.method === 'GET') {
      return json({ roommates: records.map(({ fields, record_id }) => ({
        name: fields.name, status: fields.status, avatar: fields.avatar || '',
        updatedAt: fields.updated_at, recordId: record_id
      })) });
    }
    if (request.method === 'POST') {
      const { name, status, avatar } = body;
      const existing = records.find(record => record.fields.name === name);
      const fields = { name, status, updated_at: Date.now(), ...(avatar ? { avatar } : {}) };
      // Finish persistence before acknowledging success. No process-local state is authoritative.
      await client(recordsPath() + (existing ? `/${existing.record_id}` : ''), {
        method: existing ? 'PUT' : 'POST', body: { fields }
      });
      const notification = notify(client, name, status).catch(() => console.error('Feishu notification failed'));
      if (context?.waitUntil) context.waitUntil(notification);
      else await notification;
      return json({ success: true });
    }
    let name;
    try { name = decodeURIComponent(member[1]); } catch { return json({ error: '名字格式错误' }, 400); }
    const existing = records.find(record => record.fields.name === name);
    if (existing) await client(`${recordsPath()}/${existing.record_id}`, { method: 'DELETE' });
    return json({ success: true });
  } catch {
    return json({ error: '飞书服务暂不可用，请检查应用凭证及多维表格权限' }, 502);
  }
}

export const config = { path: '/api/*' };

const express = require('express');
const { ProxyAgent, fetch: ufetch } = require('undici');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 禁止缓存，避免 Safari 缓存旧页面/旧隧道地址
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'roommate-status.html'));
});

const CHAT_ID = 'oc_6c95c15290580989e26de5639ecc1a7e';
const BASE_TOKEN = 'KaMBb89xMaVJt3s7EM8cjCpunje';
const TABLE_ID = 'tblcYNomjoVNwNgT';
const APP_ID = process.env.LARK_APP_ID || process.env.LARKSUITE_CLI_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const USER_TOKEN = process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN || '';
// Render 等 PaaS 不需要代理；沙箱环境需要
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const agent = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const API_HOST = 'https://open.feishu.cn/open-apis';

// ========== Token 管理 ==========
// 优先用 app_id + app_secret 获取 tenant_access_token（自动刷新，永不过期）
// 回退到沙箱提供的 user_access_token
let tenantToken = '';
let tokenExpireAt = 0;

async function getAccessToken() {
  // 有 app_secret 时用 tenant_access_token
  if (APP_ID && APP_SECRET) {
    const now = Date.now();
    if (tenantToken && now < tokenExpireAt - 60000) {
      return tenantToken;
    }
    try {
      const resp = await ufetch(`${API_HOST}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
        dispatcher: agent
      });
      const r = await resp.json();
      if (r.code === 0) {
        tenantToken = r.tenant_access_token;
        tokenExpireAt = now + r.expire * 1000;
        console.log('tenant_access_token 已获取，有效期', r.expire, '秒');
        return tenantToken;
      }
      console.error('获取 tenant_access_token 失败:', r.msg);
    } catch (e) {
      console.error('获取 tenant_access_token 异常:', e.message?.substring(0, 100));
    }
  }
  // 回退到 user_access_token
  return USER_TOKEN;
}

const STATUS_EMOJIS = {
  '睡觉中': '😴', '学习中': '📚', '外出中': '🚶',
  '正常/空闲': '😊', '勿扰': '🚫', '吃饭中': '🍜'
};

// ========== 内存缓存 ==========
let recordsCache = null;
let cacheTime = 0;
const CACHE_TTL = 8000;

// ========== 飞书 API（undici 直连，无进程开销） ==========
async function larkApi(method, apiPath, body, params) {
  let url = API_HOST + apiPath;
  if (params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => qs.set(k, typeof v === 'object' ? JSON.stringify(v) : v));
    url += '?' + qs.toString();
  }
  try {
    const token = await getAccessToken();
    const resp = await ufetch(url, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: agent
    });
    const r = await resp.json();
    return { ok: r.code === 0, data: r.data };
  } catch (e) {
    console.error('API error:', e.message?.substring(0, 100));
    return null;
  }
}

// ========== 飞书通知（异步） ==========
async function sendFeishuNotificationAsync(name, status) {
  const emoji = STATUS_EMOJIS[status] || '❓';
  const msg = `🏠 室友状态更新\n\n${name} 的状态更新为：${emoji} ${status}\n⏰ ${new Date().toLocaleString('zh-CN')}`;
  const token = await getAccessToken();
  ufetch(`${API_HOST}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: msg })
    }),
    dispatcher: agent
  }).then(r => r.json()).then(r => {
    if (r.code === 0) console.log('通知已发送:', name, '->', status);
    else console.error('通知失败:', r.msg);
  }).catch(e => console.error('通知异常:', e.message?.substring(0, 80)));
}

// ========== 获取所有记录 ==========
async function getAllRecords() {
  if (recordsCache && Date.now() - cacheTime < CACHE_TTL) {
    return recordsCache;
  }
  const result = await larkApi('GET', `/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`, null, { page_size: 100 });
  if (!result || !result.ok || !result.data || !result.data.items) {
    return recordsCache || [];
  }
  recordsCache = result.data.items.map(item => ({
    name: item.fields.name,
    status: item.fields.status,
    avatar: item.fields.avatar || '',
    updatedAt: item.fields.updated_at,
    recordId: item.record_id
  }));
  cacheTime = Date.now();
  return recordsCache;
}

// 后台刷新（不阻塞，不立即使缓存失效）
function refreshCacheBackground() {
  larkApi('GET', `/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`, null, { page_size: 100 }).then(result => {
    if (result && result.ok && result.data && result.data.items) {
      recordsCache = result.data.items.map(item => ({
        name: item.fields.name,
        status: item.fields.status,
        avatar: item.fields.avatar || '',
        updatedAt: item.fields.updated_at,
        recordId: item.record_id
      }));
      cacheTime = Date.now();
    }
  }).catch(() => {});
}

// ========== API 接口 ==========

app.get('/api/roommates', async (req, res) => {
  const records = await getAllRecords();
  res.json({ roommates: records });
});

app.post('/api/roommates', async (req, res) => {
  const { name, status, avatar } = req.body;
  if (!name || !status) {
    return res.status(400).json({ error: '名字和状态不能为空' });
  }

  const now = Date.now();
  const fields = { name, status, updated_at: now };
  if (avatar) fields.avatar = avatar;

  // 从缓存查找（缓存为空时初始化空数组）
  if (!recordsCache) recordsCache = [];
  const existing = recordsCache.find(r => r.name === name);

  // 乐观更新缓存（立即生效，GET 能马上返回新状态）
  if (existing) {
    existing.status = status;
    existing.avatar = avatar || existing.avatar;
    existing.updatedAt = now;
  } else {
    recordsCache.push({ name, status, avatar: avatar || '', updatedAt: now, recordId: '' });
  }
  // 关键：更新缓存时间，防止紧接着的 GET 去飞书拉旧数据覆盖乐观更新
  cacheTime = Date.now();

  // 立即返回成功
  res.json({ success: true });

  // 后台异步写入飞书 Base + 通知（不阻塞响应）
  (async () => {
    try {
      // 确保缓存已填充（首次请求时缓存为空）
      const allRecs = await getAllRecords();
      const rec = allRecs.find(r => r.name === name);
      let ok = false;
      if (rec && rec.recordId) {
        const r = await larkApi('PUT', `/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${rec.recordId}`, { fields });
        ok = r && r.ok;
      }
      if (!ok) {
        const r = await larkApi('POST', `/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`, { fields });
        if (r && r.ok && r.data && r.data.record_id && rec) {
          rec.recordId = r.data.record_id;
        }
        ok = r && r.ok;
      }
      if (ok) console.log('后台写入成功:', name, '->', status);
      else console.error('后台写入失败:', name);
      refreshCacheBackground();
      sendFeishuNotificationAsync(name, status);
    } catch (e) {
      console.error('后台写入异常:', e.message?.substring(0, 100));
      sendFeishuNotificationAsync(name, status);
    }
  })();
});

app.delete('/api/roommates/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const records = await getAllRecords();
  const existing = records.find(r => r.name === name);
  if (existing && existing.recordId) {
    await larkApi('DELETE', `/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${existing.recordId}`);
  }
  const idx = records.findIndex(r => r.name === name);
  if (idx >= 0) records.splice(idx, 1);
  cacheTime = Date.now();
  refreshCacheBackground();
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

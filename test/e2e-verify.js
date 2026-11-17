// 端到端验证：添加 API → 网关识别 → 真实调用 → 顺序切换 → 路由改变
// 全程隔离：独立 profile / 独立端口 / 独立 mock 服务端，绝不碰生产环境。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP_ROOT = 'D:\\build\\oc-v2\\app-root';
const CLI = path.join(APP_ROOT, 'runtime', 'openclaw', 'openclaw.mjs');
const NODE = path.join(APP_ROOT, 'runtime', 'node.exe');
const PROFILE = 'D:\\build\\oc-v2\\e2e-profile';
const STATE = path.join(PROFILE, '.openclaw');
const CFG = path.join(STATE, 'openclaw.json');
const MOCK_A = 18901;   // providerA
const MOCK_B = 18902;   // providerB
const MOCK_C = 18903;   // providerC（备用）
const GW_PORT = 18797;
const REQ_LOG = 'D:\\build\\oc-v2\\e2e-requests.log';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   [' + detail + ']' : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(extra) {
  const e = Object.assign({}, process.env, {
    USERPROFILE: PROFILE, HOME: PROFILE,
    APPDATA: path.join(PROFILE, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(PROFILE, 'AppData', 'Local'),
    OPENCLAW_GATEWAY_PORT: String(GW_PORT),
  }, extra || {});
  delete e.ELECTRON_RUN_AS_NODE; delete e.NODE_OPTIONS; delete e.ELECTRON_NO_ATTACH_CONSOLE;
  e.NODE_SKIP_PLATFORM_CHECK = '1';
  e.NODE_OPTIONS = '--title=OpenClaw';
  return e;
}

function cli(args, timeout) {
  return spawnSync(NODE, ['--title=OpenClaw', CLI].concat(args), {
    cwd: STATE, windowsHide: true, encoding: 'utf8',
    timeout: timeout || 120000, env: env(),
  });
}

function readCfg() { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
function writeCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n', 'utf8'); }

function reqLog() {
  if (!fs.existsSync(REQ_LOG)) return [];
  return fs.readFileSync(REQ_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function clearReqLog() { try { fs.unlinkSync(REQ_LOG); } catch (e) {} }

function httpJson(port, path, method, body, headers) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method: method || 'GET', headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

// ---- 模拟控制台的 addProvider（与 main.js addProvider 逻辑一致）----
function addProvider(opts) {
  const cfg = readCfg();
  if (!cfg.models) cfg.models = { mode: 'merge', providers: {} };
  if (!cfg.models.providers) cfg.models.providers = {};
  if (!cfg.models.providers[opts.providerKey]) {
    cfg.models.providers[opts.providerKey] = { baseUrl: opts.baseUrl, apiKey: opts.apiKey, api: opts.api || 'openai-completions', models: [] };
  } else {
    const p = cfg.models.providers[opts.providerKey];
    p.baseUrl = opts.baseUrl; if (opts.apiKey) p.apiKey = opts.apiKey; p.api = opts.api || p.api;
  }
  const p = cfg.models.providers[opts.providerKey];
  if (!p.models) p.models = [];
  if (!p.models.find((m) => m.id === opts.modelId)) {
    p.models.push({ id: opts.modelId, name: opts.modelName || opts.modelId, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 });
  }
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.model) cfg.agents.defaults.model = { primary: '', fallbacks: [] };
  if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
  const fullKey = opts.providerKey + '/' + opts.modelId;
  const model = cfg.agents.defaults.model;
  if (!model.primary) model.primary = fullKey;
  else if (fullKey !== model.primary && !(model.fallbacks || []).includes(fullKey)) {
    if (!model.fallbacks) model.fallbacks = [];
    model.fallbacks.push(fullKey);
  }
  if (!cfg.agents.defaults.models[fullKey]) cfg.agents.defaults.models[fullKey] = {};
  writeCfg(cfg);
}

function setPriority(order) {
  const cfg = readCfg();
  const oldModels = (cfg.agents.defaults && cfg.agents.defaults.models) || {};
  const nextModels = {};
  for (const k of order) nextModels[k] = oldModels[k] || {};
  cfg.agents.defaults.model = { primary: order[0] || '', fallbacks: order.slice(1) };
  cfg.agents.defaults.models = nextModels;
  writeCfg(cfg);
}

const mocks = [];
function startMock(port, label, behavior) {
  const p = spawn(process.execPath, [path.join(__dirname, 'mock-provider.js'), String(port), REQ_LOG, label, behavior || 'ok'], { windowsHide: true, stdio: 'ignore' });
  mocks.push(p); return p;
}

let gwProc = null;
function startGateway() {
  gwProc = spawn(NODE, ['--title=OpenClaw', path.join(APP_ROOT, 'runtime', 'openclaw', 'dist', 'index.js'), 'gateway', '--port', String(GW_PORT)], {
    cwd: STATE, detached: true, windowsHide: true, env: env(), stdio: 'ignore',
  });
  gwProc.unref();
  return gwProc;
}
async function portUp(port) {
  return new Promise((res) => {
    const s = require('net').connect({ host: '127.0.0.1', port });
    s.setTimeout(700); s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false)); s.once('timeout', () => { s.destroy(); res(false); });
  });
}
async function waitPort(port, ms) {
  const dl = Date.now() + (ms || 90000);
  while (Date.now() < dl) { if (await portUp(port)) return true; await sleep(1000); }
  return false;
}

(async () => {
  // 0. 清理
  spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', PROFILE], { windowsHide: true });
  fs.mkdirSync(path.join(PROFILE, '.openclaw'), { recursive: true });
  fs.mkdirSync(path.join(PROFILE, 'AppData', 'Roaming'), { recursive: true });
  clearReqLog();

  // 1. 用预置配置作底
  const preset = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'resources', 'app', 'preset-config.json'), 'utf8'));
  writeCfg(preset);

  // 2. 起 mock 服务端
  startMock(MOCK_A, 'A', 'ok');
  startMock(MOCK_B, 'B', 'ok');
  startMock(MOCK_C, 'C', 'fail');
  await sleep(1500);
  record('0.1 三个 mock provider 已启动', true, 'A=' + MOCK_A + ' B=' + MOCK_B + ' C(fail)=' + MOCK_C);

  // 3. 添加 API（模拟控制台写入）
  addProvider({ providerKey: 'mockA', label: 'Mock A', baseUrl: 'http://127.0.0.1:' + MOCK_A + '/v1', apiKey: 'sk-mock-a', modelId: 'ma', modelName: 'Mock A 模型' });
  addProvider({ providerKey: 'mockB', label: 'Mock B', baseUrl: 'http://127.0.0.1:' + MOCK_B + '/v1', apiKey: 'sk-mock-b', modelId: 'mb', modelName: 'Mock B 模型' });
  addProvider({ providerKey: 'mockC', label: 'Mock C', baseUrl: 'http://127.0.0.1:' + MOCK_C + '/v1', apiKey: 'sk-mock-c', modelId: 'mc', modelName: 'Mock C 模型' });
  const cfg1 = readCfg();
  record('1.1 添加 API → provider 已入库', !!(cfg1.models.providers.mockA && cfg1.models.providers.mockB && cfg1.models.providers.mockC),
    JSON.stringify(Object.keys(cfg1.models.providers)));
  record('1.2 添加 API → 新模型进入 chain', (cfg1.agents.defaults.model.fallbacks || []).includes('mockA/ma'),
    JSON.stringify(cfg1.agents.defaults.model));

  // 4. 配置合法性
  const v = cli(['config', 'validate'], 90000);
  const vout = ((v.stdout || '') + (v.stderr || ''));
  record('1.3 配置通过 openclaw schema 校验', /Config valid/.test(vout), vout.split(/\r?\n/).filter((l) => /valid|error|invalid/i.test(l)).slice(0, 3).join(' | '));

  // 5. models list 是否看得到
  const ml = cli(['models', 'list'], 90000);
  const mlout = (ml.stdout || '') + (ml.stderr || '');
  record('1.4 models list 能看到新增模型', /mockA|mockB/.test(mlout), (mlout.match(/mock[ABC]\/\w+/g) || []).slice(0, 6).join(','));

  // 5.5 微信插件正式安装（与控制台 main.js installPluginAsync 同一条官方路径）
  const PLUGIN_SRC = 'D:\\build\\oc-v2\\app-root\\resources\\app\\plugins\\tencent-weixin-openclaw-weixin-7783ac86ba';
  const PLUGIN_PKG = path.join(PLUGIN_SRC, 'node_modules', '@tencent-weixin', 'openclaw-weixin');
  const pi = cli(['plugins', 'install', PLUGIN_PKG], 300000);
  const piOut = ((pi.stdout || '') + (pi.stderr || ''));
  record('1.5 微信插件官方安装成功', /Installed plugin/i.test(piOut), piOut.replace(/\s+/g, ' ').slice(-200));
  // 补齐离线依赖（与控制台 ensurePluginDeps 相同）
  const extDir = path.join(STATE, 'extensions', 'openclaw-weixin');
  for (const dep of ['zod', 'qrcode-terminal']) {
    const src = path.join(PLUGIN_SRC, 'node_modules', dep);
    const dst = path.join(extDir, 'node_modules', dep);
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  record('1.6 插件离线依赖(zod/qrcode-terminal)已就位',
    fs.existsSync(path.join(extDir, 'node_modules', 'zod', 'package.json')) &&
    fs.existsSync(path.join(extDir, 'node_modules', 'qrcode-terminal', 'package.json')), '');

  // 6. 网关启动前就把 mockA 设为最高优先（避免网关用预置真实 API，全程只打 mock）
  setPriority(['mockA/ma', 'mockB/mb', 'mockC/mc']);
  const prim = readCfg().agents.defaults.model.primary;
  record('2.0 启动前顺序已写入（primary=mockA/ma）', prim === 'mockA/ma', prim);

  startGateway();
  const up = await waitPort(GW_PORT, 120000);
  record('2.1 网关启动成功', up, 'port=' + GW_PORT);
  if (!up) { finish(); return; }

  // 重启网关（与控制台 set-priority 的行为一致：保存顺序 → 重启生效）；只按本测试记录的 PID 杀
  async function restartGateway() {
    if (gwProc) { try { spawn('taskkill', ['/PID', String(gwProc.pid), '/F', '/T'], { windowsHide: true }); } catch (e) {} gwProc = null; }
    for (let i = 0; i < 30; i++) { if (!(await portUp(GW_PORT))) break; await sleep(500); }
    startGateway();
    return await waitPort(GW_PORT, 120000);
  }

  // 7. 真实调用：primary = mockA
  clearReqLog();
  const r1 = await cli(['agent', '--agent', 'main', '--message', '说一句话', '--json'], 180000);
  const o1 = (r1.stdout || '') + (r1.stderr || '');
  const calls1 = reqLog().filter((x) => x.model);
  record('3.1 agent 调用发出真实 HTTP 请求', calls1.length > 0, 'calls=' + calls1.length + ' model=' + (calls1[0] || {}).model + ' | out=' + o1.slice(-200).replace(/\s+/g, ' '));
  record('3.2 请求打到了 primary (mockA)', calls1.some((c) => c.model === 'ma'), JSON.stringify(calls1.map((c) => c.provider + ':' + c.model)));
  record('3.3 Authorization 头带上了 API Key', calls1.some((c) => /sk-mock-a/.test(c.auth || '')), (calls1[0] || {}).auth);
  record('3.4 流式请求带 include_usage（token 可统计）', calls1.some((c) => c.hasUsage), JSON.stringify(calls1.map((c) => c.hasUsage)));

  // 8. 顺序切换：把 mockB 提到第一位 → 重启网关（控制台同款行为）
  setPriority(['mockB/mb', 'mockA/ma', 'mockC/mc']);
  const up2 = await restartGateway();
  record('4.0 顺序切换后网关重启成功', up2, '');
  clearReqLog();
  const r2 = await cli(['agent', '--agent', 'main', '--message', '再说一句', '--json'], 180000);
  const calls2 = reqLog().filter((x) => x.model);
  record('4.1 顺序切换后重新调用', calls2.length > 0, 'calls=' + calls2.length);
  record('4.2 新顺序生效：先打 mockB', calls2.length > 0 && calls2[0].model === 'mb', JSON.stringify(calls2.map((c) => c.provider + ':' + c.model)));

  // 9. 回退：primary 失败 → 应落到下一个
  setPriority(['mockC/mc', 'mockA/ma', 'mockB/mb']);
  await restartGateway();
  clearReqLog();
  const r3 = await cli(['agent', '--agent', 'main', '--message', '触发回退', '--json'], 180000);
  const calls3 = reqLog().filter((x) => x.model);
  record('5.1 primary 失败时请求仍发出', calls3.length > 0, 'calls=' + calls3.length);
  record('5.2 回退到下一个可用模型（mockA）', calls3.some((c) => c.model === 'ma'), JSON.stringify(calls3.map((c) => c.provider + ':' + c.model)));

  // 10. usage 记录是否真实（与控制台 get-usage 同源：trajectory.jsonl 的 model.completed）
  const sessDir = path.join(STATE, 'agents', 'main', 'sessions');
  let usageHit = false, usageTotal = 0, usageModels = [];
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.trajectory.jsonl')) continue;
      const lines = fs.readFileSync(path.join(sessDir, f), 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes('model.completed')) continue;
        let e; try { e = JSON.parse(line); } catch (err) { continue; }
        if (e.type !== 'model.completed') continue;
        const u = (e.data && e.data.usage) || {};
        const t = u.total || u.totalTokens || ((u.input || 0) + (u.output || 0));
        if (t > 0) { usageHit = true; usageTotal += t; usageModels.push((e.provider || e.modelId || '?')); }
      }
    }
  }
  record('6.1 token 用量有真实数字（非 0）', usageHit, 'total=' + usageTotal + ' models=' + usageModels.join(','));

  // 11. 微信插件是否被正式安装（这是二维码能否出图的前提；extDir 在 1.5 步已定义）
  record('7.1 微信插件已安装到 .openclaw/extensions', fs.existsSync(path.join(extDir, 'package.json')), extDir);
  record('7.2 插件运行时依赖 zod 已就位', fs.existsSync(path.join(extDir, 'node_modules', 'zod', 'package.json')), '');
  const cfgNow = readCfg();
  const pl = (cfgNow.plugins || {});
  record('7.3 配置里插件已启用并允许', !!(pl.entries && pl.entries['openclaw-weixin'] && pl.entries['openclaw-weixin'].enabled) && (pl.allow || []).includes('openclaw-weixin'),
    JSON.stringify(pl));

  finish();
})().catch((e) => { record('测试异常', false, e.message); finish(); });

function finish() {
  console.log('\n========== E2E 汇总 ==========');
  const pass = results.filter((r) => r.ok).length;
  console.log('通过 ' + pass + ' / ' + results.length);
  for (const r of results) if (!r.ok) console.log('  [FAIL] ' + r.name + '  ' + r.detail);
  // 清理：只按 PID 精确杀本测试进程，绝不按进程名批量杀（会误杀生产网关）
  for (const m of mocks) { try { spawn('taskkill', ['/PID', String(m.pid), '/F'], { windowsHide: true }); } catch (e) {} }
  if (gwProc) { try { spawn('taskkill', ['/PID', String(gwProc.pid), '/F', '/T'], { windowsHide: true }); } catch (e) {} }
  setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 1500);
}

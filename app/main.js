// OpenClaw 控制台 — 发射控制层（v2 重做版）
// 产物目标：Windows 7 SP1 ~ Windows 11 全兼容。
// Win7 兼容要点（全部在运行时层解决，本层只做干净的环境管理）：
//   1. node.exe 已做二进制手术：libuv win/util.c:412 的 assert(process_title)
//      替换为「若为空则置空串」（等价 libuv#4807 官方修复），任何子进程都不可能再 abort；
//   2. hostname-shim.cjs 兜住 GetHostNameW（Win8+ API）缺失的 ENOSYS；
//   3. 启动参数 --title + 环境变量 NODE_OPTIONS 双保险（防其它调用点）。
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerSaveBlocker } = require('electron');
const { execFile, spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- 路径 ----------
const ROOT = path.dirname(process.execPath);          // 安装目录（只读：Electron + OpenClaw）
const RUNTIME = path.join(ROOT, 'runtime');
const NODE = path.join(RUNTIME, 'node.exe');
const OPENCLAW_PKG = path.join(RUNTIME, 'openclaw');
const GATEWAY_JS = path.join(OPENCLAW_PKG, 'dist', 'index.js');
const OPENCLAW_CLI = path.join(OPENCLAW_PKG, 'openclaw.mjs');
const CA_BUNDLE = path.join(RUNTIME, 'system-ca-bundle.pem');
const ICON = path.join(__dirname, 'icon.png');
const SHIM = path.join(__dirname, 'hostname-shim.cjs');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(HOME, '.openclaw');
const CONFIG = path.join(DATA_DIR, 'openclaw.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'agents', 'main', 'sessions');
const SETTINGS = path.join(DATA_DIR, 'console-settings.json');
const APP_DATA = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'OpenClawConsole');
const BOOT_LOG = path.join(APP_DATA, 'console-boot.log');

try { if (!fs.existsSync(APP_DATA)) fs.mkdirSync(APP_DATA, { recursive: true }); } catch (e) {}

// 端口策略：显式指定优先（OPENCLAW_CONSOLE_PORT），否则自动探测——
// 18789 被本机其它实例/程序占用时顺延选空闲口，绝不跟用户现有服务打架。
let PORT = 18789;
const PORT_CANDIDATES = [18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798, 18799];

function portIsFree(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(600);
    s.once('connect', () => { s.destroy(); res(false); });
    s.once('error', () => res(true));
    s.once('timeout', () => { s.destroy(); res(true); });
  });
}

async function resolvePort() {
  const forced = parseInt(process.env.OPENCLAW_CONSOLE_PORT || '', 10);
  if (Number.isInteger(forced) && forced > 0 && forced < 65536) { PORT = forced; return 'forced=' + PORT; }
  for (const p of PORT_CANDIDATES) {
    if (await portIsFree(p)) { PORT = p; return 'auto-free=' + PORT; }
  }
  PORT = 18789;
  return 'fallback=' + PORT;
}
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'OpenClaw 控制台';

// ---------- 日志 ----------
function bootLog(msg) {
  try {
    const t = new Date().toLocaleString('zh-CN', { hour12: false });
    try {
      const st = fs.statSync(BOOT_LOG);
      if (st.size > 262144) {
        const lines = fs.readFileSync(BOOT_LOG, 'utf8').split(/\r?\n/).slice(-200).join('\n');
        fs.writeFileSync(BOOT_LOG, lines + '\n', 'utf8');
      }
    } catch (e) {}
    fs.appendFileSync(BOOT_LOG, '[' + t + '] ' + msg + '\n', 'utf8');
  } catch (e) {}
}

// 开机自启判定：Run 键启动时带 --autostart 参数
const autoStart = process.argv.includes('--autostart');
bootLog('--- app launch v2 --- autoStart=' + autoStart + ' root=' + ROOT);

// ---------- 首次启动：部署内置微信插件 ----------
// 关键：openclaw 2026.6.35 的插件注册走 SQLite 状态库 + .openclaw/extensions 目录，
// 单纯把目录拷到别处 **不会被识别**（表现为 channels login 弹 "Install Weixin plugin?"
// 交互提示 → 无人按键 → 卡死到超时）。所以这里走官方 CLI 安装，并补齐离线依赖。
const PLUGIN_SRC = path.join(__dirname, 'plugins', 'tencent-weixin-openclaw-weixin-7783ac86ba');
const PLUGIN_PKG = path.join(PLUGIN_SRC, 'node_modules', '@tencent-weixin', 'openclaw-weixin');

function pluginInstalled() {
  // 官方安装后的目录：%USERPROFILE%\.openclaw\extensions\openclaw-weixin
  const ext = path.join(DATA_DIR, 'extensions', 'openclaw-weixin');
  return fs.existsSync(path.join(ext, 'package.json'));
}

function copyDirIfMissing(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    if (fs.existsSync(dst)) return true;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
    return fs.existsSync(dst);
  } catch (e) { bootLog('copy dep failed: ' + e.message); return false; }
}

// 把插件的运行时依赖（zod / qrcode-terminal）拷进已安装目录 —— 离线环境下 npm install 跑不动
function ensurePluginDeps(extDir) {
  const srcNm = path.join(PLUGIN_SRC, 'node_modules');
  const dstNm = path.join(extDir, 'node_modules');
  for (const dep of ['zod', 'qrcode-terminal']) {
    const dst = path.join(dstNm, dep);
    if (fs.existsSync(path.join(dst, 'package.json'))) continue;
    if (copyDirIfMissing(path.join(srcNm, dep), dst)) bootLog('plugin dep copied: ' + dep);
  }
}

// 插件安装是异步后台进行的（CLI 安装最坏要几分钟，绝不能卡住界面启动）；
// get-qrcode 之前必须 await 它，否则 CLI 又会弹交互式安装提示。
let pluginInstallPromise = null;

function installPluginAsync() {
  if (pluginInstallPromise) return pluginInstallPromise;
  pluginInstallPromise = new Promise((resolve) => {
    try {
      if (!fs.existsSync(PLUGIN_PKG)) { bootLog('weixin plugin source missing'); resolve(false); return; }
      if (pluginInstalled()) {
        ensurePluginDeps(path.join(DATA_DIR, 'extensions', 'openclaw-weixin'));
        resolve(true); return;
      }
      bootLog('installing weixin plugin via official CLI (background)…');
      const child = spawn(NODE, [...shimArgs(), OPENCLAW_CLI, 'plugins', 'install', PLUGIN_PKG], {
        cwd: DATA_DIR, windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 300000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const extDir = path.join(DATA_DIR, 'extensions', 'openclaw-weixin');
        ensurePluginDeps(extDir);
        const ok = pluginInstalled();
        bootLog('plugin install exit=' + code + ' ok=' + ok + ' :: ' + out.replace(/\s+/g, ' ').slice(-500));
        resolve(ok);
      });
      child.on('error', (err) => { clearTimeout(timer); bootLog('plugin install spawn error: ' + err.message); resolve(false); });
    } catch (e) { bootLog('deployPlugins error: ' + e.message); resolve(false); }
  });
  return pluginInstallPromise;
}

// ---------- 首次启动：生成用户配置 ----------
function ensureConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG)) return;
    const presetPath = path.join(__dirname, 'preset-config.json');
    let raw;
    if (fs.existsSync(presetPath)) {
      raw = fs.readFileSync(presetPath, 'utf8');
    } else {
      raw = JSON.stringify({
        gateway: { mode: 'local', auth: { mode: 'token', token: crypto.randomBytes(24).toString('hex') } },
        plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
        channels: {},
        models: { mode: 'merge', providers: {} },
        agents: { defaults: { model: { primary: '', fallbacks: [] }, models: {} } },
      }, null, 2);
    }
    const cfg = JSON.parse(raw);
    if (cfg.gateway && cfg.gateway.auth) cfg.gateway.auth.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    bootLog('config created at ' + CONFIG);
  } catch (e) { bootLog('ensureConfig error: ' + e.message); }
}
ensureConfig();

function mergePresetModels() {
  try {
    const presetPath = path.join(__dirname, 'preset-config.json');
    if (!fs.existsSync(presetPath) || !fs.existsSync(CONFIG)) return;
    const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    const cfg = readCfg();
    let changed = false;

    if (!cfg.models) cfg.models = { mode: 'merge', providers: {} };
    if (!cfg.models.providers) cfg.models.providers = {};
    // 出厂默认的过期/无效 Key（历史版本遗留）→ 自动更新为预置里的新 Key。
    // ark 旧 Key 前缀 <REDACTED_ARK_PREFIX>（AccessDenied）；deepseek 旧 Key 前缀 <REDACTED_SK_PREFIX>（invalid）。
    const STALE_PREFIXES = ['<REDACTED_ARK_PREFIX>', '<REDACTED_SK_PREFIX>'];
    const isStale = (k) => !k || STALE_PREFIXES.some((p) => k.startsWith(p));
    for (const [pk, pv] of Object.entries(preset.models && preset.models.providers || {})) {
      if (!cfg.models.providers[pk]) {
        cfg.models.providers[pk] = pv;
        changed = true;
        bootLog('preset provider added: ' + pk);
      } else {
        const cur = cfg.models.providers[pk];
        if (pv.apiKey && isStale(cur.apiKey)) {
          cur.apiKey = pv.apiKey;
          changed = true;
          bootLog('preset provider key refreshed: ' + pk);
        }
        // 老配置补齐 compat.supportsUsageInStreaming（否则 token 用量永远是 0）
        if (!cur.models) cur.models = [];
        for (const pm of (pv.models || [])) {
          let cm = cur.models.find((m) => m.id === pm.id);
          if (!cm) { cur.models.push(pm); changed = true; bootLog('preset model added: ' + pk + '/' + pm.id); continue; }
          const want = pm.compat || {};
          if (!cm.compat) cm.compat = {};
          for (const [ck, cv] of Object.entries(want)) {
            if (cm.compat[ck] !== cv) { cm.compat[ck] = cv; changed = true; }
          }
        }
      }
    }

    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = { primary: '', fallbacks: [] };
    if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};

    const presetModel = (preset.agents && preset.agents.defaults && preset.agents.defaults.model) || {};
    const presetOrder = [presetModel.primary].concat(presetModel.fallbacks || []).filter(Boolean);
    // 版本号存在控制台设置里（openclaw.json 的 meta 是严格 schema，不能塞自定义字段）
    const PRESET_REV = 2;
    const settings = readSettings();
    const cfgRev = settings.presetRevision || 0;

    // 出厂顺序升级：配置版本低于本次预置版本时，按预置顺序重排
    // （用户自定义新增的模型保留在末尾，不会被删）
    if (PRESET_REV > cfgRev && presetOrder.length) {
      const m = cfg.agents.defaults.model;
      const cur = [m.primary].concat(m.fallbacks || []).filter(Boolean);
      const extras = cur.filter((k) => !presetOrder.includes(k));
      m.primary = presetOrder[0];
      m.fallbacks = presetOrder.slice(1).concat(extras);
      settings.presetRevision = PRESET_REV;
      writeSettings(settings);
      changed = true;
      bootLog('preset order applied (rev ' + cfgRev + ' -> ' + PRESET_REV + '): ' + presetOrder.join(' > '));
    } else if (presetModel.primary) {
      // 旧逻辑兜底：主模型不在链里时提升。
      // 注意：只在"用户从没手动调过顺序"时才纠正，避免把用户的自定义顺序改回去。
      if (!settings.userOrderedChain && presetOrder.length) {
        const m = cfg.agents.defaults.model;
        const chain = [m.primary].concat(m.fallbacks || []).filter(Boolean);
        if (!chain.includes(presetModel.primary)) {
          m.primary = presetModel.primary;
          m.fallbacks = chain;
          changed = true;
          bootLog('preset primary promoted: ' + presetModel.primary);
        }
      }
    }

    for (const k of Object.keys(preset.agents && preset.agents.defaults && preset.agents.defaults.models || {})) {
      if (!cfg.agents.defaults.models[k]) { cfg.agents.defaults.models[k] = {}; changed = true; }
    }

    if (changed) { writeCfg(cfg); bootLog('config merged with preset'); }
  } catch (e) { bootLog('mergePreset error: ' + e.message); }
}
mergePresetModels();
installPluginAsync(); // 后台安装微信插件（不阻塞界面；get-qrcode 前会等待）

// 确保工作区有"用简体中文回复"的约束（老用户的工作区模板不会自动更新，这里做一次性补齐）
function ensureWorkspaceLanguage() {
  try {
    const ws = path.join(DATA_DIR, 'workspace');
    if (!fs.existsSync(ws)) return; // 尚未初始化，首次启动时 openclaw 会用新模板播种
    const target = path.join(ws, 'USER.md');
    const marker = '始终使用**简体中文**回复';
    let txt = '';
    try { txt = fs.readFileSync(target, 'utf8'); } catch (e) { txt = ''; }
    if (txt.includes(marker)) return;
    const block = '\n## 回复语言 / Reply Language\n\n- ' + marker + '用户，除非用户明确要求使用其他语言。\n- Always reply in **Simplified Chinese** unless the user explicitly asks for another language.\n';
    fs.appendFileSync(target, block, 'utf8');
    bootLog('workspace language directive added');
  } catch (e) { bootLog('ensureWorkspaceLanguage error: ' + e.message); }
}
ensureWorkspaceLanguage();

// ---------- 渲染优化 ----------
app.disableHardwareAcceleration();
// userData 显式固定到自己的 APP_DATA（隔离单实例锁与 Chromium 数据，避免与其它控制台实例互踢）
try { app.setPath('userData', APP_DATA); } catch (e) {}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  bootLog('second instance detected, exiting immediately');
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => { bootLog('second-instance triggered, showing window'); showWindow(); });
process.on('uncaughtException', (err) => bootLog('uncaughtException: ' + (err.stack || err.message)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => { if (win) { try { win.webContents.send('log', msg); } catch (e) {} } };

// ---------- 子进程环境 ----------
function cleanEnv(extra) {
  const env = Object.assign({}, process.env, {
    HOME, USERPROFILE: HOME,
    TMPDIR: os.tmpdir(),
    OPENCLAW_GATEWAY_PORT: String(PORT),
    OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service',
    OPENCLAW_WINDOWS_TASK_NAME: 'OpenClaw Gateway',
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: '1',
    OPENCLAW_SERVICE_MARKER: 'openclaw',
    OPENCLAW_SERVICE_KIND: 'gateway',
    OPENCLAW_SERVICE_VERSION: '2026.6.35',
  }, extra || {});
  // 三个污染变量必须剔除（会让 Electron 退化为纯 Node / 预载不相关模块）
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  // NODE_OPTIONS 覆盖为我们的值：openclaw 内部 spawn 的 node 子进程（npm 调用 /
  // 微信 sidecar / 更新检查）全部继承 --title。不塞 --require（路径经 NODE_OPTIONS
  // 切分极易引号损坏，Win10+ 上 hostname 兜底根本用不到）。
  env.NODE_OPTIONS = '--title=OpenClaw';
  env.NODE_SKIP_PLATFORM_CHECK = '1';
  if (fs.existsSync(CA_BUNDLE)) env.NODE_EXTRA_CA_CERTS = CA_BUNDLE;
  return env;
}

// 控制权内 spawn 的进程：CLI 参数直接给（双保险）
function shimArgs() {
  const args = ['--title=OpenClaw'];
  if (fs.existsSync(SHIM)) args.push('--require', SHIM);
  return args;
}

// ---------- 启动自检 ----------
function selfTest() {
  const code = 'try{process.stdout.write(JSON.stringify({v:process.version,t:process.title,h:require("os").hostname()}))}catch(e){process.stdout.write(JSON.stringify({err:e.message}))}';
  try {
    const r = spawnSync(NODE, [...shimArgs(), '-e', code], {
      windowsHide: true, timeout: 15000, encoding: 'utf8', env: cleanEnv(),
    });
    if (r.error) return { ok: false, msg: '无法执行 node.exe：' + r.error.message };
    if (r.status !== 0) {
      const c = r.status;
      const hex = c < 0 ? (c >>> 0).toString(16).toUpperCase() : null;
      let hint = '';
      if (hex === 'C0000135') hint = '缺少系统 DLL（可安装 VC++ 2015-2022 x64 运行库）';
      else if (hex === 'C0000139') hint = 'DLL 入口点缺失（系统运行库过旧）';
      else if (hex === 'C000007B') hint = '32/64 位不匹配';
      else if (hex === 'C0000005') hint = '访问冲突（系统 API 不兼容）';
      return { ok: false, msg: 'node.exe 自检失败（退出码 ' + c + (hex ? ' / 0x' + hex : '') + '）' + (hint ? '：' + hint : '') };
    }
    let info = {};
    try { info = JSON.parse((r.stdout || '').trim() || '{}'); } catch (e) {}
    if (info.err) return { ok: false, msg: '自检脚本异常：' + info.err };
    return { ok: true, version: info.v || '?', title: info.t || '?', hostname: info.h || '?' };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// ---------- 网关状态 ----------
function portOpen() {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.once('timeout', () => { s.destroy(); res(false); });
  });
}

function listenPids() {
  return new Promise((res) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) => {
      const pids = [];
      if (!err && stdout) {
        for (const line of stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (!/LISTENING/i.test(t)) continue;
          const cols = t.split(/\s+/);
          const local = cols[1] || '';
          if (!local.endsWith(':' + PORT)) continue;
          const pid = parseInt(cols[cols.length - 1], 10);
          if (pid > 0 && !pids.includes(pid)) pids.push(pid);
        }
      }
      res(pids);
    });
  });
}

// 安全核心：查 PID 的可执行文件路径，确保「只杀自己的进程」
// （端口上可能跑着用户机器上别的程序/其它 OpenClaw 实例，绝不误杀）
function pidExePath(pid) {
  return new Promise((res) => {
    execFile('wmic', ['process', 'where', 'processid=' + pid, 'get', 'executablepath', '/value'], { windowsHide: true }, (err, stdout) => {
      if (!err && stdout) {
        const m = stdout.match(/ExecutablePath=(.+)/i);
        if (m && m[1].trim()) return res(m[1].trim());
      }
      // wmic 不可用时回退 PowerShell
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue).Path'], { windowsHide: true }, (err2, out2) => {
        res(!err2 && out2 ? String(out2).trim() : '');
      });
    });
  });
}

function isOurNodePath(exePath) {
  if (!exePath) return false;
  try { return path.dirname(exePath).toLowerCase() === RUNTIME.toLowerCase(); } catch (e) { return false; }
}

// 本控制台自己 spawn 出的网关 PID（按 PID 精确操作，符合安全规则）
const spawnedPids = new Set();
// 是否由本进程拉起的网关（拉起后端口就一定是我们的，避免路径探测失败被误判为"他人占用"）
let gatewayOwned = false;

// ---------- 配置读写 ----------
function readCfg() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
function writeCfg(cfg) { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); }

const PROVIDER_LABELS = {
  ark: '火山方舟', 'ark-doubao': '火山方舟 · 豆包', deepseek: 'DeepSeek 官方', openai: 'OpenAI',
  zhipu: '智谱 GLM', qwen: '通义千问', moonshot: 'Moonshot Kimi',
  siliconflow: 'SiliconFlow', custom: '自定义', anthropic: 'Anthropic Claude',
};

// 自定义显示名（存在控制台设置里，不写 openclaw.json —— provider schema 严格，多余字段会导致网关拒绝启动）
function providerLabelsMap() {
  const s = readSettings();
  return (s && s.providerLabels) || {};
}
function saveProviderLabel(key, label) {
  const s = readSettings();
  if (!s.providerLabels) s.providerLabels = {};
  s.providerLabels[key] = label;
  writeSettings(s);
}
function providerLabel(key, cfg) {
  const custom = providerLabelsMap()[key];
  if (custom) return custom;
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  const p = cfg.models && cfg.models.providers && cfg.models.providers[key];
  return (p && p.label) || key;
}

function getModelInfo() {
  const cfg = readCfg();
  const providers = (cfg.models && cfg.models.providers) || {};
  const model = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model) || {};
  const chain = [model.primary || ''].concat(model.fallbacks || []).filter(Boolean);
  const allModels = [];
  for (const [pkey, p] of Object.entries(providers)) {
    const pLabel = providerLabel(pkey, cfg);
    for (const m of (p.models || [])) {
      allModels.push({ key: pkey + '/' + m.id, provider: pkey, providerLabel: pLabel, modelId: m.id, modelName: m.name || m.id });
    }
  }
  return { chain, allModels };
}

function setPriority(order) {
  const cfg = readCfg();
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  const oldModels = (cfg.agents.defaults.models) || {};
  const nextModels = {};
  for (const k of order) nextModels[k] = oldModels[k] || {};
  cfg.agents.defaults.model = { primary: order[0] || '', fallbacks: order.slice(1) };
  cfg.agents.defaults.models = nextModels;
  writeCfg(cfg);
  // 标记用户已手动调过顺序 → 后续出厂顺序升级不再覆盖用户的自定义顺序
  const s = readSettings();
  s.userOrderedChain = order.slice();
  writeSettings(s);
  return true;
}

function addProvider(opts) {
  const cfg = readCfg();
  if (!cfg.models) cfg.models = { mode: 'merge', providers: {} };
  if (!cfg.models.providers) cfg.models.providers = {};
  // baseUrl 规范化：去掉末尾斜杠；http(s):// 开头必须有协议，否则网关请求必然失败
  let baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('URL 必须以 http:// 或 https:// 开头');
  if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) throw new Error('URL 格式不正确');
  if (!opts.apiKey) throw new Error('请填写 API Key');
  if (!opts.modelId) throw new Error('请填写模型 ID');
  if (!cfg.models.providers[opts.providerKey]) {
    cfg.models.providers[opts.providerKey] = { baseUrl, apiKey: opts.apiKey, api: opts.api || 'openai-completions', models: [] };
  } else {
    const p = cfg.models.providers[opts.providerKey];
    p.baseUrl = baseUrl; if (opts.apiKey) p.apiKey = opts.apiKey; p.api = opts.api || p.api;
  }
  const p = cfg.models.providers[opts.providerKey];
  // 显示名不能写进 openclaw.json（provider 是严格 schema，多余字段会让网关拒绝启动）→
  // 存到控制台自己的设置文件里，仅用于界面展示。
  if (opts.label && opts.label !== opts.providerKey) saveProviderLabel(opts.providerKey, opts.label);
  if (!p.models) p.models = [];
  if (!p.models.find((m) => m.id === opts.modelId)) {
    // 自定义 provider（endpointClass=custom）的自动探测会把 supportsUsageInStreaming 判为 false
    // → 流式请求不带 include_usage → token 用量永远 0。显式声明为 true 修正。
    p.models.push({
      id: opts.modelId, name: opts.modelName || opts.modelId, reasoning: false, input: ['text'],
      contextWindow: 131072, maxTokens: 8192,
      compat: { supportsUsageInStreaming: true },
    });
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
  return true;
}

function removeModel(key, delProvider) {
  const cfg = readCfg();
  const model = cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model;
  if (model && model.primary === key) {
    let next = '';
    const providers = (cfg.models && cfg.models.providers) || {};
    outer: for (const [pk, p] of Object.entries(providers)) {
      for (const m of (p.models || [])) {
        const fullKey = pk + '/' + m.id;
        if (fullKey !== key) { next = fullKey; break outer; }
      }
    }
    model.primary = next;
    model.fallbacks = (model.fallbacks || []).filter((k) => k !== key);
  } else if (model && Array.isArray(model.fallbacks)) {
    model.fallbacks = model.fallbacks.filter((k) => k !== key);
  }
  if (cfg.agents.defaults && cfg.agents.defaults.models) delete cfg.agents.defaults.models[key];
  if (delProvider) {
    const [pkey] = key.split('/');
    if (cfg.models && cfg.models.providers && cfg.models.providers[pkey]) {
      const p = cfg.models.providers[pkey];
      if (p.models) p.models = p.models.filter((m) => pkey + '/' + m.id !== key);
      if (!p.models || p.models.length === 0) delete cfg.models.providers[pkey];
    }
  }
  writeCfg(cfg);
  return true;
}

async function status() {
  const running = await portOpen();
  const pids = running ? await listenPids() : [];
  // 区分「我们的网关在跑」与「端口被其它程序占用」
  // 判定原则：只有拿到确凿证据（每个 PID 的可执行路径都能查到、且都不属于本安装）才认为被他人占用。
  // 路径查询偶尔会超时/失败返回空，此时不能据此判定"他人占用"，否则界面会误报。
  let foreign = false;
  if (running && pids.length) {
    const checks = await Promise.all(pids.map(pidExePath));
    const ours = gatewayOwned || pids.some((pid, i) => spawnedPids.has(pid) || isOurNodePath(checks[i]));
    const allKnown = checks.every((p) => !!p);
    foreign = !ours && allKnown;
  }
  const { chain, allModels } = getModelInfo();
  return { running, pids, chain, allModels, port: PORT, foreign };
}

// ---------- IPC ----------
ipcMain.handle('status', () => status());
ipcMain.handle('get-models', () => getModelInfo());
ipcMain.handle('set-priority', async (e, order) => {
  setPriority(order);
  // 网关只在启动时读配置：正在运行时必须重启，否则界面顺序变了、实际仍用旧模型（"假调整"）
  if (await portOpen()) {
    log('[..] 顺序已保存，正在重启网关让新顺序生效…');
    await stopGateway();
    const r = await startGateway();
    if (r && r.ok) log('[OK] 网关已按新顺序重启');
    else log('[!] 网关重启失败，请手动点「启动网关」');
  } else {
    log('[OK] 顺序已保存（网关下次启动时生效）');
  }
  return { ok: true };
});
ipcMain.handle('add-provider', async (e, opts) => {
  try { addProvider(opts); }
  catch (err) { return { ok: false, msg: err.message || String(err) }; }
  // 网关只在启动时读配置：正在运行时自动重启，让新模型立即可用
  // （否则用户看到"加了没反应" —— 新模型在配置里但网关还用旧列表）
  if (await portOpen()) {
    log('[..] 新模型已加入，正在重启网关使其生效…');
    await stopGateway();
    const r = await startGateway();
    if (r && r.ok) log('[OK] 网关已重启，新模型已生效');
    else log('[!] 网关重启失败，请手动点「启动网关」');
  } else {
    log('[OK] 已添加（下次启动网关时生效）');
  }
  return { ok: true };
});
ipcMain.handle('remove-model', (e, key, delProvider) => { removeModel(key, delProvider); return { ok: true }; });

ipcMain.handle('start', async () => startGateway());

async function stopGateway() {
  const pids = await listenPids();
  if (pids.length === 0) { log('[i] 网关当前未在运行'); return { ok: true, msg: '网关当前未在运行' }; }
  // 只终止属于本程序的进程：自 spawn 的 PID，或可执行文件在本安装 runtime 目录下的
  const killSet = [];
  const foreign = [];
  for (const pid of pids) {
    if (spawnedPids.has(pid)) { killSet.push(pid); continue; }
    const exe = await pidExePath(pid);
    // 本进程亲手拉起的网关：即使路径查询失败也认定是自己的（否则会关不掉自己的网关）
    if (isOurNodePath(exe) || (gatewayOwned && !exe)) killSet.push(pid); else foreign.push(pid);
  }
  if (foreign.length) log('[!] 端口被其它程序占用（PID ' + foreign.join(', ') + '），不会终止它');
  if (killSet.length === 0) {
    return { ok: true, msg: '未终止任何进程（端口上的程序不属于本控制台）' };
  }
  log('[..] 终止本程序网关 PID ' + killSet.join(', '));
  gatewayOwned = false;
  for (const pid of killSet) {
    spawnedPids.delete(pid);
    try { execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }); } catch (e) {}
  }
  for (let i = 0; i < 25; i++) { await sleep(400); if (!(await portOpen())) break; }
  log(!(await portOpen()) ? '[OK] 网关已关闭，微信机器人已下线' : '[!] 端口仍被占用');
  const s = readSettings();
  if (s.autoPowerSave !== false) applyPowerSave(false);
  return { ok: true, msg: '关闭完成' };
}
ipcMain.handle('stop', async () => stopGateway());

ipcMain.handle('minimize', () => { if (win) win.hide(); return { ok: true }; });

// ---------- 微信绑定二维码 ----------
let loginChild = null;
ipcMain.handle('get-qrcode', async () => {
  // 等插件装完（首次安装可能要几分钟），否则 CLI 会弹交互式提示卡死
  const pluginOk = await Promise.race([installPluginAsync(), sleep(320000).then(() => false)]);
  if (!pluginOk) {
    return { ok: false, msg: '微信插件未就绪（安装失败或超时）。请重启控制台后重试；若反复出现，请把日志发给我。' };
  }
  // 二维码图片在主进程本地生成（离线可用），不依赖任何在线二维码服务
  const r = await new Promise((resolve) => {
    if (loginChild) { try { loginChild.kill(); } catch (e) {} loginChild = null; }
    let resolved = false;
    let buf = '';
    try {
      loginChild = spawn(NODE, [...shimArgs(), OPENCLAW_CLI, 'channels', 'login', '--channel', 'openclaw-weixin'], {
        cwd: DATA_DIR, windowsHide: true, shell: false, env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { resolve({ ok: false, msg: '启动 login 失败: ' + e.message }); return; }

    bootLog('channels login started, pid=' + loginChild.pid);
    // 首次获取较慢（插件冷启动 + 微信接口往返，实测 15~40 秒），给足 120 秒
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        bootLog('qrcode timeout, bufLen=' + buf.length);
        resolve({ ok: false, msg: '获取超时（120 秒）。请确认网络能访问微信，且网关已启动后重试' });
      }
    }, 120000);

    // CLI 在插件未被识别时会弹交互式安装提示（"Install Weixin plugin?"），
    // 不按键就永远卡住 → 这里自动选「Skip for now」，让它尽快走到二维码或给出明确错误。
    let promptHandled = false;
    function feed(text) {
      buf += text;
      if (!promptHandled && /Install Weixin plugin\?/i.test(buf)) {
        promptHandled = true;
        bootLog('login: plugin install prompt detected, choosing skip');
        try { loginChild.stdin.write('\x1b[B'); loginChild.stdin.write('\r'); } catch (e) {}
      }
      const m = buf.match(/https:\/\/liteapp\.weixin\.qq\.com\/[^\s"'\x1b]+/);
      if (m && !resolved) {
        resolved = true; clearTimeout(timer);
        bootLog('qrcode url OK');
        resolve({ ok: true, url: m[0] });
      }
    }

    loginChild.stdout.on('data', (d) => feed(d.toString()));
    loginChild.stderr.on('data', (d) => {
      const s = d.toString();
      feed(s); // 某些版本把链接打到 stderr
      if (/error|fail/i.test(s)) bootLog('login stderr: ' + s.slice(0, 200));
    });
    loginChild.on('error', (err) => {
      bootLog('login spawn error: ' + err.message);
      if (!resolved) { resolved = true; clearTimeout(timer); resolve({ ok: false, msg: 'login 进程启动失败: ' + err.message }); }
    });
    loginChild.on('exit', (code) => {
      bootLog('channels login exit code=' + code + ' resolved=' + resolved);
      loginChild = null;
      if (!resolved) { resolved = true; clearTimeout(timer); resolve({ ok: false, msg: 'login 进程已退出（code=' + code + '）' }); }
    });
  });
  if (r && r.ok) r.img = await qrDataUrl(r.url);
  return r;
});

// 二维码图片本地生成：早期版本用第三方在线服务（api.qrserver.com），
// 国内基本打不通 → 表现为"一直加载一直加载然后超时"。这里用随包携带的 qrcode 库离线生成。
// 注意 toDataURL 是异步的，必须 await（Promise 直接塞进 IPC 会因无法结构化克隆而报错）。
async function qrDataUrl(url) {
  try {
    const qrcode = require(path.join(OPENCLAW_PKG, 'node_modules', 'qrcode'));
    return await qrcode.toDataURL(url, { width: 240, margin: 8, errorCorrectionLevel: 'M' });
  } catch (e) {
    bootLog('qr local render failed: ' + e.message);
    return '';
  }
}

ipcMain.handle('cancel-qrcode', () => {
  if (loginChild) { try { loginChild.kill(); } catch (e) {} loginChild = null; bootLog('qrcode cancelled'); }
  return { ok: true };
});

// ---------- 开机自启（HKCU Run 键：任务管理器 → 启动 可见） ----------
let powerSaveId = null;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { return { autoStart: false, autoPowerSave: true }; }
}
function writeSettings(s) {
  try { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n', 'utf8'); } catch (e) {}
}

function applyPowerSave(enabled) {
  if (enabled && powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    log('[OK] 已防止系统休眠（机器人持续在线）');
  } else if (!enabled && powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
    log('[i] 已恢复系统休眠');
  }
}

function runKeyQuery() {
  return new Promise((res) => {
    execFile('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true }, (err, stdout) => {
      res(!err && /--autostart/.test(stdout || ''));
    });
  });
}
function runKeySet(enabled) {
  return new Promise((res) => {
    if (enabled) {
      const cmd = '"' + path.join(ROOT, 'OpenClawConsole.exe') + '" --autostart';
      execFile('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true }, (err) => res(!err));
    } else {
      execFile('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true }, () => res(true));
    }
  });
}

ipcMain.handle('get-settings', async () => {
  const s = readSettings();
  const autoStartState = await runKeyQuery();
  return { autoStart: autoStartState, autoPowerSave: s.autoPowerSave !== false };
});

ipcMain.handle('set-autostart', async (e, enabled) => {
  const ok = await runKeySet(!!enabled);
  const s = readSettings(); s.autoStart = !!enabled; writeSettings(s);
  if (ok) log(enabled ? '[OK] 已开启开机自启（任务管理器 → 启动 项可见「OpenClaw 控制台」）' : '[i] 已关闭开机自启');
  else log('[!] 写入启动项失败，请以管理员身份运行后重试');
  return { ok };
});

ipcMain.handle('set-powersave', (e, enabled) => {
  const s = readSettings(); s.autoPowerSave = !!enabled; writeSettings(s);
  applyPowerSave(!!enabled);
  log(enabled ? '[OK] 已开启防休眠' : '[i] 已关闭防休眠');
  return { ok: true };
});

// ---------- token 用量 ----------
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let usageCache = { ts: 0, data: null, dayKey: '' };
ipcMain.handle('get-usage', () => {
  const todayStr = localDateStr(new Date());
  const now = Date.now();
  if (usageCache.data && usageCache.dayKey === todayStr && now - usageCache.ts < 60000) return usageCache.data;
  const result = {};
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.trajectory.jsonl'));
      for (const f of files) {
        const lines = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8').split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch (e) { continue; }
          // 只统计 model.completed（每次模型调用一条）：
          // trace.artifacts 携带同一份 usage，全量累加会让数字虚高 2 倍。
          if (entry.type !== 'model.completed') continue;
          const u = entry && entry.data && entry.data.usage;
          if (!u || !entry.ts) continue;
          if (localDateStr(new Date(entry.ts)) !== todayStr) continue;
          const model = entry.modelId || 'unknown';
          const provider = entry.provider || '';
          if (!result[model]) result[model] = { model, provider, input: 0, output: 0, total: 0, count: 0 };
          result[model].input += (u.input || 0);
          result[model].output += (u.output || 0);
          result[model].total += (u.total || u.totalTokens || ((u.input || 0) + (u.output || 0)));
          result[model].count += 1;
        }
      }
    }
  } catch (e) {}
  const arr = Object.values(result).sort((a, b) => b.total - a.total);
  const grandTotal = arr.reduce((s, m) => s + m.total, 0);
  const data = { models: arr, grandTotal };
  usageCache = { ts: now, data, dayKey: todayStr };
  return data;
});

// ---------- 窗口 + 托盘 ----------
let win = null;
let tray = null;
let isQuitting = false;

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示控制台', click: () => { showWindow(); } },
    { type: 'separator' },
    { label: '启动网关', click: () => { startGateway(); } },
    { label: '关闭网关', click: () => { stopGateway(); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; if (tray) tray.destroy(); app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  const iconImg = nativeImage.createFromPath(ICON);
  tray = new Tray(iconImg);
  tray.setToolTip('OpenClaw 控制台');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => { if (win && win.isVisible()) win.hide(); else showWindow(); });
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    try { win.webContents.invalidate(); } catch (e) {}
    return;
  }
  const iconImg = nativeImage.createFromPath(ICON);
  win = new BrowserWindow({
    width: 480, height: 720, minWidth: 420, minHeight: 560,
    frame: false, resizable: true, backgroundColor: '#1e1e2e', icon: iconImg,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    bootLog('window ready-to-show, showing');
    if (win) { win.show(); win.focus(); try { win.webContents.invalidate(); } catch (e) {} }
  });
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function startup() {
  bootLog('startup: autoStart=' + autoStart);
  createTray();
  if (!autoStart) { showWindow(); }
}

// ---------- 网关启动 ----------
let GW_LOG = '';
async function startGateway() {
  // 先等微信插件装完再启动网关：插件 CLI 装完后会主动重启"正在运行"的网关
  // （afterWrite mode=restart），与我们的启动赛跑会导致网关被杀/被判为外来占用。
  if (!pluginInstalled()) {
    log('[..] 首次启动：正在准备微信插件（约半分钟，只需一次）…');
    const ok = await Promise.race([installPluginAsync(), sleep(320000).then(() => false)]);
    if (!ok) log('[!] 微信插件未能就绪，网关先按无插件模式启动（微信功能暂不可用）');
  }
  if (await portOpen()) {
    const pids = await listenPids();
    if (pids.length === 0) { log('[i] 网关已在运行'); return { ok: true }; }
    const checks = await Promise.all(pids.map(pidExePath));
    const ours = gatewayOwned || pids.some((pid, i) => isOurNodePath(checks[i]) || spawnedPids.has(pid));
    const allKnown = checks.every((p) => !!p);
    if (ours) { log('[i] 网关已在运行'); return { ok: true }; }
    // 路径查不到时不要武断认定"他人占用"（查询偶发超时会误判），提示重试即可
    if (!allKnown) {
      log('[!] 检测到端口 ' + PORT + ' 有程序在监听，但无法确认归属，请稍后重试');
      return { ok: false, error: 'port owner unknown' };
    }
    log('[x] 端口 ' + PORT + ' 被其它程序占用，为避免冲突未启动（也未影响对方）');
    return { ok: false, error: 'port occupied by another program' };
  }
  if (!fs.existsSync(NODE)) { log('[x] 缺少 runtime\\node.exe'); return { ok: false }; }
  if (!fs.existsSync(GATEWAY_JS)) { log('[x] 缺少 runtime\\openclaw'); return { ok: false }; }

  // 启动前自检（版本 / 标题 / 主机名，Win7 兼容状态一目了然）
  const st = selfTest();
  bootLog('self test: ' + JSON.stringify(st));
  if (!st.ok) {
    log('[x] Node 运行时自检未通过，网关不能加载');
    String(st.msg).split('\n').forEach((line) => log('[x] ' + line));
    return { ok: false, error: st.msg };
  }
  log('[i] 运行时自检通过（' + st.version + ' / 标题:' + st.title + ' / 主机:' + st.hostname + '）');

  // 网关输出写日志（优先安装目录，不可写回退 %APPDATA%）
  let gwLog = null;
  GW_LOG = path.join(ROOT, 'gateway.log');
  try { gwLog = fs.openSync(GW_LOG, 'w'); } catch (e) { GW_LOG = path.join(APP_DATA, 'gateway.log'); try { gwLog = fs.openSync(GW_LOG, 'w'); } catch (e2) {} }
  try {
    const child = spawn(NODE, [...shimArgs(), GATEWAY_JS, 'gateway', '--port', String(PORT)], {
      cwd: DATA_DIR, detached: true, windowsHide: true, shell: false, env: cleanEnv(),
      stdio: ['ignore', gwLog !== null ? gwLog : 'ignore', gwLog !== null ? gwLog : 'ignore'],
    });
    child.unref();
    if (child.pid) spawnedPids.add(child.pid);
    gatewayOwned = true;
    child.on('exit', (code) => {
      if (child.pid) spawnedPids.delete(child.pid);
      gatewayOwned = false;
      bootLog('gateway exited early, code=' + code);
      if (gwLog !== null) { try { fs.closeSync(gwLog); } catch (e) {} gwLog = null; }
      if (code !== 0 && code !== null) {
        log('[x] 网关进程异常退出（code=' + code + '）');
        log('[x] 详情见: ' + GW_LOG);
      }
    });
  } catch (err) { log('[x] 启动失败: ' + err.message); return { ok: false, error: err.message }; }

  log('[..] 网关启动中…');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await portOpen()) {
      const s = readSettings();
      if (s.autoPowerSave !== false) applyPowerSave(true);
      log('[OK] 网关已就绪，微信机器人可以对话了');
      return { ok: true };
    }
  }
  let tail = '';
  try {
    const p = GW_LOG;
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8').trim();
      tail = txt.slice(-600);
    }
  } catch (e) {}
  log('[x] 超时：网关未就绪');
  if (tail) tail.split(/\r?\n/).slice(-6).forEach((l) => log('[x] ' + l.slice(0, 160)));
  return { ok: false, error: 'gateway timeout' };
}

app.whenReady().then(async () => {
  bootLog('app ready');
  const portHow = await resolvePort();
  bootLog('port resolved: ' + portHow);
  if (process.platform === 'win32') app.setAppUserModelId('OpenClaw Console');
  startup();
  const s = readSettings();
  if (s.autoPowerSave !== false && await portOpen()) applyPowerSave(true);
  if (autoStart) {
    bootLog('auto-start: launching gateway');
    const r = await startGateway();
    bootLog('auto-start gateway result: ' + JSON.stringify(r));
  }
});
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });

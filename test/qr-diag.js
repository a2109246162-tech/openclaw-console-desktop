// 诊断：二维码流程 + 添加 API 全链路
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const APP = 'D:\\build\\oc-v2\\app-root\\OpenClawConsole.exe';
const ROOT = 'D:\\build\\oc-v2\\app-root';
const PROFILE = 'D:\\build\\oc-v2\\diag-profile';
const PORT = 18793;
const DBG = 9500 + Math.floor(Math.random() * 90);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}
let ws = null, id = 0; const pending = new Map();
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('cdp timeout')); } }, 30000);
  });
}
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}
function portUp(p) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: p });
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.once('timeout', () => { s.destroy(); res(false); });
  });
}

(async () => {
  try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', PROFILE], { windowsHide: true }); } catch (e) {}
  fs.mkdirSync(path.join(PROFILE, 'AppData', 'Roaming'), { recursive: true });

  const env = Object.assign({}, process.env, {
    USERPROFILE: PROFILE, HOME: PROFILE,
    APPDATA: path.join(PROFILE, 'AppData', 'Roaming'),
    OPENCLAW_CONSOLE_PORT: String(PORT),
  });
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const app = spawn(APP, ['--remote-debugging-port=' + DBG], { env, cwd: ROOT, stdio: 'ignore' });
  let pageUrl = null;
  for (let i = 0; i < 45 && !pageUrl; i++) {
    await sleep(1000);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + DBG + '/json/list'));
      const p = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (p) pageUrl = p.webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!pageUrl) { console.log('NO CDP'); process.exit(1); }
  await new Promise((res, rej) => {
    ws = new WebSocket(pageUrl);
    ws.onopen = res; ws.onerror = () => rej(new Error('ws err'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
  });
  console.log('[1] CDP connected');
  // 等 DOM 真正就绪（否则 getElementById 可能拿到 null）
  for (let i = 0; i < 60; i++) {
    const ok = await js("document.readyState === 'complete' && !!document.getElementById('btnQrcode')").catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  console.log('  readyState=', await js('document.readyState'), ' title=', await js('document.title'),
              ' btnQrcode=', await js("!!document.getElementById('btnQrcode')"));

  const DATA = path.join(PROFILE, '.openclaw');
  const bootLog = () => fs.existsSync(path.join(PROFILE, 'AppData', 'Roaming', 'OpenClawConsole', 'console-boot.log'))
    ? fs.readFileSync(path.join(PROFILE, 'AppData', 'Roaming', 'OpenClawConsole', 'console-boot.log'), 'utf8') : '';

  console.log('\n===== A. 插件部署检查 =====');
  const pluginDir = path.join(DATA, 'npm', 'projects', 'tencent-weixin-openclaw-weixin-7783ac86ba');
  const marker = path.join(pluginDir, 'node_modules', '@tencent-weixin', 'openclaw-weixin', 'package.json');
  console.log('plugin dir exists:', fs.existsSync(pluginDir));
  console.log('package.json marker:', fs.existsSync(marker));
  const linkPath = path.join(pluginDir, 'node_modules', '@tencent-weixin', 'openclaw-weixin', 'node_modules', 'openclaw');
  console.log('openclaw junction:', fs.existsSync(path.join(linkPath, 'package.json')));
  console.log('--- boot log 相关行 ---');
  bootLog().split(/\r?\n/).filter((l) => /plugin|junction|weixin/i.test(l)).forEach((l) => console.log('  ' + l));

  console.log('\n===== B. 配置文件 plugins 段 =====');
  const cfgPath = path.join(DATA, 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  console.log(JSON.stringify(cfg.plugins, null, 1));

  console.log('\n===== C. 点击二维码按钮，观察 60 秒 =====');
  await js("document.getElementById('btnQrcode').click()");
  const t0 = Date.now();
  let last = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const txt = await js("document.getElementById('qrBox').innerText").catch(() => '');
    if (txt && txt !== last) { last = txt; console.log('  t=' + Math.round((Date.now() - t0) / 1000) + 's  ' + txt.replace(/\s+/g, ' ').slice(0, 110)); }
    if (/liteapp|失败|超时/.test(txt)) break;
  }
  const qrFinal = await js("document.getElementById('qrBox').innerText").catch(() => '');
  console.log('QR 最终文本:', JSON.stringify(qrFinal.slice(0, 160)));
  console.log('QR 是否拿到链接:', /liteapp/.test(qrFinal));
  await js("window.api.cancelQrcode && window.api.cancelQrcode()").catch(() => {});
  await sleep(500);
  console.log('--- boot log 尾部 ---');
  bootLog().split(/\r?\n/).slice(-12).forEach((l) => console.log('  ' + l));

  try { ws.close(); } catch (e) {}
  spawnSync('taskkill', ['/PID', String(app.pid), '/F', '/T'], { windowsHide: true });
  process.exit(0);
})();

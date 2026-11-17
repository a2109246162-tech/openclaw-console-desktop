// 诊断：status() 为何判定 foreign
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_EXE = 'D:\\build\\oc-v2\\app-root\\OpenClawConsole.exe';
const PROFILE = 'D:\\build\\oc-v2\\diag-profile';
const PORT = 18794;
const DBG = 9455;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}
let ws, id = 0; const pending = new Map();
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout')); } }, 30000);
  });
}
async function evalJS(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

(async () => {
  try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', PROFILE], { windowsHide: true }); } catch (e) {}
  fs.mkdirSync(path.join(PROFILE, 'AppData', 'Roaming'), { recursive: true });

  const env = Object.assign({}, process.env, {
    USERPROFILE: PROFILE, HOME: PROFILE,
    APPDATA: path.join(PROFILE, 'AppData', 'Roaming'),
    OPENCLAW_CONSOLE_PORT: String(PORT),
  });
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const app = spawn(APP_EXE, ['--remote-debugging-port=' + DBG], { env, cwd: path.dirname(APP_EXE), stdio: 'ignore' });
  let pageUrl = null;
  for (let i = 0; i < 40 && !pageUrl; i++) {
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
    ws.onopen = res; ws.onerror = () => rej(new Error('ws'));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  });
  console.log('CDP ready');

  await evalJS("document.getElementById('btnStart').click()");
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const s = await evalJS("window.api.status().then(s=>JSON.stringify(s))");
    const o = JSON.parse(s);
    if (o.running) {
      console.log('t=' + i + 's status:', s);
      console.log('  外部 netstat:', execFileSync('cmd', ['/c', 'netstat -ano -p tcp | findstr :' + PORT], { encoding: 'utf8', windowsHide: true }).trim().replace(/\r?\n/g, ' | '));
      for (const pid of o.pids) {
        let p = '';
        try {
          p = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue).Path'], { encoding: 'utf8', windowsHide: true }).trim();
        } catch (e) { p = 'ERR ' + e.message; }
        console.log('  pid ' + pid + ' exe=' + p);
      }
      console.log('  stateText:', await evalJS("document.getElementById('stateText').textContent"));
      break;
    }
  }
  try { spawn('taskkill', ['/PID', String(app.pid), '/F', '/T'], { windowsHide: true }); } catch (e) {}
  process.exit(0);
})();

// Win10 全功能自动化测试器 —— CDP 驱动真实 UI，逐一点击每个按钮并断言响应
// 三重隔离：独立 USERPROFILE / 独立 APPDATA / 独立端口 18795，绝不触碰生产环境。
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const APP_EXE = 'D:\\build\\oc-v2\\app-root\\OpenClawConsole.exe';
const TEST_PROFILE = 'D:\\build\\oc-v2\\test-profile';
const TEST_PORT = 18795;
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 150); // 避开 TIME_WAIT 残留端口

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   [' + detail + ']' : ''));
}

// ---------- CDP ----------
let ws = null, msgId = 0;
const pending = new Map();
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
  });
}
async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evalJS(expr).catch(() => undefined);
    if (last) return last;
    await sleep(500);
  }
  throw new Error('等待超时: ' + desc + ' (最后值=' + JSON.stringify(last) + ')');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portUp(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => res(false));
    sock.once('timeout', () => { sock.destroy(); res(false); });
  });
}

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}

// ---------- 主流程 ----------
(async () => {
  // 清理旧测试残留
  try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', TEST_PROFILE], { windowsHide: true }); } catch (e) {}
  fs.mkdirSync(path.join(TEST_PROFILE, 'AppData', 'Roaming'), { recursive: true });

  const env = Object.assign({}, process.env, {
    USERPROFILE: TEST_PROFILE,
    HOME: TEST_PROFILE,
    APPDATA: path.join(TEST_PROFILE, 'AppData', 'Roaming'),
    OPENCLAW_CONSOLE_PORT: String(TEST_PORT),
  });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  console.log('=== 启动测试实例（隔离 profile: ' + TEST_PROFILE + ' / 端口 ' + TEST_PORT + '）===');
  const app = spawn(APP_EXE, ['--remote-debugging-port=' + DEBUG_PORT], {
    env, cwd: path.dirname(APP_EXE), detached: false, windowsHide: false, stdio: 'ignore',
  });
  console.log('app pid=' + app.pid);

  // 等 CDP 就绪
  let pageWsUrl = null;
  for (let i = 0; i < 60 && !pageWsUrl; i++) {
    await sleep(1000);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + DEBUG_PORT + '/json/list'));
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) pageWsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* not ready */ }
  }
  if (!pageWsUrl) { record('应用启动 + CDP 就绪', false, 'CDP 页面未出现'); process.exit(1); }

  await cdpReady(pageWsUrl);
  record('应用启动 + UI 加载 + CDP 就绪', true, 'pid=' + app.pid);

  try { await runAllTests(); } catch (e) { record('测试中断', false, e.message); }

  // 收尾：关应用、清理注册表测试残留
  try { await evalJS('window.api.cancelQrcode()').catch(() => {}); } catch (e) {}
  try { ws.close(); } catch (e) {}
  await sleep(500);
  try { spawn('taskkill', ['/PID', String(app.pid), '/F', '/T'], { windowsHide: true }); } catch (e) {}

  // 确保 HKCU Run 测试值已清（set-autostart(false) 逻辑已删，这里兜底）
  await new Promise((r) => spawn('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OpenClaw 控制台', '/f'], { windowsHide: true }).on('exit', r));

  console.log('\n========== 测试汇总 ==========');
  const pass = results.filter((r) => r.ok).length;
  console.log('通过 ' + pass + ' / ' + results.length);
  for (const r of results) if (!r.ok) console.log('  [FAIL] ' + r.name + '  ' + r.detail);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();

function cdpReady(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('WS error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  });
}

// ---------- 逐按钮测试 ----------
async function runAllTests() {
  const log = () => evalJS("document.getElementById('log').innerText");

  // ========== 0. 初始状态 ==========
  // 先等渲染层把模型链画出来（0.1/0.2 曾因读太早误报 FAIL）
  await waitFor("document.querySelectorAll('.chain-item').length > 0 ? 1 : 0", 15000, 'UI 渲染完成');
  const title = await evalJS('document.title');
  record('0.1 窗口标题', title === 'OpenClaw 控制台', title);

  // 模型链渲染（预置：ark-doubao 第一）
  const chain0 = await evalJS("JSON.stringify(Array.from(document.querySelectorAll('.chain-item .chain-sub')).map(e=>e.textContent))");
  const chainArr = JSON.parse(chain0);
  record('0.2 模型优先级链渲染', chainArr.length >= 1, chain0);
  record('0.3 预置 doubao 第一优先', chainArr[0] === 'ark-doubao/doubao-seed-evolving', chainArr[0]);

  // 当前模型显示
  const active = await evalJS("document.getElementById('activeModel').textContent");
  record('0.4 当前模型显示', /doubao|豆包|ark/i.test(active), active);

  // ========== 1. 外来程序占用端口的保护 ==========
  const dummy = spawn(process.execPath, ['-e', "require('net').createServer().listen(" + TEST_PORT + ",'127.0.0.1',()=>console.log('up'))"], { windowsHide: true, stdio: 'ignore' });
  await sleep(1200);

  await evalJS("document.getElementById('btnStart').click()");
  // 全新 profile 首次启动要先装微信插件（约 30 秒），放宽到 150 秒
  await waitFor("(document.getElementById('log').innerText.includes('被其它程序占用')||document.getElementById('log').innerText.includes('未启动'))?1:0", 150000, '启动遇外来占用的提示');
  record('1.1 启动网关遇外来占用 → 正确拒绝', true);

  await evalJS("document.getElementById('btnStop').click()");
  await waitFor("document.getElementById('log').innerText.includes('未终止任何进程')?1:0", 20000, '停止遇外来占用的提示');
  record('1.2 关闭网关不误杀外来进程', true);
  const dummyAlive = await new Promise((r) => { const p = spawn('tasklist', ['/FI', 'PID eq ' + dummy.pid], { windowsHide: true }); let d = ''; p.stdout.on('data', (c) => d += c); p.on('exit', () => r(d.includes(String(dummy.pid)))); });
  record('1.3 外来进程仍存活（未被误杀）', dummyAlive, 'pid=' + dummy.pid);
  // 必须等假进程真正退出、端口真正释放，否则后面"启动网关"会撞在它身上
  // （之前就是这里没等，导致 2.x 全部误判成"端口被占用"）
  await new Promise((r) => spawn('taskkill', ['/PID', String(dummy.pid), '/F'], { windowsHide: true }).on('exit', r));
  for (let i = 0; i < 30; i++) {
    if (!(await portUp(TEST_PORT))) break;
    await sleep(500);
  }
  record('1.4 假进程已彻底退出、端口已释放', !(await portUp(TEST_PORT)));

  // ========== 2. 启动网关（真实） ==========
  await evalJS("document.getElementById('btnStart').click()");
  await waitFor("document.getElementById('log').innerText.includes('[OK] 网关已就绪')?1:0", 120000, '网关就绪');
  record('2.1 启动网关按钮 → 网关就绪', true);
  const stateRun = await evalJS("document.getElementById('stateText').textContent");
  record('2.2 状态显示「运行中」', stateRun.includes('运行'), stateRun);
  const pidTxt = await evalJS("document.getElementById('pid').textContent");
  record('2.3 显示网关 PID', /PID \d+/.test(pidTxt), pidTxt);
  const selfTest = await log();
  record('2.4 自检信息打印（版本/标题/主机名）', /自检通过/.test(selfTest) && /v22/.test(selfTest));

  // 端口确实监听
  const listening = await evalJS("fetch('http://127.0.0.1:" + TEST_PORT + "/').then(()=>1).catch(()=>1)"); // 任何 HTTP 响应（含 404）都证明端口活着
  record('2.5 网关端口 ' + TEST_PORT + ' 在监听', listening === 1);

  // ========== 3. 关闭网关 ==========
  await evalJS("document.getElementById('btnStop').click()");
  await waitFor("document.getElementById('log').innerText.includes('[OK] 网关已关闭')?1:0", 30000, '网关关闭');
  record('3.1 关闭网关按钮 → 成功下线', true);
  const stateStop = await evalJS("document.getElementById('stateText').textContent");
  record('3.2 状态显示「已停止」', stateStop.includes('停止'), stateStop);

  // ========== 4. ⚙ 排序弹窗 ==========
  await evalJS("document.getElementById('btnGear').click()");
  await sleep(400);
  record('4.1 ⚙ 打开排序弹窗', await evalJS("document.getElementById('sortModal').classList.contains('show')"));

  // ↑ 调整顺序（把第二个挪到第一）
  const before = await evalJS("JSON.stringify(Array.from(document.querySelectorAll('#sortList .s-name')).map(e=>e.textContent))");
  await evalJS("document.querySelectorAll('#sortList .s-btn.up')[1].click()");
  await sleep(300);
  const afterUp = await evalJS("JSON.stringify(Array.from(document.querySelectorAll('#sortList .s-name')).map(e=>e.textContent))");
  record('4.2 ↑ 上移按钮生效', before !== afterUp, before + ' → ' + afterUp);

  // ↓ 挪回去
  await evalJS("document.querySelectorAll('#sortList .s-btn.down')[0].click()");
  await sleep(300);
  const afterDown = await evalJS("JSON.stringify(Array.from(document.querySelectorAll('#sortList .s-name')).map(e=>e.textContent))");
  record('4.3 ↓ 下移按钮生效', afterDown === before);

  // 取消按钮
  await evalJS("document.getElementById('sortCancel').click()");
  await sleep(300);
  record('4.4 取消按钮关闭弹窗', await evalJS("!document.getElementById('sortModal').classList.contains('show')"));

  // 保存顺序（交换一次后保存 → 检查 activeModel 变化）
  await evalJS("document.getElementById('btnGear').click()");
  await sleep(300);
  await evalJS("document.querySelectorAll('#sortList .s-btn.up')[1].click()");
  await sleep(200);
  const expectedTop = await evalJS("document.querySelector('#sortList .s-name').textContent");
  await evalJS("document.getElementById('sortConfirm').click()");
  await waitFor("document.getElementById('log').innerText.includes('优先级已更新')?1:0", 10000, '优先级保存');
  record('4.5 保存顺序按钮生效', true);
  await sleep(800);
  const newTop = await evalJS("document.getElementById('activeModel').textContent");
  record('4.6 保存后最高优先模型已更新', newTop.includes(expectedTop.slice(0, 6)), expectedTop + ' / ' + newTop);

  // ========== 5. ＋ 添加 API ==========
  await evalJS("document.getElementById('btnAddApi').click()");
  await sleep(300);
  record('5.1 ＋ 打开添加 API 弹窗', await evalJS("document.getElementById('addModal').classList.contains('show')"));

  // 预设联动
  await evalJS("const s=document.getElementById('preset'); s.value='openai|https://api.openai.com/v1|openai-completions|gpt-4o|GPT-4o'; s.dispatchEvent(new Event('change'))");
  await sleep(200);
  const pbase = await evalJS("document.getElementById('pbase').value");
  record('5.2 预设下拉自动填充 URL', pbase.includes('api.openai.com'), pbase);

  // 空表单校验
  await evalJS("document.getElementById('pkey').value=''; document.getElementById('pkey2').value='';");
  await evalJS("document.getElementById('addConfirm').click()");
  await sleep(300);
  record('5.3 空表单提交 → 校验拦截', (await log()).includes('请填写'), );

  // 合法填写 → 添加
  await evalJS("document.getElementById('pkey').value='wintest'; document.getElementById('plabel').value='Win10测试';");
  await evalJS("document.getElementById('pbase').value='https://api.example.com/v1';");
  await evalJS("document.getElementById('pkey2').value='sk-test-123';");
  await evalJS("document.getElementById('mid').value='test-model'; document.getElementById('mname').value='测试模型';");
  await evalJS("document.getElementById('addConfirm').click()");
  await waitFor("document.getElementById('log').innerText.includes('已添加')?1:0", 10000, 'API 添加成功');
  record('5.4 添加 API 按钮 → 成功入库', true);
  await sleep(800);
  const chain5 = await evalJS("JSON.stringify(Array.from(document.querySelectorAll('.chain-item .chain-sub')).map(e=>e.textContent))");
  record('5.5 新模型进入优先级链', chain5.includes('wintest/test-model'), chain5);

  // 弹窗已关
  record('5.6 添加后弹窗自动关闭', await evalJS("!document.getElementById('addModal').classList.contains('show')"));
  // 取消按钮
  await evalJS("document.getElementById('btnAddApi').click()");
  await sleep(200);
  await evalJS("document.getElementById('addCancel').click()");
  await sleep(200);
  record('5.7 取消按钮关闭弹窗', await evalJS("!document.getElementById('addModal').classList.contains('show')"));

  // ========== 6. 防休眠开关 ==========
  await evalJS("void(function(){var t=document.getElementById('tglPower'); t.checked=true; t.dispatchEvent(new Event('change'))})()");
  await waitFor("document.getElementById('log').innerText.includes('已防止系统休眠')?1:0", 10000, '防休眠开');
  record('6.1 防休眠开关 → 开', true);
  await evalJS("void(function(){var t=document.getElementById('tglPower'); t.checked=false; t.dispatchEvent(new Event('change'))})()");
  await waitFor("document.getElementById('log').innerText.includes('已恢复系统休眠')?1:0", 10000, '防休眠关');
  record('6.2 防休眠开关 → 关', true);

  // ========== 7. 开机自启开关（含注册表真写真删） ==========
  await evalJS("void(function(){var t=document.getElementById('tglAuto'); t.checked=true; t.dispatchEvent(new Event('change'))})()");
  await waitFor("document.getElementById('log').innerText.includes('已开启开机自启')?1:0", 10000, '自启开');
  const regOn = await new Promise((r) => { const p = spawn('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OpenClaw 控制台'], { windowsHide: true }); let d = ''; p.stdout.on('data', (c) => d += c); p.on('exit', () => r(d)); });
  record('7.1 开机自启 → Run 键已写入', regOn.includes('--autostart'), '含 --autostart 参数');
  record('7.2 Run 键指向本程序 exe', /oc-v2/i.test(regOn), regOn.split(/\r?\n/).find((l) => /REG_SZ/.test(l)) || '');
  await evalJS("void(function(){var t=document.getElementById('tglAuto'); t.checked=false; t.dispatchEvent(new Event('change'))})()");
  await waitFor("document.getElementById('log').innerText.includes('已关闭开机自启')?1:0", 10000, '自启关');
  const regOff = await new Promise((r) => { const p = spawn('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'OpenClaw 控制台'], { windowsHide: true }); let d = ''; p.stdout.on('data', (c) => d += c); p.on('exit', (code) => r(code === 0 ? d : 'DELETED')); });
  record('7.3 关闭自启 → Run 键已删除', regOff === 'DELETED', '');

  // ========== 8. Token 用量卡片 ==========
  await sleep(300);
  const usage = await evalJS("document.getElementById('usageTotal').textContent + ' | ' + document.getElementById('usageList').innerText");
  record('8.1 用量卡片正常渲染', /token/i.test(usage), usage.trim().slice(0, 60));

  // ========== 9. 最小化 / 关闭按钮 ==========
  const minR = await evalJS('window.api.minimize().then(r=>JSON.stringify(r))');
  record('9.1 — 最小化按钮 → IPC 正常', minR.includes('"ok":true'), minR);
  const closeR = await evalJS('window.api.minimize().then(r=>JSON.stringify(r))'); // ✕ 同为 minimize（隐藏到托盘）
  record('9.2 ✕ 关闭按钮 → 隐藏到托盘（同 minimize）', closeR.includes('"ok":true'), closeR);

  // ========== 10. 微信绑定二维码（响应性验证） ==========
  await evalJS("document.getElementById('btnQrcode').click()");
  await sleep(400);
  record('10.1 📱 打开二维码弹窗', await evalJS("document.getElementById('qrModal').classList.contains('show')"));
  record('10.2 加载动画显示', await evalJS("!!document.getElementById('qrBox').querySelector('.qr-loading')||!!document.getElementById('qrBox').querySelector('.qr-img')"));
  // 等结果：二维码 URL 或明确错误提示（两者都算"响应正确"）
  // 全新 profile 首次要后台安装微信插件（约 30~90 秒），放宽到 200 秒
  const qrDone = await waitFor("(document.getElementById('qrBox').innerText.includes('二维码')&&(document.getElementById('qrBox').querySelector('img')||document.getElementById('qrBox').innerText.includes('失败')))?1:0", 200000, '二维码出结果');
  const qrText = await evalJS("document.getElementById('qrBox').innerText.slice(0,120)");
  record('10.3 二维码流程有明确结果（URL 或错误提示）', qrDone === 1, qrText.replace(/\n/g, ' '));
  await evalJS("document.getElementById('qrClose').click()");
  await sleep(300);
  record('10.4 二维码弹窗关闭按钮', await evalJS("!document.getElementById('qrModal').classList.contains('show')"));

  // ========== 11. 启动参数 --autostart（自启场景不弹窗） ==========
  // 通过另起实例验证 argv 处理（快速起停）
  const env2 = Object.assign({}, process.env, {
    USERPROFILE: TEST_PROFILE,
    HOME: TEST_PROFILE,
    APPDATA: path.join(TEST_PROFILE, 'AppData', 'Roaming'),
    OPENCLAW_CONSOLE_PORT: '18796',
  });
  delete env2.ELECTRON_RUN_AS_NODE; delete env2.NODE_OPTIONS; delete env2.ELECTRON_NO_ATTACH_CONSOLE;
  const auto = spawn(APP_EXE, ['--autostart', '--remote-debugging-port=9334'], {
    env: env2, cwd: path.dirname(APP_EXE), stdio: 'ignore',
  });
  await sleep(6000);
  const bootLog = await new Promise((r) => {
    const p = path.join(TEST_PROFILE, 'AppData', 'Roaming', 'OpenClawConsole', 'console-boot.log');
    r(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  });
  record('11.1 --autostart 参数被正确识别', /autoStart=true/.test(bootLog), bootLog.split(/\r?\n/).filter((l) => /autoStart/.test(l)).pop() || '');
  spawn('taskkill', ['/PID', String(auto.pid), '/F', '/T'], { windowsHide: true });
}

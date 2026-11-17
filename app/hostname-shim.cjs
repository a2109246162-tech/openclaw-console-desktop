'use strict';
// Windows 7 兼容 shim（Node 22 / libuv 在 Win7 上缺失 Win8+ API 的兜底层）
//
// 覆盖问题：uv_os_gethostname → GetHostNameW（Win8+）缺失 → ENOSYS → 网关启动失败。
//
// 注意：process.title 的 `Assertion failed: process_title` 不在此 shim 内处理——
// 该断言发生在 Node C++ 引导阶段（早于 --require），必须由启动参数 `--title=OpenClaw`
// 在 main.js 的 shimArgs() 里预先分配 process_title 来规避（libuv#4807）。

const os = require('os');

// 主机名兜底
const origHostname = os.hostname;
function safeHostname() {
  try {
    const h = origHostname.call(os);
    if (h && typeof h === 'string' && h.length > 0) return h;
  } catch (e) { /* ENOSYS 等，走回退 */ }
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'openclaw-pc';
}
try {
  Object.defineProperty(os, 'hostname', {
    configurable: true,
    writable: true,
    value: safeHostname,
  });
} catch (e) {
  try { os.hostname = safeHostname; } catch (e2) {}
}

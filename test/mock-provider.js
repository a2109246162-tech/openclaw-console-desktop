// 本地 OpenAI 兼容 mock 服务端 —— 用于验证「添加 API」与「顺序切换」是否真的生效。
// 它会记录每次收到的请求（模型名 + Authorization），用于断言网关到底调了谁。
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.argv[2] || '18901', 10);
const LOG = process.argv[3] || 'D:\\build\\oc-v2\\mock-requests.log';
const LABEL = process.argv[4] || 'A';          // 这个 mock 模拟哪个 provider
const BEHAVIOR = process.argv[5] || 'ok';       // ok | fail —— fail 用于测回退

function readBody(req) {
  return new Promise((res) => {
    let d = '';
    req.on('data', (c) => d += c);
    req.on('end', () => res(d));
  });
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  let model = '';
  try { model = JSON.parse(body).model || ''; } catch (e) {}
  const auth = req.headers.authorization || '';
  fs.appendFileSync(LOG, JSON.stringify({
    t: Date.now(), provider: LABEL, path: req.url, model, auth,
    hasUsage: /include_usage/.test(body), bodyLen: body.length,
  }) + '\n');

  if (req.url.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }

  if (BEHAVIOR === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock failure for ' + LABEL, type: 'server_error' } }));
    return;
  }

  // 正常返回：SSE 流式 + usage
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  chunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  chunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '来自 ' + LABEL + ' 的回复' } }] });
  chunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  chunk({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), provider: LABEL, event: 'listen', port: PORT, behavior: BEHAVIOR }) + '\n');
  console.log('mock ' + LABEL + ' listening on ' + PORT + ' behavior=' + BEHAVIOR);
});

const http = require('http');
const net = require('net');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 7842);
const UPSTREAM = process.env.UPSTREAM || 'http://host.docker.internal:7842';
const upstream = new URL(UPSTREAM);

const TCP_FORWARDS = String(process.env.TCP_FORWARDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [listen, target] = item.split('=');
    const [host, port] = String(target || '').split(':');
    return { listen: Number(listen), host, port: Number(port) };
  })
  .filter((item) => item.listen && item.host && item.port);

for (const forward of TCP_FORWARDS) {
  const server = net.createServer((socket) => {
    const target = net.connect(forward.port, forward.host);
    socket.pipe(target).pipe(socket);
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
  });
  server.on('error', (error) => {
    console.log(`[tcp-error] ${forward.listen} -> ${forward.host}:${forward.port} ${error.message}`);
  });
  server.listen(forward.listen, '0.0.0.0', () => {
    console.log(`[tcp] ${forward.listen} -> ${forward.host}:${forward.port}`);
  });
}

const ALLOWLIST = [
  /^\/v1\/chat\/completions$/,
  /^\/api\/agent(\/|$)/,
  /^\/health$/
];

function allowed(pathname) {
  return ALLOWLIST.some((pattern) => pattern.test(pathname));
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (!allowed(pathname)) {
    console.log(`[deny] ${req.method} ${pathname}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '该路径不在出网代理白名单中' } }));
    return;
  }

  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${upstream.hostname}:${upstream.port || 80}`,
      'x-forwarded-for': req.socket.remoteAddress || ''
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    console.log(`[proxy] ${req.method} ${pathname} -> ${proxyRes.statusCode}`);
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    console.log(`[error] ${req.method} ${pathname} ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: `出网代理连接失败：${error.message}` } }));
  });

  req.pipe(proxyReq);
});

server.on('connect', (req, socket) => {
  console.log(`[deny-connect] ${req.url}`);
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[egress] listening on ${PORT}, upstream=${UPSTREAM}`);
});

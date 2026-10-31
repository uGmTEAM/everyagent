import http from 'node:http';
import { handleRequest } from './routes.mjs';

export function startHttpServer (app) {
  const { host, port } = app.config.http;
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    handleRequest(app, req, res, url).catch(error => {
      app.logger?.error('[http] 请求处理失败', error);
      if (!res.headersSent) {
        const status = error instanceof SyntaxError ? 400 : /超过限制/.test(error.message || '') ? 413 : 500;
        const code = status === 400 ? 'bad_json' : status === 413 ? 'too_large' : 'internal';
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code, message: error.message || String(error) } }));
      } else {
        res.end();
      }
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 65000;
  server.listen(port, host, () => {
    app.logger?.info(`[http] AI 接口已启动 http://${host}:${port}`);
  });
  server.on('error', error => {
    app.logger?.error('[http] 服务启动失败', error);
  });
  return server;
}

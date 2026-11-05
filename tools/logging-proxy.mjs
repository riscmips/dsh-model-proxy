// Minimal logging forward proxy used to prove that Host traffic really travels
// through the configured proxy. Not part of the plugin; verification only.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const port = Number(process.argv[2] ?? 18080);
const logFile = process.argv[3] ?? './tools/proxy.log';
fs.writeFileSync(logFile, '');

const log = (line) => {
  const text = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(logFile, text);
  process.stdout.write(text);
};

const server = http.createServer((req, res) => {
  log(`HTTP  ${req.method} ${req.url} auth=${req.headers['proxy-authorization'] ? 'yes' : 'no'}`);
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end('absolute-form required');
    return;
  }
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = http.request(
    {
      host: target.hostname,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    log(`HTTP  upstream error ${error.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });
  req.pipe(upstream);
});

server.on('connect', (req, socket, head) => {
  log(`CONNECT ${req.url} auth=${req.headers['proxy-authorization'] ? 'yes' : 'no'}`);
  const [host, rawPort] = String(req.url).split(':');
  const upstream = net.connect({ host, port: Number(rawPort || 443) }, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', (error) => {
    log(`CONNECT error ${error.message}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));

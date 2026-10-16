// A TLS reverse proxy for tests/net/tailnet-native.sh (cloud sessions, docs/cloud.md): what Caddy
// does in tests/net/tailnet.sh. TLS on 127.0.0.1:<port> with the test CA's certificate, plain HTTP
// to headscale on <inner>, CORS on /key (a page fetches it), WebSocket upgrades passed through.
// Usage: node tests/net/tls-proxy.ts <port> <inner> <cert.pem> <key.pem>
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';

const [port, inner, cert, key] = process.argv.slice(2);
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const up = request({ host: '127.0.0.1', port: Number(inner), method: req.method, path: req.url, headers: req.headers }, (r) => {
    const headers = { ...r.headers };
    if (req.url?.split('?')[0] === '/key') headers['access-control-allow-origin'] = '*';
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
server.on('upgrade', (req, sock, head) => {
  const up = connect(Number(inner), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  const end = () => { up.destroy(); sock.destroy(); };
  up.on('error', end);
  sock.on('error', end);
});
server.listen(Number(port), '127.0.0.1');

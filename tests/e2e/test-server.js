import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { TEST_PAGE_PORT } from './test-page.js';

const html = `<!doctype html>
<html>
<head><title>tk3 e2e test page</title></head>
<body>
  <h1>tk3 e2e test page</h1>
  <script>
    if (!localStorage.getItem('greeting')) localStorage.setItem('greeting', 'hello');
    if (!sessionStorage.getItem('counter')) sessionStorage.setItem('counter', '1');
  </script>
</body>
</html>`;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}

// /cookies/: csrf is rewritten on every response, like a site's own rotating
// cookie; sid changes only through /cookies/login?user=NAME, like an account switch.
function serveCookiePages(req, res, url) {
  const setCookies = [`csrf=${randomBytes(6).toString('hex')}; Path=/`];
  if (url.pathname === '/cookies/login') {
    setCookies.push(`sid=${encodeURIComponent(url.searchParams.get('user') ?? '')}; Path=/; HttpOnly`);
    res.writeHead(302, { 'Set-Cookie': setCookies, Location: '/cookies/' });
    res.end();
    return;
  }
  const user = (parseCookies(req.headers.cookie).sid ?? '').replace(/[^\w-]/g, '');
  res.writeHead(200, { 'Set-Cookie': setCookies, 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>tk3 e2e cookie page</title><h1>signed in as: ${user || '(none)'}</h1>`);
}

// /group/: gsid is a domain cookie for example.test, shared by every subdomain;
// it changes only through /group/login?user=NAME.
function serveGroupPages(req, res, url) {
  if (url.pathname === '/group/login') {
    const setCookie = `gsid=${encodeURIComponent(url.searchParams.get('user') ?? '')}; Domain=example.test; Path=/`;
    res.writeHead(302, { 'Set-Cookie': setCookie, Location: '/group/' });
    res.end();
    return;
  }
  const user = (parseCookies(req.headers.cookie).gsid ?? '').replace(/[^\w-]/g, '');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>tk3 e2e group page</title><h1>group user: ${user || '(none)'}</h1>`);
}

// /post/: a form whose POST result page counts its hits at /post/count, to see
// whether reloading a tab that shows it sends the form again.
let postHits = 0;
function servePostPages(req, res, url) {
  if (url.pathname === '/post/submit' && req.method === 'POST') {
    postHits++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>tk3 e2e post result</title><h1>posted ${postHits}</h1>
<script>localStorage.setItem('greeting', localStorage.getItem('greeting') || 'hello');</script>`);
    return;
  }
  if (url.pathname === '/post/count') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(String(postHits));
    return;
  }
  if (url.pathname === '/post/reset') {
    postHits = 0;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('0');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>tk3 e2e post form</title>
<form method="post" action="/post/submit"><input name="v" value="1"><button>send</button></form>`);
}

// /cache/: a page the browser may keep for five minutes, counting the requests that
// reach the server at /cache/count, to see whether loading a tab again asks the server.
let cacheHits = 0;
function serveCachePages(req, res, url) {
  if (url.pathname === '/cache/count') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(String(cacheHits));
    return;
  }
  cacheHits++;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'private, max-age=300' });
  res.end(`<!doctype html><title>tk3 e2e cached page</title><h1>served ${cacheHits}</h1>`);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${TEST_PAGE_PORT}`);
  if (url.pathname.startsWith('/post/')) {
    servePostPages(req, res, url);
    return;
  }
  if (url.pathname.startsWith('/cache/')) {
    serveCachePages(req, res, url);
    return;
  }
  if (url.pathname.startsWith('/cookies/')) {
    serveCookiePages(req, res, url);
    return;
  }
  if (url.pathname.startsWith('/group/')) {
    serveGroupPages(req, res, url);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}).listen(TEST_PAGE_PORT, () => {
  console.log(`e2e test server listening on http://localhost:${TEST_PAGE_PORT}`);
});

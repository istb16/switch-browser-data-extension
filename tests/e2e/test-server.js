import { createServer } from 'node:http';

const PORT = 58173;

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

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}).listen(PORT, () => {
  console.log(`e2e test server listening on http://localhost:${PORT}`);
});

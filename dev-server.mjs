import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const PORT = process.env.PORT || 8080;
const ROOT_DIR = process.argv[2] || __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMimeType(path) {
  const ext = extname(path).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveFile(filePath, res) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const content = readFileSync(filePath);
    const mimeType = getMimeType(filePath);
    
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
}

const server = createServer((req, res) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  let path = req.url.split('?')[0]; // Remove query string
  if (path === '/') {
    path = '/index.html';
  }

  const filePath = join(ROOT_DIR, path);

  // Security: prevent directory traversal
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  serveFile(filePath, res);
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   MekanApp - Development Server        ║
╚════════════════════════════════════════╝

🌐 Server running at:
   http://localhost:${PORT}
   http://127.0.0.1:${PORT}

📁 Serving from: ${ROOT_DIR}

💡 Press Ctrl+C to stop the server
`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.error(`   Try: PORT=${PORT + 1} npm run dev\n`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

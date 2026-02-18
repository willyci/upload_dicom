// Force restart
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { PUBLIC_DIR } from './config.js';
import uploadRoutes from './routes/uploads.js';

// --- Crash handlers: catch silent deaths ---
process.on('uncaughtException', (err) => {
    const mem = process.memoryUsage();
    console.error('=== UNCAUGHT EXCEPTION ===');
    console.error('Memory:', Math.round(mem.rss / 1024 / 1024), 'MB RSS,',
        Math.round(mem.heapUsed / 1024 / 1024), 'MB heap used /',
        Math.round(mem.heapTotal / 1024 / 1024), 'MB heap total');
    console.error(err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const mem = process.memoryUsage();
    console.error('=== UNHANDLED REJECTION ===');
    console.error('Memory:', Math.round(mem.rss / 1024 / 1024), 'MB RSS,',
        Math.round(mem.heapUsed / 1024 / 1024), 'MB heap used /',
        Math.round(mem.heapTotal / 1024 / 1024), 'MB heap total');
    console.error(reason);
});

const app = express();

app.use(express.static(PUBLIC_DIR));

app.use('/', uploadRoutes);

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// --- Self-signed cert for HTTPS (needed for WebXR on Quest/Vision Pro) ---
const certDir = path.resolve('certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

function ensureSelfSignedCert() {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return true;
    fs.mkdirSync(certDir, { recursive: true });

    // Write a minimal openssl config to avoid -subj issues on Windows
    const confPath = path.join(certDir, 'openssl.cnf');
    fs.writeFileSync(confPath, [
        '[req]',
        'distinguished_name = req_dn',
        'prompt = no',
        '[req_dn]',
        'CN = dicom-processor',
    ].join('\n'));

    // Try several openssl paths (Git on Windows bundles one)
    const candidates = ['openssl'];
    if (process.platform === 'win32') {
        candidates.push(
            'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
            'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
            'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
        );
    }

    for (const bin of candidates) {
        try {
            const cmd = `"${bin}" req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -config "${confPath}"`;
            execSync(cmd, { stdio: 'pipe' });
            try { fs.unlinkSync(confPath); } catch {}
            console.log('Generated self-signed certificate in certs/');
            return true;
        } catch {
            // try next candidate
        }
    }

    try { fs.unlinkSync(confPath); } catch {}
    console.warn('Could not generate self-signed cert (openssl not found?)');
    console.warn('HTTPS disabled. WebXR VR will only work on localhost.');
    return false;
}

// Start HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
    const mem = process.memoryUsage();
    console.log(`HTTP server running on http://0.0.0.0:${PORT}`);
    console.log(`Memory at startup: ${Math.round(mem.rss / 1024 / 1024)} MB RSS, ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap`);
    console.log(`GC exposed: ${typeof global.gc === 'function' ? 'yes' : 'no'}`);
});

server.keepAliveTimeout = 600000;
server.headersTimeout = 601000;

// Start HTTPS server (needed for WebXR on Quest/Vision Pro over LAN)
if (ensureSelfSignedCert()) {
    const httpsServer = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`HTTPS server running on https://0.0.0.0:${HTTPS_PORT} (for WebXR VR)`);
        console.log(`  → Open https://<your-ip>:${HTTPS_PORT} on Quest/Vision Pro`);
        console.log(`  → Accept the self-signed certificate warning once`);
    });
    httpsServer.keepAliveTimeout = 600000;
    httpsServer.headersTimeout = 601000;
}

// Force restart
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

import express from 'express';
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
const server = app.listen(PORT, () => {
    const mem = process.memoryUsage();
    console.log(`Server running on port ${PORT}`);
    console.log(`Memory at startup: ${Math.round(mem.rss / 1024 / 1024)} MB RSS, ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap`);
    console.log(`GC exposed: ${typeof global.gc === 'function' ? 'yes' : 'no'}`);
});

// Increase limits to handle large file uploads
// 10 minutes keep-alive to prevent load balancers/proxies from killing connection
server.keepAliveTimeout = 600000; 
server.headersTimeout = 601000; // Must be greater than keepAliveTimeout

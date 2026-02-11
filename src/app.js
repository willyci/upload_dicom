import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

import express from 'express';
import { PUBLIC_DIR } from './config.js';
import uploadRoutes from './routes/uploads.js';

const app = express();

app.use(express.static(PUBLIC_DIR));

app.use('/', uploadRoutes);

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

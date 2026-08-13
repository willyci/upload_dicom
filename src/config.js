import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const UPLOADS_DIR = path.join(PROJECT_ROOT, 'public', 'uploads');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

/**
 * Upload limits, in one place and served to the browser at /upload-limits.
 *
 * The file count used to be 200, buried in a middleware call. A 501-slice body CT hit it a second
 * into the request: multer aborted while the browser was still sending 253 MB, so the connection
 * closed early and Railway's edge answered "Application failed to respond" - a 502 that looked like
 * a platform fault and said nothing about the real cause. The browser now checks these first.
 */
export const UPLOAD_LIMITS = {
    // A whole-body CT is routinely 500-1500 slices. Matches the ZIP entry cap below.
    maxFiles: Number(process.env.UPLOAD_MAX_FILES) || 1000,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxZipEntries: 1000,
    maxExtractedBytes: 512 * 1024 * 1024,
};

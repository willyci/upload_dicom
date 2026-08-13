import path from 'path';
import { UPLOADS_DIR } from '../config.js';

export function removePathBeforeUploads(fullPath) {
    if (!fullPath) return fullPath;
    const normalizedFullPath = path.resolve(fullPath).replace(/\\/g, '/');
    const normalizedUploadsDir = path.resolve(UPLOADS_DIR).replace(/\\/g, '/');

    if (normalizedFullPath.startsWith(normalizedUploadsDir)) {
        const rel = normalizedFullPath.slice(normalizedUploadsDir.length);
        return ('/uploads' + (rel.startsWith('/') ? rel : '/' + rel)).replace(/\/+/g, '/');
    }

    const parts = normalizedFullPath.split('/uploads');
    if (parts.length > 1) {
        return '/uploads' + parts.slice(1).join('/uploads');
    }
    return fullPath;
}

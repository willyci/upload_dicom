export function removePathBeforeUploads(fullPath) {
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/uploads');
    return '/uploads' + parts[1];
}

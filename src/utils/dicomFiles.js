import fs from 'fs';
import path from 'path';

/**
 * Deciding which uploaded files are DICOM.
 *
 * A .dcm extension is the easy case, but plenty of real exports have no extension at all - scanners
 * and PACS routinely write IM_0001, I0000001, or the SOP instance UID bare - and those used to be
 * silently skipped, leaving "No .dcm files found" on a folder that was full of them.
 *
 * So: trust the extension when there is one, and otherwise look at the bytes.
 */

const DICOM_EXTENSIONS = ['.dcm', '.dicom'];

// Letters only, and short: ".jpg", ".json", ".nii". Deliberately does not match ".12345".
const LOOKS_LIKE_A_TYPE_SUFFIX = /^\.[a-z]{1,5}$/;

// Names that carry no image data even though they are valid DICOM, and would otherwise be stacked
// into the volume as a slice with no rows or columns.
const NOT_IMAGES = ['dicomdir', 'dicomdir.', 'lockfile', 'version'];

/**
 * True when a Part-10 DICOM file starts with the standard 128-byte preamble followed by "DICM".
 * Cheap enough to run on every candidate: it reads 132 bytes.
 */
export function hasDicomMagic(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(132);
        const read = fs.readSync(fd, buffer, 0, 132, 0);
        return read === 132 && buffer.toString('latin1', 128, 132) === 'DICM';
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* nothing useful to do */ }
        }
    }
}

/**
 * Whether to treat a file as a DICOM image.
 *
 * @param {string} filePath  path to read magic bytes from
 * @param {string} [name]    name to judge by, when it differs from filePath - multer stores uploads
 *                           under a random name, so the extension only exists on originalname
 */
export function isDicomFile(filePath, name = filePath) {
    const base = path.basename(name).toLowerCase();
    const extension = path.extname(base);

    if (DICOM_EXTENSIONS.includes(extension))
        return true;

    if (NOT_IMAGES.includes(base))
        return false;

    // A real type suffix means this is not a candidate, and saves a read: .jpg, .json, .nii and the
    // bump maps this pipeline writes itself all live in these same folders.
    //
    // "Real" has to mean alphabetic, though. Plenty of exports name each file after its SOP instance
    // UID - 1.2.840.113619.2.55.3.12345 - where extname() returns ".12345", which is part of the
    // number rather than a file type. Treating that as an extension skipped whole studies.
    if (LOOKS_LIKE_A_TYPE_SUFFIX.test(extension))
        return false;

    return hasDicomMagic(filePath);
}

/** Every DICOM image under a directory tree, recursively. */
export async function findDicomFiles(dir) {
    const results = [];
    const items = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory())
            results.push(...await findDicomFiles(fullPath));
        else if (isDicomFile(fullPath))
            results.push(fullPath);
    }

    return results;
}

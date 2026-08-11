import fs from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * The temp volume file is always float32, because that is what the STL and MPR converters read. The
 * output files do not have to be: DICOM pixel data is at most 16 bits, so once slope and intercept
 * are applied the values are almost always integers inside the int16 range - which halves every
 * output file with no loss at all.
 *
 * Everything here works on a stream of one chunk at a time. Nothing may hold a whole volume: these
 * run to hundreds of megabytes and the server has been killed for less.
 */

const CHUNK = 4 * 1024 * 1024;   // bytes of float32 read at a time

export const BYTES_PER_VOXEL = { float32: 4, int16: 2 };

/**
 * Whether the outputs can be narrowed to int16, from the statistics gathered while the temp file was
 * written. Anything fractional (a PET series with a fractional RescaleSlope) or outside the int16
 * range keeps float32 - narrowing is only ever applied when it is provably lossless.
 *
 * Set VOLUME_DTYPE=float32 to force the old behaviour.
 */
export function resolveOutputDtype(volume) {
    const forced = process.env.VOLUME_DTYPE;
    if (forced === 'float32' || forced === 'int16') return forced;

    const stats = volume?.stats;
    if (!stats) return 'float32';

    return stats.allIntegral && stats.min >= -32768 && stats.max <= 32767 ? 'int16' : 'float32';
}

/** Human-readable reason for the chosen dtype, for the processing log. */
export function describeDtype(volume, dtype) {
    const forced = process.env.VOLUME_DTYPE;
    if (forced === 'float32' || forced === 'int16')
        return `${dtype} (forced by VOLUME_DTYPE)`;

    const s = volume?.stats;
    if (!s) return `${dtype} (no statistics available)`;
    if (dtype === 'int16') return `int16 (values ${s.min}..${s.max}, all integral) - half the size of float32`;
    if (!s.allIntegral) return 'float32 (values are not integral - probably a fractional RescaleSlope)';
    return `float32 (values ${s.min}..${s.max} do not fit int16)`;
}

/**
 * A readable stream of the voxel payload in the requested dtype.
 *
 * The float32 -> int16 conversion has to carry a partial value across chunk boundaries: a read is
 * not guaranteed to end on a 4-byte multiple. The old byte-copying helper never had to care.
 */
export function createVoxelStream(volume, dtype = 'float32') {
    const source = fs.createReadStream(volume.tempFilePath, { highWaterMark: CHUNK });
    if (dtype === 'float32')
        return source;

    let remainder = null;

    const narrow = new Transform({
        transform(chunk, _encoding, callback) {
            if (remainder) {
                chunk = Buffer.concat([remainder, chunk]);
                remainder = null;
            }

            const whole = chunk.length - (chunk.length % 4);
            if (whole < chunk.length)
                remainder = Buffer.from(chunk.subarray(whole));

            if (whole === 0) {
                callback();
                return;
            }

            const source32 = new Float32Array(chunk.buffer, chunk.byteOffset, whole / 4);
            const out = new Int16Array(source32.length);
            for (let i = 0; i < source32.length; i++)
                out[i] = source32[i];

            callback(null, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
        },
        flush(callback) {
            // A trailing partial value means the temp file is truncated; say so rather than emitting
            // a silently shifted volume.
            if (remainder && remainder.length > 0) {
                callback(new Error(`Volume data ends mid-value (${remainder.length} stray bytes)`));
                return;
            }
            callback();
        },
    });

    source.on('error', err => narrow.destroy(err));
    return source.pipe(narrow);
}

/** Appends the voxel payload to a file that already holds its header. */
export async function appendVolumeToFile(volume, outputPath, dtype = 'float32') {
    await pipeline(
        createVoxelStream(volume, dtype),
        fs.createWriteStream(outputPath, { flags: 'a' })
    );
}

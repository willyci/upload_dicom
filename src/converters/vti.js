import fs from 'fs';
import zlib from 'zlib';
import { createVoxelStream, resolveOutputDtype, describeDtype, BYTES_PER_VOXEL } from '../utils/volumeStream.js';

/**
 * VTK XML image data, with the voxels as zlib-compressed appended raw blocks.
 *
 * Two deliberate departures from what this used to write:
 *
 *   format="binary" meant base64, which inflates the payload by 4/3 - and vtk.js decodes the whole
 *   file into a JavaScript string before parsing, so those wasted bytes cost browser memory twice
 *   over. Appended raw carries no such tax.
 *
 *   The payload is compressed in fixed-size zlib blocks. vtk.js has supported
 *   vtkZLibDataCompressor for years, so this needs nothing new on the reading side.
 *
 * Still streamed: one 256 KB block is held at a time, never the volume.
 */

// Multiple of 4, so a block is a whole number of voxels at either data type.
const BLOCK = 256 * 1024;

export async function convertToVti(volume, outputPath) {
    console.log('Converting DICOM to VTI...');

    const { dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const [sx, sy, sz] = spacing;
    const [ox, oy, oz] = origin;

    const dtype = resolveOutputDtype(volume);
    console.log('VTI data type:', describeDtype(volume, dtype));

    const voxels = rows * columns * depth;
    const totalBytes = voxels * BYTES_PER_VOXEL[dtype];
    const blockCount = Math.max(1, Math.ceil(totalBytes / BLOCK));

    // The AppendedData prefix has to satisfy the reader's own regex, which is anchored to the start
    // of a line - hence the newline before the tag.
    const xmlHeader = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">
  <ImageData WholeExtent="0 ${columns - 1} 0 ${rows - 1} 0 ${depth - 1}" Origin="${ox} ${oy} ${oz}" Spacing="${sx} ${sy} ${sz}">
    <Piece Extent="0 ${columns - 1} 0 ${rows - 1} 0 ${depth - 1}">
      <PointData Scalars="Scalars">
        <DataArray type="${dtype === 'int16' ? 'Int16' : 'Float32'}" Name="Scalars" format="appended" offset="0" NumberOfTuples="${voxels}"/>
      </PointData>
    </Piece>
  </ImageData>
  <AppendedData encoding="raw">
    _`;

    const xmlFooter = `
  </AppendedData>
</VTKFile>`;

    fs.writeFileSync(outputPath, xmlHeader, 'utf8');

    // 'r+' rather than 'a': an append-mode descriptor ignores the position argument to writeSync and
    // sends every write to the end of the file, which would scatter the patched header instead of
    // placing it. That means tracking the write position here by hand.
    const outFd = fs.openSync(outputPath, 'r+');
    const compressedSizes = [];

    try {
        // The block header can only be written once every compressed size is known, but its length is
        // fixed by blockCount - so reserve the space now and patch it in at the end. That keeps this
        // to a single pass with no scratch file.
        const headerBytes = (3 + blockCount) * 4;
        const headerPosition = fs.statSync(outputPath).size;

        let position = headerPosition;
        const writeAt = buffer => {
            fs.writeSync(outFd, buffer, 0, buffer.length, position);
            position += buffer.length;
        };

        writeAt(Buffer.alloc(headerBytes, 0));

        let pending = Buffer.alloc(0);
        let lastBlockSize = 0;

        const writeBlock = block => {
            const compressed = zlib.deflateSync(block, { level: 6 });
            writeAt(compressed);
            compressedSizes.push(compressed.length);
            lastBlockSize = block.length;
        };

        for await (const chunk of createVoxelStream(volume, dtype)) {
            pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

            let offset = 0;
            while (pending.length - offset >= BLOCK) {
                writeBlock(pending.subarray(offset, offset + BLOCK));
                offset += BLOCK;
            }

            pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
        }

        if (pending.length > 0)
            writeBlock(pending);

        // Layout the reader expects: block count, the uncompressed size of every block but the last,
        // the true size of the last one, then each compressed size in order.
        const blockHeader = Buffer.alloc(headerBytes);
        blockHeader.writeUInt32LE(compressedSizes.length, 0);
        blockHeader.writeUInt32LE(compressedSizes.length > 1 ? BLOCK : lastBlockSize, 4);
        blockHeader.writeUInt32LE(lastBlockSize, 8);
        compressedSizes.forEach((size, i) => blockHeader.writeUInt32LE(size, 12 + i * 4));

        if (compressedSizes.length !== blockCount)
            throw new Error(`VTI block count mismatch: reserved ${blockCount}, wrote ${compressedSizes.length}`);

        fs.writeSync(outFd, blockHeader, 0, blockHeader.length, headerPosition);

        // Read it back. The reader treats a zeroed block header as "no data" and produces an empty
        // array rather than an error, so a header that failed to land is otherwise invisible until
        // something tries to open the file.
        const readBack = Buffer.alloc(4);
        fs.readSync(outFd, readBack, 0, 4, headerPosition);
        if (readBack.readUInt32LE(0) !== compressedSizes.length)
            throw new Error('VTI block header did not land at its reserved offset');
    } finally {
        fs.closeSync(outFd);
    }

    fs.appendFileSync(outputPath, xmlFooter, 'utf8');

    const compressedTotal = compressedSizes.reduce((sum, size) => sum + size, 0);
    console.log(`Successfully wrote VTI file: ${outputPath} ` +
        `(${compressedSizes.length} zlib blocks, ${compressedTotal} of ${totalBytes} bytes = ` +
        `${(100 * compressedTotal / totalBytes).toFixed(1)}%)`);
    return outputPath;
}

import fs from 'fs';

/**
 * Generate VTI file from volume temp file.
 * Streams base64 encoding in chunks — never loads the full volume into memory.
 */
export async function convertToVti(volume, outputPath) {
    console.log('Converting DICOM to VTI...');

    const { tempFilePath, dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const [sx, sy, sz] = spacing;
    const [ox, oy, oz] = origin;
    const totalBytes = rows * columns * depth * 4; // Float32 = 4 bytes

    const xmlHeader = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32">
  <ImageData WholeExtent="0 ${columns - 1} 0 ${rows - 1} 0 ${depth - 1}" Origin="${ox} ${oy} ${oz}" Spacing="${sx} ${sy} ${sz}">
    <Piece Extent="0 ${columns - 1} 0 ${rows - 1} 0 ${depth - 1}">
      <PointData Scalars="Scalars">
        <DataArray type="Float32" Name="Scalars" format="binary" NumberOfTuples="${columns * rows * depth}">
`;

    const xmlFooter = `
        </DataArray>
      </PointData>
    </Piece>
  </ImageData>
</VTKFile>`;

    fs.writeFileSync(outputPath, xmlHeader, 'utf8');

    // Stream base64 from temp file in chunks (divisible by 3 for clean base64)
    const RAW_CHUNK = 3 * 1024 * 1024; // 3 MB raw -> 4 MB base64
    const readBuf = Buffer.alloc(RAW_CHUNK);
    const srcFd = fs.openSync(tempFilePath, 'r');
    const outFd = fs.openSync(outputPath, 'a');

    try {
        // VTK XML binary: base64( UInt32_header + data )
        const lenHeader = Buffer.alloc(4);
        lenHeader.writeUInt32LE(totalBytes, 0);

        // First chunk includes the 4-byte length header
        const firstRead = Math.min(RAW_CHUNK - 4, totalBytes);
        const bytesRead = fs.readSync(srcFd, readBuf, 0, firstRead, 0);
        const firstChunk = Buffer.concat([lenHeader, readBuf.subarray(0, bytesRead)]);
        fs.writeSync(outFd, firstChunk.toString('base64'));

        let position = bytesRead;
        while (position < totalBytes) {
            const toRead = Math.min(RAW_CHUNK, totalBytes - position);
            const br = fs.readSync(srcFd, readBuf, 0, toRead, position);
            if (br === 0) break;
            fs.writeSync(outFd, readBuf.subarray(0, br).toString('base64'));
            position += br;
        }
    } finally {
        fs.closeSync(srcFd);
        fs.closeSync(outFd);
    }

    fs.appendFileSync(outputPath, xmlFooter, 'utf8');

    console.log('Successfully wrote VTI file:', outputPath);
    return outputPath;
}

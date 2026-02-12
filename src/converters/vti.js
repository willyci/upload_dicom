import fs from 'fs';

/**
 * Generate VTI file from pre-built volume data.
 * Uses chunked base64 encoding to avoid extra memory copies.
 */
export async function convertToVti(volume, outputPath) {
    console.log('Converting DICOM to VTI...');

    const { volumeData, dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const [sx, sy, sz] = spacing;
    const [ox, oy, oz] = origin;

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

    // Write XML header
    fs.writeFileSync(outputPath, xmlHeader, 'utf8');

    const fd = fs.openSync(outputPath, 'a');
    try {
        // VTK XML binary format: base64( UInt32_header(byteCount) + data )
        // Write the 4-byte length header as the start of the base64 stream
        const dataByteLength = volumeData.byteLength;
        const lenHeader = Buffer.alloc(4);
        lenHeader.writeUInt32LE(dataByteLength, 0);

        // Encode in chunks directly from the Float32Array's underlying buffer.
        // Chunk size must be divisible by 3 for clean base64 boundaries.
        const RAW_CHUNK = 3 * 1024 * 1024; // 3 MB per chunk
        const srcBuf = Buffer.from(volumeData.buffer, volumeData.byteOffset, volumeData.byteLength);

        // First chunk: prepend the 4-byte header
        const firstEnd = Math.min(RAW_CHUNK - 4, srcBuf.length);
        const firstChunk = Buffer.concat([lenHeader, srcBuf.subarray(0, firstEnd)]);
        fs.writeSync(fd, firstChunk.toString('base64'));

        // Remaining chunks read directly from srcBuf (which is a view, not a copy)
        for (let offset = firstEnd; offset < srcBuf.length; offset += RAW_CHUNK) {
            const end = Math.min(offset + RAW_CHUNK, srcBuf.length);
            const chunk = srcBuf.subarray(offset, end);
            fs.writeSync(fd, chunk.toString('base64'));
        }
    } finally {
        fs.closeSync(fd);
    }

    // Write XML footer
    fs.appendFileSync(outputPath, xmlFooter, 'utf8');

    console.log('Successfully wrote VTI file:', outputPath);
    return outputPath;
}

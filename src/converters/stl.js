import fs from 'fs';

// Marching cubes edge table: for each of 256 cube configs, which edges are intersected
const EDGE_TABLE = [
    0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
    0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
    0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
    0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
    0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
    0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
    0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
    0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
    0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
    0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,
    0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
    0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,
    0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0xaa,0x1a3,0x2a9,0x3a0,0x4ac,0x5a5,0x6af,0x7a6,
    0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x13c,0x35,0x33f,0x236,0x53a,0x433,0x739,0x630,
    0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,
    0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0
];

// Triangle table: for each of 256 cube configs, list of edge triplets forming triangles (-1 = end)
const TRI_TABLE = [
    [-1],
    [0,8,3,-1],
    [0,1,9,-1],
    [1,8,3,9,8,1,-1],
    [1,2,10,-1],
    [0,8,3,1,2,10,-1],
    [9,2,10,0,2,9,-1],
    [2,8,3,2,10,8,10,9,8,-1],
    [3,11,2,-1],
    [0,11,2,8,11,0,-1],
    [1,9,0,2,3,11,-1],
    [1,11,2,1,9,11,9,8,11,-1],
    [3,10,1,11,10,3,-1],
    [0,10,1,0,8,10,8,11,10,-1],
    [3,9,0,3,11,9,11,10,9,-1],
    [9,8,10,10,8,11,-1],
    [4,7,8,-1],
    [4,3,0,7,3,4,-1],
    [0,1,9,8,4,7,-1],
    [4,1,9,4,7,1,7,3,1,-1],
    [1,2,10,8,4,7,-1],
    [3,4,7,3,0,4,1,2,10,-1],
    [9,2,10,9,0,2,8,4,7,-1],
    [2,10,9,2,9,7,2,7,3,7,9,4,-1],
    [8,4,7,3,11,2,-1],
    [11,4,7,11,2,4,2,0,4,-1],
    [9,0,1,8,4,7,2,3,11,-1],
    [4,7,11,9,4,11,9,11,2,9,2,1,-1],
    [3,10,1,3,11,10,7,8,4,-1],
    [1,11,10,1,4,11,1,0,4,7,11,4,-1],
    [4,7,8,9,0,11,9,11,10,11,0,3,-1],
    [4,7,11,4,11,9,9,11,10,-1],
    [9,5,4,-1],
    [9,5,4,0,8,3,-1],
    [0,5,4,1,5,0,-1],
    [8,5,4,8,3,5,3,1,5,-1],
    [1,2,10,9,5,4,-1],
    [3,0,8,1,2,10,4,9,5,-1],
    [5,2,10,5,4,2,4,0,2,-1],
    [2,10,5,3,2,5,3,5,4,3,4,8,-1],
    [9,5,4,2,3,11,-1],
    [0,11,2,0,8,11,4,9,5,-1],
    [0,5,4,0,1,5,2,3,11,-1],
    [2,1,5,2,5,8,2,8,11,4,8,5,-1],
    [10,3,11,10,1,3,9,5,4,-1],
    [4,9,5,0,8,1,8,10,1,8,11,10,-1],
    [5,4,0,5,0,11,5,11,10,11,0,3,-1],
    [5,4,8,5,8,10,10,8,11,-1],
    [9,7,8,5,7,9,-1],
    [9,3,0,9,5,3,5,7,3,-1],
    [0,7,8,0,1,7,1,5,7,-1],
    [1,5,3,3,5,7,-1],
    [9,7,8,9,5,7,10,1,2,-1],
    [10,1,2,9,5,0,5,3,0,5,7,3,-1],
    [8,0,2,8,2,5,8,5,7,10,5,2,-1],
    [2,10,5,2,5,3,3,5,7,-1],
    [7,9,5,7,8,9,3,11,2,-1],
    [9,5,7,9,7,2,9,2,0,2,7,11,-1],
    [2,3,11,0,1,8,1,7,8,1,5,7,-1],
    [11,2,1,11,1,7,7,1,5,-1],
    [9,5,8,8,5,7,10,1,3,10,3,11,-1],
    [5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1],
    [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1],
    [11,10,5,7,11,5,-1],
    [10,6,5,-1],
    [0,8,3,5,10,6,-1],
    [9,0,1,5,10,6,-1],
    [1,8,3,1,9,8,5,10,6,-1],
    [1,6,5,2,6,1,-1],
    [1,6,5,1,2,6,3,0,8,-1],
    [9,6,5,9,0,6,0,2,6,-1],
    [5,9,8,5,8,2,5,2,6,3,2,8,-1],
    [2,3,11,10,6,5,-1],
    [11,0,8,11,2,0,10,6,5,-1],
    [0,1,9,2,3,11,5,10,6,-1],
    [5,10,6,1,9,2,9,11,2,9,8,11,-1],
    [6,3,11,6,5,3,5,1,3,-1],
    [0,8,11,0,11,5,0,5,1,5,11,6,-1],
    [3,11,6,0,3,6,0,6,5,0,5,9,-1],
    [6,5,9,6,9,11,11,9,8,-1],
    [5,10,6,4,7,8,-1],
    [4,3,0,4,7,3,6,5,10,-1],
    [1,9,0,5,10,6,8,4,7,-1],
    [10,6,5,1,9,7,1,7,3,7,9,4,-1],
    [6,1,2,6,5,1,4,7,8,-1],
    [1,2,5,5,2,6,3,0,4,3,4,7,-1],
    [8,4,7,9,0,5,0,6,5,0,2,6,-1],
    [7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1],
    [3,11,2,7,8,4,10,6,5,-1],
    [5,10,6,4,7,2,4,2,0,2,7,11,-1],
    [0,1,9,4,7,8,2,3,11,5,10,6,-1],
    [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1],
    [8,4,7,3,11,5,3,5,1,5,11,6,-1],
    [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1],
    [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1],
    [6,5,9,6,9,11,4,7,9,7,11,9,-1],
    [10,4,9,6,4,10,-1],
    [4,10,6,4,9,10,0,8,3,-1],
    [10,0,1,10,6,0,6,4,0,-1],
    [8,3,1,8,1,6,8,6,4,6,1,10,-1],
    [1,4,9,1,2,4,2,6,4,-1],
    [3,0,8,1,2,9,2,4,9,2,6,4,-1],
    [0,2,4,4,2,6,-1],
    [8,3,2,8,2,4,4,2,6,-1],
    [10,4,9,10,6,4,11,2,3,-1],
    [0,8,2,2,8,11,4,9,10,4,10,6,-1],
    [3,11,2,0,1,6,0,6,4,6,1,10,-1],
    [6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1],
    [9,6,4,9,3,6,9,1,3,11,6,3,-1],
    [8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1],
    [3,11,6,3,6,0,0,6,4,-1],
    [6,4,8,11,6,8,-1],
    [7,10,6,7,8,10,8,9,10,-1],
    [0,7,3,0,10,7,0,9,10,6,7,10,-1],
    [10,6,7,1,10,7,1,7,8,1,8,0,-1],
    [10,6,7,10,7,1,1,7,3,-1],
    [1,2,6,1,6,8,1,8,9,8,6,7,-1],
    [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1],
    [7,8,0,7,0,6,6,0,2,-1],
    [7,3,2,6,7,2,-1],
    [2,3,11,10,6,8,10,8,9,8,6,7,-1],
    [2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1],
    [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1],
    [11,2,1,11,1,7,10,6,1,6,7,1,-1],
    [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1],
    [0,9,1,11,6,7,-1],
    [7,8,0,7,0,6,3,11,0,11,6,0,-1],
    [7,11,6,-1],
    [7,6,11,-1],
    [3,0,8,11,7,6,-1],
    [0,1,9,11,7,6,-1],
    [8,1,9,8,3,1,11,7,6,-1],
    [10,1,2,6,11,7,-1],
    [1,2,10,3,0,8,6,11,7,-1],
    [2,9,0,2,10,9,6,11,7,-1],
    [6,11,7,2,10,3,10,8,3,10,9,8,-1],
    [7,2,3,6,2,7,-1],
    [7,0,8,7,6,0,6,2,0,-1],
    [2,7,6,2,3,7,0,1,9,-1],
    [1,6,2,1,8,6,1,9,8,8,7,6,-1],
    [10,7,6,10,1,7,1,3,7,-1],
    [10,7,6,1,7,10,1,8,7,1,0,8,-1],
    [0,3,7,0,7,10,0,10,9,6,10,7,-1],
    [7,6,10,7,10,8,8,10,9,-1],
    [6,8,4,11,8,6,-1],
    [3,6,11,3,0,6,0,4,6,-1],
    [8,6,11,8,4,6,9,0,1,-1],
    [9,4,6,9,6,3,9,3,1,11,3,6,-1],
    [6,8,4,6,11,8,2,10,1,-1],
    [1,2,10,3,0,11,0,6,11,0,4,6,-1],
    [4,11,8,4,6,11,0,2,9,2,10,9,-1],
    [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1],
    [8,2,3,8,4,2,4,6,2,-1],
    [0,4,2,4,6,2,-1],
    [1,9,0,2,3,4,2,4,6,4,3,8,-1],
    [1,9,4,1,4,2,2,4,6,-1],
    [8,1,3,8,6,1,8,4,6,6,10,1,-1],
    [10,1,0,10,0,6,6,0,4,-1],
    [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1],
    [10,9,4,6,10,4,-1],
    [4,9,5,7,6,11,-1],
    [0,8,3,4,9,5,11,7,6,-1],
    [5,0,1,5,4,0,7,6,11,-1],
    [11,7,6,8,3,4,3,5,4,3,1,5,-1],
    [9,5,4,10,1,2,7,6,11,-1],
    [6,11,7,1,2,10,0,8,3,4,9,5,-1],
    [7,6,11,5,4,10,4,2,10,4,0,2,-1],
    [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1],
    [7,2,3,7,6,2,5,4,9,-1],
    [9,5,4,0,8,6,0,6,2,6,8,7,-1],
    [3,6,2,3,7,6,1,5,0,5,4,0,-1],
    [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1],
    [9,5,4,10,1,6,1,7,6,1,3,7,-1],
    [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1],
    [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1],
    [7,6,10,7,10,8,5,4,10,4,8,10,-1],
    [6,9,5,6,11,9,11,8,9,-1],
    [3,6,11,0,6,3,0,5,6,0,9,5,-1],
    [0,11,8,0,5,11,0,1,5,5,6,11,-1],
    [6,11,3,6,3,5,5,3,1,-1],
    [1,2,10,9,5,11,9,11,8,11,5,6,-1],
    [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1],
    [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1],
    [6,11,3,6,3,5,2,10,3,10,5,3,-1],
    [5,8,9,5,2,8,5,6,2,3,8,2,-1],
    [9,5,6,9,6,0,0,6,2,-1],
    [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1],
    [1,5,6,2,1,6,-1],
    [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1],
    [10,1,0,10,0,6,9,5,0,5,6,0,-1],
    [0,3,8,5,6,10,-1],
    [10,5,6,-1],
    [11,5,10,7,5,11,-1],
    [11,5,10,11,7,5,8,3,0,-1],
    [5,11,7,5,10,11,1,9,0,-1],
    [10,7,5,10,11,7,9,8,1,8,3,1,-1],
    [11,1,2,11,7,1,7,5,1,-1],
    [0,8,3,1,2,7,1,7,5,7,2,11,-1],
    [9,7,5,9,2,7,9,0,2,2,11,7,-1],
    [7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1],
    [2,5,10,2,3,5,3,7,5,-1],
    [8,2,0,8,5,2,8,7,5,10,2,5,-1],
    [9,0,1,5,10,3,5,3,7,3,10,2,-1],
    [9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1],
    [1,3,5,3,7,5,-1],
    [0,8,7,0,7,1,1,7,5,-1],
    [9,0,3,9,3,5,5,3,7,-1],
    [9,8,7,5,9,7,-1],
    [5,8,4,5,10,8,10,11,8,-1],
    [5,0,4,5,11,0,5,10,11,11,3,0,-1],
    [0,1,9,8,4,10,8,10,11,10,4,5,-1],
    [10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1],
    [2,5,1,2,8,5,2,11,8,4,5,8,-1],
    [0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1],
    [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1],
    [9,4,5,2,11,3,-1],
    [2,5,10,3,5,2,3,4,5,3,8,4,-1],
    [5,10,2,5,2,4,4,2,0,-1],
    [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1],
    [5,10,2,5,2,4,1,9,2,9,4,2,-1],
    [8,4,5,8,5,3,3,5,1,-1],
    [0,4,5,1,0,5,-1],
    [8,4,5,8,5,3,9,0,5,0,3,5,-1],
    [9,4,5,-1],
    [4,11,7,4,9,11,9,10,11,-1],
    [0,8,3,4,9,7,9,11,7,9,10,11,-1],
    [1,10,11,1,11,4,1,4,0,7,4,11,-1],
    [3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1],
    [4,11,7,9,11,4,9,2,11,9,1,2,-1],
    [9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1],
    [11,7,4,11,4,2,2,4,0,-1],
    [11,7,4,11,4,2,8,3,4,3,2,4,-1],
    [2,9,10,2,7,9,2,3,7,7,4,9,-1],
    [9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1],
    [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1],
    [1,10,2,8,7,4,-1],
    [4,9,1,4,1,7,7,1,3,-1],
    [4,9,1,4,1,7,0,8,1,8,7,1,-1],
    [4,0,3,7,4,3,-1],
    [4,8,7,-1],
    [9,10,8,10,11,8,-1],
    [3,0,9,3,9,11,11,9,10,-1],
    [0,1,10,0,10,8,8,10,11,-1],
    [3,1,10,11,3,10,-1],
    [1,2,11,1,11,9,9,11,8,-1],
    [3,0,9,3,9,11,1,2,9,2,11,9,-1],
    [0,2,11,8,0,11,-1],
    [3,2,11,-1],
    [2,3,8,2,8,10,10,8,9,-1],
    [9,10,2,0,9,2,-1],
    [2,3,8,2,8,10,0,1,8,1,10,8,-1],
    [1,10,2,-1],
    [1,3,8,9,1,8,-1],
    [0,9,1,-1],
    [0,3,8,-1],
    [-1]
];

/**
 * Read one slice from the volume temp file into a Float32Array.
 */
function loadSlice(srcFd, readBuf, z, target, sliceSize) {
    const sliceBytes = sliceSize * 4;
    fs.readSync(srcFd, readBuf, 0, sliceBytes, z * sliceBytes);
    const view = new Float32Array(readBuf.buffer, readBuf.byteOffset, sliceSize);
    target.set(view);
}

/**
 * One half-resolution slice: full slices 2Z and 2Z+1, averaged over each 2x2x2 block of voxels.
 *
 * Averaging rather than sampling, so this is a genuine low-pass rather than a decimation that
 * aliases thin structures in and out. Thin cortical bone survives: one bone voxel at ~1500 HU among
 * seven of soft tissue still averages well above the 200 HU threshold.
 */
function loadHalfSlice(srcFd, readBuf, halfZ, target, full, halfWidth, halfHeight, scratchA, scratchB) {
    const { nx, ny, nz, sliceSize } = full;

    loadSlice(srcFd, readBuf, Math.min(2 * halfZ, nz - 1), scratchA, sliceSize);
    loadSlice(srcFd, readBuf, Math.min(2 * halfZ + 1, nz - 1), scratchB, sliceSize);

    for (let y = 0; y < halfHeight; y++) {
        const y0 = 2 * y;
        const y1 = Math.min(y0 + 1, ny - 1);
        const rowA0 = y0 * nx;
        const rowA1 = y1 * nx;
        const out = y * halfWidth;

        for (let x = 0; x < halfWidth; x++) {
            const x0 = 2 * x;
            const x1 = Math.min(x0 + 1, nx - 1);

            target[out + x] = (
                scratchA[rowA0 + x0] + scratchA[rowA0 + x1] +
                scratchA[rowA1 + x0] + scratchA[rowA1 + x1] +
                scratchB[rowA0 + x0] + scratchB[rowA0 + x1] +
                scratchB[rowA1 + x0] + scratchB[rowA1 + x1]
            ) * 0.125;
        }
    }
}

/**
 * Iso-surface threshold.
 *
 * The min/max come from volume.stats, gathered while the temp file was being written - this used to
 * re-read the whole volume to recompute them, then for CT return the constant on the next line. The
 * mean pass below only runs for data that is not in Hounsfield units.
 */
function selectThreshold(volume, sliceSize, numSlices) {
    const { min, max } = volume.stats;

    // Hounsfield units: bone.
    if (min < -500 && max > 500)
        return 200;

    const sliceBytes = sliceSize * 4;
    const readBuf = Buffer.alloc(sliceBytes);
    const srcFd = fs.openSync(volume.tempFilePath, 'r');

    try {
        let sum = 0, cnt = 0;
        const bgThreshold = min + (max - min) * 0.05;

        for (let s = 0; s < numSlices; s++) {
            const bytesRead = fs.readSync(srcFd, readBuf, 0, sliceBytes, s * sliceBytes);
            const count = bytesRead / 4;
            const view = new Float32Array(readBuf.buffer, readBuf.byteOffset, count);
            for (let i = 0; i < count; i++) {
                if (view[i] > bgThreshold) {
                    sum += view[i];
                    cnt++;
                }
            }
        }

        const mean = cnt > 0 ? sum / cnt : (max + min) / 2;
        return mean + (max - mean) * 0.3;
    } finally {
        fs.closeSync(srcFd);
    }
}

// One binary STL triangle is 50 bytes; batch them so the output is ~20,000 writes instead of one
// syscall per triangle.
const TRIANGLES_PER_FLUSH = 20000;

/**
 * Slice-based marching cubes over a half-resolution volume: two half-slices in memory at a time.
 *
 * Half resolution is the reason this is fast. At full resolution a 512x512x127 volume is 32.9 M
 * cubes, the overwhelming majority of them entirely inside or outside the surface and discarded
 * immediately; halving each axis leaves an eighth of that, and an eighth of the triangles.
 *
 * The inner loop allocates nothing. It used to build a fresh 8-element array per cube - 32.9 M of
 * them per run, nearly all thrown away one line later - plus nine more arrays per non-empty cube and
 * three per triangle. That was the dominant source of GC pressure in the whole pipeline.
 */
function marchingCubesStreaming(srcFd, full, spacing, origin, threshold, outFd) {
    // Half-resolution grid. Spacing doubles to keep the mesh in the same physical space.
    const nx = Math.max(2, full.nx >> 1);
    const ny = Math.max(2, full.ny >> 1);
    const nz = Math.max(2, full.nz >> 1);
    const sx = spacing[0] * 2, sy = spacing[1] * 2, sz = spacing[2] * 2;
    const [ox, oy, oz] = origin;

    const readBuf = Buffer.alloc(full.sliceSize * 4);
    const scratchA = new Float32Array(full.sliceSize);
    const scratchB = new Float32Array(full.sliceSize);

    const halfSize = nx * ny;
    let currentSlice = new Float32Array(halfSize);
    let nextSlice = new Float32Array(halfSize);

    // Preallocated working state, reused for every cube.
    const edgeVerts = new Float32Array(36);   // 12 edges x 3 coordinates
    const edgeSet = new Uint8Array(12);
    const outBuf = Buffer.alloc(TRIANGLES_PER_FLUSH * 50);
    let outOffset = 0;
    let triangleCount = 0;

    const flush = () => {
        if (outOffset > 0) {
            fs.writeSync(outFd, outBuf, 0, outOffset);
            outOffset = 0;
        }
    };

    // Writes the crossing point on edge `e` between two corners into edgeVerts.
    const interp = (e, ax, ay, az, bx, by, bz, va, vb) => {
        let mu;
        if (Math.abs(threshold - va) < 0.00001) mu = 0;
        else if (Math.abs(threshold - vb) < 0.00001) mu = 1;
        else if (Math.abs(va - vb) < 0.00001) mu = 0;
        else mu = (threshold - va) / (vb - va);

        const o = e * 3;
        edgeVerts[o] = ax + mu * (bx - ax);
        edgeVerts[o + 1] = ay + mu * (by - ay);
        edgeVerts[o + 2] = az + mu * (bz - az);
        edgeSet[e] = 1;
    };

    loadHalfSlice(srcFd, readBuf, 0, currentSlice, full, nx, ny, scratchA, scratchB);

    for (let z = 0; z < nz - 1; z++) {
        loadHalfSlice(srcFd, readBuf, z + 1, nextSlice, full, nx, ny, scratchA, scratchB);

        const z0 = oz + z * sz;
        const z1 = oz + (z + 1) * sz;

        for (let y = 0; y < ny - 1; y++) {
            const row = y * nx;
            const rowNext = (y + 1) * nx;
            const y0 = oy + y * sy;
            const y1 = oy + (y + 1) * sy;

            for (let x = 0; x < nx - 1; x++) {
                const v0 = currentSlice[row + x];
                const v1 = currentSlice[row + x + 1];
                const v2 = currentSlice[rowNext + x + 1];
                const v3 = currentSlice[rowNext + x];
                const v4 = nextSlice[row + x];
                const v5 = nextSlice[row + x + 1];
                const v6 = nextSlice[rowNext + x + 1];
                const v7 = nextSlice[rowNext + x];

                let cubeIndex = 0;
                if (v0 >= threshold) cubeIndex |= 1;
                if (v1 >= threshold) cubeIndex |= 2;
                if (v2 >= threshold) cubeIndex |= 4;
                if (v3 >= threshold) cubeIndex |= 8;
                if (v4 >= threshold) cubeIndex |= 16;
                if (v5 >= threshold) cubeIndex |= 32;
                if (v6 >= threshold) cubeIndex |= 64;
                if (v7 >= threshold) cubeIndex |= 128;

                const edges = EDGE_TABLE[cubeIndex];
                if (edges === 0) continue;

                const x0 = ox + x * sx;
                const x1 = ox + (x + 1) * sx;

                edgeSet.fill(0);
                if (edges & 1)    interp(0,  x0, y0, z0, x1, y0, z0, v0, v1);
                if (edges & 2)    interp(1,  x1, y0, z0, x1, y1, z0, v1, v2);
                if (edges & 4)    interp(2,  x1, y1, z0, x0, y1, z0, v2, v3);
                if (edges & 8)    interp(3,  x0, y1, z0, x0, y0, z0, v3, v0);
                if (edges & 16)   interp(4,  x0, y0, z1, x1, y0, z1, v4, v5);
                if (edges & 32)   interp(5,  x1, y0, z1, x1, y1, z1, v5, v6);
                if (edges & 64)   interp(6,  x1, y1, z1, x0, y1, z1, v6, v7);
                if (edges & 128)  interp(7,  x0, y1, z1, x0, y0, z1, v7, v4);
                if (edges & 256)  interp(8,  x0, y0, z0, x0, y0, z1, v0, v4);
                if (edges & 512)  interp(9,  x1, y0, z0, x1, y0, z1, v1, v5);
                if (edges & 1024) interp(10, x1, y1, z0, x1, y1, z1, v2, v6);
                if (edges & 2048) interp(11, x0, y1, z0, x0, y1, z1, v3, v7);

                const triList = TRI_TABLE[cubeIndex];
                for (let i = 0; triList[i] !== -1; i += 3) {
                    const ea = triList[i], eb = triList[i + 1], ec = triList[i + 2];
                    if (!edgeSet[ea] || !edgeSet[eb] || !edgeSet[ec]) continue;

                    const ax = edgeVerts[ea * 3], ay = edgeVerts[ea * 3 + 1], az = edgeVerts[ea * 3 + 2];
                    const bx = edgeVerts[eb * 3], by = edgeVerts[eb * 3 + 1], bz = edgeVerts[eb * 3 + 2];
                    const cx = edgeVerts[ec * 3], cy = edgeVerts[ec * 3 + 1], cz = edgeVerts[ec * 3 + 2];

                    // Face normal, inline so nothing is allocated per triangle.
                    const ux = bx - ax, uy = by - ay, uz = bz - az;
                    const wx = cx - ax, wy = cy - ay, wz = cz - az;
                    let nxx = uy * wz - uz * wy;
                    let nyy = uz * wx - ux * wz;
                    let nzz = ux * wy - uy * wx;
                    const len = Math.sqrt(nxx * nxx + nyy * nyy + nzz * nzz);
                    if (len > 0) { nxx /= len; nyy /= len; nzz /= len; }

                    let off = outOffset;
                    outBuf.writeFloatLE(nxx, off); off += 4;
                    outBuf.writeFloatLE(nyy, off); off += 4;
                    outBuf.writeFloatLE(nzz, off); off += 4;
                    outBuf.writeFloatLE(ax, off); off += 4;
                    outBuf.writeFloatLE(ay, off); off += 4;
                    outBuf.writeFloatLE(az, off); off += 4;
                    outBuf.writeFloatLE(bx, off); off += 4;
                    outBuf.writeFloatLE(by, off); off += 4;
                    outBuf.writeFloatLE(bz, off); off += 4;
                    outBuf.writeFloatLE(cx, off); off += 4;
                    outBuf.writeFloatLE(cy, off); off += 4;
                    outBuf.writeFloatLE(cz, off); off += 4;
                    outBuf.writeUInt16LE(0, off); off += 2;
                    outOffset = off;

                    triangleCount++;
                    if (outOffset + 50 > outBuf.length) flush();
                }
            }
        }

        const swap = currentSlice;
        currentSlice = nextSlice;
        nextSlice = swap;
    }

    flush();
    return { triangleCount, dims: [nx, ny, nz], spacing: [sx, sy, sz] };
}

export async function convertToStl(volume, outputPath) {
    console.log('Converting DICOM to STL via marching cubes...');

    const { tempFilePath, dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const sliceSize = rows * columns;

    const threshold = selectThreshold(volume, sliceSize, depth);
    console.log(`Using threshold: ${threshold.toFixed(1)} ` +
        `(values ${volume.stats.min}..${volume.stats.max})`);

    // Open output file: write 80-byte header + 4-byte placeholder count
    const outFd = fs.openSync(outputPath, 'w');
    const headerBuf = Buffer.alloc(84);
    headerBuf.write('Binary STL generated by dicom-processor', 0, 80, 'ascii');
    fs.writeSync(outFd, headerBuf);

    // Open volume temp file for slice-based reading
    const srcFd = fs.openSync(tempFilePath, 'r');

    let triangleCount;
    try {
        const result = marchingCubesStreaming(
            srcFd,
            { nx: columns, ny: rows, nz: depth, sliceSize },
            spacing,
            origin,
            threshold,
            outFd
        );
        triangleCount = result.triangleCount;
        console.log(`Isosurface grid ${result.dims.join('x')} at spacing ` +
            `${result.spacing.map(s => s.toFixed(3)).join(', ')} mm (half resolution)`);
    } finally {
        fs.closeSync(srcFd);
    }

    // Write actual triangle count at byte offset 80
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(triangleCount, 0);
    fs.writeSync(outFd, countBuf, 0, 4, 80);

    fs.closeSync(outFd);

    console.log(`Generated ${triangleCount} triangles`);

    if (triangleCount === 0) {
        try { fs.unlinkSync(outputPath); } catch {}
        throw new Error('No surface generated - all voxels are on one side of the threshold');
    }

    console.log('Successfully wrote STL file:', outputPath);
    return outputPath;
}

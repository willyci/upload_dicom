import fs from 'fs';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createVoxelStream, resolveOutputDtype, describeDtype, BYTES_PER_VOXEL } from '../utils/volumeStream.js';

const DT_FLOAT32 = 16;
const DT_INT16 = 4;

export async function convertToNifti(volume, outputPath) {
    console.log('Converting DICOM to NIfTI...');

    const { dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;

    const dtype = resolveOutputDtype(volume);
    console.log('NIfTI data type:', describeDtype(volume, dtype));

    // Create NIfTI-1 header (348 bytes)
    const header = Buffer.alloc(348);

    header.writeInt32LE(348, 0);
    header.write('', 4, 10, 'ascii');
    header.write('', 14, 18, 'ascii');
    header.writeInt32LE(0, 32);
    header.writeInt16LE(0, 36);
    header.write('r', 38, 1, 'ascii');
    header.writeUInt8(0, 39);

    // dim[8]
    header.writeInt16LE(3, 40);
    header.writeInt16LE(columns, 42);
    header.writeInt16LE(rows, 44);
    header.writeInt16LE(depth, 46);
    header.writeInt16LE(1, 48);
    header.writeInt16LE(1, 50);
    header.writeInt16LE(1, 52);
    header.writeInt16LE(1, 54);

    header.writeFloatLE(0, 56);
    header.writeFloatLE(0, 60);
    header.writeFloatLE(0, 64);
    header.writeInt16LE(0, 68);
    header.writeInt16LE(dtype === 'int16' ? DT_INT16 : DT_FLOAT32, 70);
    header.writeInt16LE(BYTES_PER_VOXEL[dtype] * 8, 72);   // bitpix
    header.writeInt16LE(0, 74);

    // pixdim[8]
    header.writeFloatLE(1.0, 76);
    header.writeFloatLE(spacing[0], 80);
    header.writeFloatLE(spacing[1], 84);
    header.writeFloatLE(spacing[2], 88);
    header.writeFloatLE(1.0, 92);
    header.writeFloatLE(0, 96);
    header.writeFloatLE(0, 100);
    header.writeFloatLE(0, 104);

    header.writeFloatLE(352, 108); // vox_offset - into the decompressed stream, so gzip does not change it

    // Identity scaling on purpose: the voxels already carry rescaled units (Hounsfield for CT), and
    // the Unity viewer's NIfTI reader parses scl_slope/scl_inter but never applies them. Expressing
    // the rescale here instead of in the data would silently mis-window everything in the headset.
    header.writeFloatLE(1.0, 112); // scl_slope
    header.writeFloatLE(0.0, 116); // scl_inter
    header.writeInt16LE(0, 120);
    header.writeUInt8(0, 122);
    header.writeUInt8(2, 123); // xyzt_units = mm
    header.writeFloatLE(0, 124);
    header.writeFloatLE(0, 128);
    header.writeFloatLE(0, 132);
    header.writeFloatLE(0, 136);
    header.writeInt32LE(0, 140);
    header.writeInt32LE(0, 144);

    header.write('DICOM to NIfTI conversion', 148, 80, 'ascii');
    header.write('', 228, 24, 'ascii');

    header.writeInt16LE(1, 252); // qform_code
    header.writeInt16LE(1, 254); // sform_code

    // quaternion
    header.writeFloatLE(0, 256);
    header.writeFloatLE(0, 260);
    header.writeFloatLE(0, 264);

    // qoffset (origin)
    header.writeFloatLE(origin[0], 268);
    header.writeFloatLE(origin[1], 272);
    header.writeFloatLE(origin[2], 276);

    // srow_x
    header.writeFloatLE(spacing[0], 280);
    header.writeFloatLE(0, 284);
    header.writeFloatLE(0, 288);
    header.writeFloatLE(origin[0], 292);

    // srow_y
    header.writeFloatLE(0, 296);
    header.writeFloatLE(spacing[1], 300);
    header.writeFloatLE(0, 304);
    header.writeFloatLE(origin[1], 308);

    // srow_z
    header.writeFloatLE(0, 312);
    header.writeFloatLE(0, 316);
    header.writeFloatLE(spacing[2], 320);
    header.writeFloatLE(origin[2], 324);

    header.write('', 328, 16, 'ascii');
    header.write('n+1\0', 344, 4, 'ascii'); // magic

    // Unlike NRRD, a gzipped NIfTI compresses the WHOLE file - header, extension and voxels all go
    // through one gzip stream, which is what every NIfTI reader expects from a .nii.gz.
    const gzip = zlib.createGzip({ level: 6 });
    const written = pipeline(gzip, fs.createWriteStream(outputPath));

    gzip.write(header);
    gzip.write(Buffer.alloc(4, 0));   // 4-byte extension, all zeros

    await pipeline(createVoxelStream(volume, dtype), gzip);
    await written;

    console.log('Successfully wrote NIfTI file:', outputPath);
    return outputPath;
}

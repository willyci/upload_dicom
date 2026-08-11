// Prove the narrowed/compressed outputs are lossless against a float32 baseline.
//
//   node scripts/compare-volumes.mjs <baseline dir> <new dir>
//
// Reads the voxels back out of every format, compares each against the baseline elementwise, and
// also compares the new outputs against each other - which catches a per-writer stride bug that a
// single comparison would miss.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// vtk.js's appended-data branch touches this DOM global; it is otherwise happy headless.
globalThis.Node ??= { ELEMENT_NODE: 1 };
const { default: vtkXMLImageDataReader } = await import('@kitware/vtk.js/IO/XML/XMLImageDataReader.js');

const [baseDir, newDir] = process.argv.slice(2);
if (!baseDir || !newDir) {
    console.error('usage: node scripts/compare-volumes.mjs <baseline dir> <new dir>');
    process.exit(1);
}

let failures = 0;
const check = (ok, message) => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${message}`);
    if (!ok) failures++;
};

function gunzipIfNeeded(buf) {
    return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
}

/** NIfTI, .nii or .nii.gz. Asserts the header fields and returns the voxels. */
function readNifti(file) {
    const buf = gunzipIfNeeded(fs.readFileSync(file));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const sizeofHdr = view.getInt32(0, true);
    const datatype = view.getInt16(70, true);
    const bitpix = view.getInt16(72, true);
    const voxOffset = Math.floor(view.getFloat32(108, true));
    const dims = [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)];
    const count = dims[0] * dims[1] * dims[2];

    check(sizeofHdr === 348, `${path.basename(file)}: sizeof_hdr 348`);
    check(voxOffset === 352, `${path.basename(file)}: vox_offset 352`);
    check(bitpix === (datatype === 4 ? 16 : 32), `${path.basename(file)}: datatype ${datatype} matches bitpix ${bitpix}`);
    check(view.getFloat32(112, true) === 1 && view.getFloat32(116, true) === 0,
        `${path.basename(file)}: scl_slope 1 / scl_inter 0 (values are raw HU)`);

    const bytes = buf.buffer.slice(buf.byteOffset + voxOffset, buf.byteOffset + voxOffset + count * bitpix / 8);
    return datatype === 4 ? new Int16Array(bytes) : new Float32Array(bytes);
}

/** NRRD, raw or gzip encoded. */
function readNrrd(file) {
    const buf = fs.readFileSync(file);
    const split = buf.indexOf('\n\n');
    const header = buf.subarray(0, split).toString('latin1');
    const field = name => (header.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];

    const type = field('type');
    const encoding = field('encoding');
    check(['short', 'float'].includes(type), `${path.basename(file)}: type ${type}`);
    check(['raw', 'gzip'].includes(encoding), `${path.basename(file)}: encoding ${encoding}`);

    let data = buf.subarray(split + 2);
    if (encoding === 'gzip') data = zlib.gunzipSync(data);

    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return type === 'short' ? new Int16Array(bytes) : new Float32Array(bytes);
}

/** Legacy VTK, little-endian as this project writes it. */
function readVtk(file) {
    const buf = fs.readFileSync(file);
    const marker = buf.indexOf('LOOKUP_TABLE default\n');
    const header = buf.subarray(0, marker).toString('latin1');
    const scalarType = (header.match(/^SCALARS \w+ (\w+)$/m) || [])[1];
    check(['short', 'float'].includes(scalarType), `${path.basename(file)}: SCALARS ${scalarType}`);

    const data = buf.subarray(marker + 'LOOKUP_TABLE default\n'.length);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return scalarType === 'short' ? new Int16Array(bytes) : new Float32Array(bytes);
}

/** VTI, through the same vtk.js reader the browser uses. */
function readVti(file) {
    const buf = fs.readFileSync(file);
    const reader = vtkXMLImageDataReader.newInstance();
    reader.parseAsArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    const image = reader.getOutputData();
    const scalars = image.getPointData().getScalars().getData();
    check(!!image, `${path.basename(file)}: parsed by vtk.js`);
    console.log(`        dims ${image.getDimensions()} spacing ${image.getSpacing().map(v => +v.toFixed(4))} ` +
        `origin ${image.getOrigin()} -> ${scalars.constructor.name}`);
    return scalars;
}

function compare(label, a, b) {
    if (a.length !== b.length) {
        check(false, `${label}: length ${a.length} vs ${b.length}`);
        return;
    }

    let mismatches = 0;
    let firstAt = -1;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            if (firstAt < 0) firstAt = i;
            mismatches++;
        }
    }

    check(mismatches === 0, `${label}: ${a.length.toLocaleString()} voxels, ${mismatches} mismatches` +
        (mismatches ? ` (first at ${firstAt}: ${a[firstAt]} vs ${b[firstAt]})` : ''));
}

const pick = (dir, ...names) => names.map(n => path.join(dir, n)).find(fs.existsSync);

console.log(`baseline: ${baseDir}`);
const baseline = readNifti(pick(baseDir, 'volume.nii.gz', 'volume.nii'));
const range = baseline.reduce((acc, v) => [Math.min(acc[0], v), Math.max(acc[1], v)], [Infinity, -Infinity]);
console.log(`  ${baseline.length.toLocaleString()} voxels, ${baseline.constructor.name}, range ${range[0]}..${range[1]}\n`);

console.log(`new: ${newDir}`);
const outputs = {
    nifti: readNifti(pick(newDir, 'volume.nii.gz', 'volume.nii')),
    nrrd: readNrrd(path.join(newDir, 'volume.nrrd')),
    vtk: readVtk(path.join(newDir, 'volume.vtk')),
    vti: readVti(path.join(newDir, 'volume.vti')),
};

console.log('\nagainst the float32 baseline:');
for (const [name, data] of Object.entries(outputs))
    compare(name.padEnd(6), baseline, data);

console.log('\nagainst each other:');
const names = Object.keys(outputs);
for (let i = 1; i < names.length; i++)
    compare(`${names[0]} vs ${names[i]}`, outputs[names[0]], outputs[names[i]]);

console.log(failures === 0 ? '\nPASS - every output is bit-identical to the float32 baseline'
    : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

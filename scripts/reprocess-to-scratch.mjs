// Reprocess one existing upload's DICOM files into a scratch directory and report output sizes.
//
// Used to capture a before/after baseline when changing the converters:
//   node scripts/reprocess-to-scratch.mjs public/uploads/1775542368117_d10 /tmp/before
//
// Copies only the .dcm files, so the scratch run produces everything from scratch rather than
// picking up the previous run's outputs.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { processDirectory } from '../src/services/processor.js';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
    console.error('usage: node scripts/reprocess-to-scratch.mjs <source folder> <scratch dir>');
    process.exit(1);
}

function findDcm(dir) {
    const results = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) results.push(...findDcm(full));
        else if (item.name.toLowerCase().endsWith('.dcm')) results.push(full);
    }
    return results;
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const slices = findDcm(src);
for (const file of slices) {
    fs.copyFileSync(file, path.join(out, path.basename(file)));
}
console.log(`copied ${slices.length} .dcm files into ${out}`);

// The trailing slash matters: routes/uploads.js passes one and the converters rely on it.
const { errors } = await processDirectory(out + '/');
if (errors?.length) console.log('errors:', JSON.stringify(errors));

const info = JSON.parse(fs.readFileSync(path.join(out, 'mpr', 'mpr_info.json'), 'utf8'));
const voxels = info.axial.width * info.axial.height * info.axial.count;
console.log(`\nvoxels: ${voxels.toLocaleString()} (${info.axial.width}x${info.axial.height}x${info.axial.count})`);

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

let total = 0;
for (const name of ['volume.vti', 'volume.nrrd', 'volume.nii', 'volume.nii.gz', 'volume.vtk', 'model.stl']) {
    const file = path.join(out, name);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    total += size;
    console.log(`${name.padEnd(14)} ${size.toString().padStart(12)}  ${(size / voxels).toFixed(3)} B/vox  sha ${sha(file)}`);
}

// One hash over every MPR image, so a change anywhere in the stack shows up as one line.
const mprFiles = [];
(function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.name.endsWith('.jpg')) mprFiles.push(full);
    }
})(path.join(out, 'mpr'));

mprFiles.sort();
const mprHash = crypto.createHash('sha256');
let mprBytes = 0;
for (const file of mprFiles) {
    mprHash.update(fs.readFileSync(file));
    mprBytes += fs.statSync(file).size;
}
console.log(`${'mpr/'.padEnd(14)} ${mprBytes.toString().padStart(12)}  ${(mprBytes / voxels).toFixed(3)} B/vox  ` +
    `${mprFiles.length} jpgs  sha ${mprHash.digest('hex').slice(0, 16)}`);

console.log(`\nvolume files total: ${total.toLocaleString()} bytes = ${(total / voxels).toFixed(3)} B/voxel`);

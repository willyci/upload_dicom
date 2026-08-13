// For a folder whose slices share positions, work out what the duplicates actually are: the same
// image twice, or two different reconstructions of the same location.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dicomParser from 'dicom-parser';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.dcm')).sort();

const byPosition = new Map();

for (const f of files) {
    const bytes = fs.readFileSync(path.join(dir, f));
    const ds = dicomParser.parseDicom(bytes);
    const ipp = ds.string('x00200032') || '';
    const pixels = ds.elements.x7fe00010;

    const record = {
        f,
        instance: ds.string('x00200013'),
        kernel: ds.string('x00181210'),
        imageType: ds.string('x00080008'),
        seriesDesc: ds.string('x0008103e'),
        acquisition: ds.string('x00200012'),
        windowCenter: ds.string('x00281050'),
        // Hash of the pixel data only, so identical images are obvious.
        pixelHash: pixels
            ? crypto.createHash('sha256')
                .update(bytes.subarray(pixels.dataOffset, pixels.dataOffset + pixels.length))
                .digest('hex').slice(0, 12)
            : '(none)',
    };

    if (!byPosition.has(ipp)) byPosition.set(ipp, []);
    byPosition.get(ipp).push(record);
}

const groups = [...byPosition.values()];
const dupes = groups.filter(g => g.length > 1);

console.log(`${files.length} files at ${groups.length} distinct positions`);
console.log(`positions with more than one slice: ${dupes.length}`);
console.log(`group sizes: ${[...new Set(groups.map(g => g.length))].sort().join(', ')}\n`);

for (const group of dupes.slice(0, 3)) {
    console.log('position shared by:');
    for (const r of group)
        console.log(`   ${r.f}  instance=${r.instance}  acq=${r.acquisition}  kernel=${r.kernel}  ` +
            `type=${r.imageType}  pixels=${r.pixelHash}`);
    const hashes = new Set(group.map(r => r.pixelHash));
    console.log(`   -> pixel data ${hashes.size === 1 ? 'IDENTICAL' : 'DIFFERENT (' + hashes.size + ' variants)'}\n`);
}

const identical = dupes.filter(g => new Set(g.map(r => r.pixelHash)).size === 1).length;
console.log(`of ${dupes.length} duplicated positions, ${identical} hold byte-identical pixel data`);
console.log(`series descriptions: ${[...new Set(groups.flat().map(r => r.seriesDesc))].join(' | ')}`);
console.log(`image types: ${[...new Set(groups.flat().map(r => r.imageType))].join(' | ')}`);

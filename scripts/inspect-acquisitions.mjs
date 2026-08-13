// Break a folder down by AcquisitionNumber, so overlapping acquisitions inside one series are visible.
import fs from 'fs';
import path from 'path';
import dicomParser from 'dicom-parser';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.dcm')).sort();
const groups = new Map();

for (const f of files) {
    const ds = dicomParser.parseDicom(fs.readFileSync(path.join(dir, f)));
    const z = Number((ds.string('x00200032') || '').split('\\')[2]);
    const acq = ds.string('x00200012') || '(none)';
    if (!groups.has(acq)) groups.set(acq, []);
    groups.get(acq).push(z);
}

for (const [acq, zs] of [...groups].sort()) {
    zs.sort((a, b) => a - b);
    const gaps = zs.slice(1).map((z, i) => +(z - zs[i]).toFixed(3));
    const counts = gaps.reduce((acc, g) => (acc[g] = (acc[g] || 0) + 1, acc), {});
    const duplicates = gaps.filter(g => g === 0).length;

    console.log(`acquisition ${acq}: ${zs.length} slices`);
    console.log(`   z ${zs[0]} .. ${zs[zs.length - 1]}  (span ${(zs[zs.length - 1] - zs[0]).toFixed(1)} mm)`);
    console.log(`   gaps: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v, c]) => v + 'mm x' + c).join('  ')}`);
    console.log(`   duplicate positions within this acquisition: ${duplicates}`);
    console.log(`   implied extent if stacked: ${(zs.length * 2.5).toFixed(1)} mm\n`);
}

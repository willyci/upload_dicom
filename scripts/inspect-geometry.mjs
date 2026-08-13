// Read the real slice geometry out of a DICOM folder: spacing tags and the actual gaps between
// consecutive ImagePositionPatient values.
import fs from 'fs';
import path from 'path';
import dicomParser from 'dicom-parser';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.dcm')).sort();

const slices = [];
for (const f of files) {
    const ds = dicomParser.parseDicom(fs.readFileSync(path.join(dir, f)));
    const ipp = (ds.string('x00200032') || '').split('\\').map(Number);
    const iop = ds.string('x00200037') || '';
    slices.push({
        f,
        pos: ipp,
        thickness: ds.string('x00180050'),
        between: ds.string('x00180088'),
        pixelSpacing: ds.string('x00280030'),
        orientation: iop,
        rows: ds.uint16('x00280010'),
        cols: ds.uint16('x00280011'),
        series: ds.string('x0020000e'),
    });
}

const distinct = key => [...new Set(slices.map(s => s[key]))];

console.log(`files: ${slices.length}`);
console.log('SliceThickness      :', distinct('thickness').join(', '));
console.log('SpacingBetweenSlices:', distinct('between').join(', ') || '(absent)');
console.log('PixelSpacing        :', distinct('pixelSpacing').join(', '));
console.log('Rows x Columns      :', distinct('rows').join(',') + ' x ' + distinct('cols').join(','));
console.log('series UIDs         :', distinct('series').length);
console.log('ImageOrientation    :', distinct('orientation').join(' | '));

// Sorted the way volumeBuilder sorts: ascending ImagePositionPatient z.
slices.sort((a, b) => a.pos[2] - b.pos[2]);
const first = slices[0].pos, last = slices[slices.length - 1].pos;
console.log(`\nz range: ${first[2]} .. ${last[2]}  (span ${(last[2] - first[2]).toFixed(3)} mm)`);
console.log(`x range: ${first[0]} .. ${last[0]}   y range: ${first[1]} .. ${last[1]}`);

const gaps = [];
for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1].pos, b = slices[i].pos;
    gaps.push({
        z: +(b[2] - a[2]).toFixed(4),
        dist: +Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]).toFixed(4),
    });
}

const histogram = counts => Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 6)
    .map(([v, c]) => `${v}mm x${c}`).join('   ');

const tally = key => gaps.reduce((acc, g) => (acc[g[key]] = (acc[g[key]] || 0) + 1, acc), {});
console.log('\nz-only gaps  :', histogram(tally('z')));
console.log('3D distances :', histogram(tally('dist')));

const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
console.log(`\nmedian z gap        : ${median(gaps.map(g => g.z))}`);
console.log(`median 3D distance  : ${median(gaps.map(g => g.dist))}   <- what volumeBuilder uses`);
console.log(`span / (n-1)        : ${((last[2] - first[2]) / (slices.length - 1)).toFixed(4)}`);

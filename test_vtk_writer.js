import vtkXMLImageDataWriter from '@kitware/vtk.js/IO/XML/XMLImageDataWriter.js';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData.js';


const writer = vtkXMLImageDataWriter.newInstance();
const keys = [];
let obj = writer;
while (obj) {
    keys.push(...Object.getOwnPropertyNames(obj));
    obj = Object.getPrototypeOf(obj);
}
const relevantKeys = keys.filter(k => k.startsWith('set') || k.startsWith('write') || k.startsWith('getOutput'));
console.log('Relevant keys:', relevantKeys.sort().join(', '));

    const writer = vtkXMLImageDataWriter.newInstance();
    writer.setFormat('binary');
    
    console.log('Writing VTI file...');
    const fileContents = writer.write(image);
    console.log('write() returned type:', typeof output);
    if (output instanceof Promise) {
        output.then(res => console.log('write() promise resolved with type:', typeof res, res ? res.constructor.name : 'null'))
              .catch(err => console.error('write() promise rejected:', err));
    } else {
        console.log('write() returned:', output);
    }
} catch (e) {
    console.error('write() failed:', e.message);
}


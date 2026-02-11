export const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

export function extractPixelData(dataset) {
    let rawPixelData;
    if (!dataset.PixelData) {
        throw new Error("No pixel data found in DICOM file");
    }

    if (dataset.PixelData.buffer) {
        rawPixelData = dataset.PixelData;
    } else if (Array.isArray(dataset.PixelData) && dataset.PixelData[0] instanceof ArrayBuffer) {
        rawPixelData = new Uint8Array(dataset.PixelData[0]);
    } else if (typeof dataset.PixelData === 'object' && dataset.PixelData[0] && dataset.PixelData[0].buffer) {
        rawPixelData = dataset.PixelData[0];
    } else if (dataset.PixelData.byteArray) {
        rawPixelData = dataset.PixelData.byteArray;
    } else {
        if (typeof dataset.PixelData === 'string') {
            const buffer = Buffer.from(dataset.PixelData, 'base64');
            rawPixelData = new Uint8Array(buffer);
        } else {
            throw new Error("Unknown PixelData format");
        }
    }

    const bitsAllocated = dataset.BitsAllocated || 16;
    const pixelRepresentation = dataset.PixelRepresentation || 0;

    let pixelData;
    if (bitsAllocated <= 8) {
        pixelData = new Uint8Array(rawPixelData.buffer || rawPixelData);
    } else if (pixelRepresentation === 0) {
        pixelData = new Uint16Array(rawPixelData.buffer || rawPixelData);
    } else {
        pixelData = new Int16Array(rawPixelData.buffer || rawPixelData);
    }

    return pixelData;
}

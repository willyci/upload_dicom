const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const dicomParser = require('dicom-parser');
const sharp = require('sharp');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const dcmjs = require('dcmjs');
const { DicomMetaDictionary, DicomMessage } = dcmjs.data;
const dcmjsImaging = require('dcmjs-imaging');
const { createCanvas } = require('canvas');
//const vtkDICOMImageReader = require('vtk.js/Sources/IO/Misc/ITKImageReader');
//const sharp = require('sharp');
const vtkITKImageReader = require('@kitware/vtk.js/IO/Misc/ITKImageReader');
const vtkXMLImageDataWriter = require('@kitware/vtk.js/IO/XML/XMLImageDataWriter');
const vtkImageData = require('@kitware/vtk.js/Common/DataModel/ImageData');
const vtkDataArray = require('@kitware/vtk.js/Common/Core/DataArray');
const itk = require('itk/dist/itkjs.js');
const vtkWriter = require('@kitware/vtk.js/IO/Misc/ITKImageWriter');

// vkt vti
// The current vti supported format is ascii, binary and binary+zlib compression.
//https://kitware.github.io/vtk-js/examples/VolumeViewer.html#Source


const app = express();
const upload = multer({ dest: 'public/uploads/' });

// Serve static files
app.use(express.static('public'));

// Handle file upload
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error('No file uploaded');
        }

        // Create timestamp-based folder name
        const timestamp = Date.now();
        const folderName = `${timestamp}_${req.file.originalname.replace('.zip', '')}`;
        const extractPath = path.join(__dirname, '../public/uploads', folderName);
        
        console.log('Creating directory:', extractPath);
        await mkdir(extractPath, { recursive: true });

        // Extract ZIP file
        console.log('Extracting ZIP file to:', extractPath);
        await new Promise((resolve, reject) => {
          const unzipStream = unzipper.Parse();
          fs.createReadStream(req.file.path)
              .pipe(unzipStream)
              .on('entry', (entry) => {
                  const fileName = path.basename(entry.path); // Get just the filename
                  const writePath = path.join(extractPath, fileName);
                  
                  if (entry.type === 'File') {
                      entry.pipe(fs.createWriteStream(writePath));
                  } else {
                      entry.autodrain();
                  }
              })
              .on('finish', resolve)
              .on('error', reject);
      });

        // Process extracted files
        console.log('Starting file processing...');
        //const files = await processDirectory(extractPath+"/"+req.file.originalname.replace('.zip', ''));
        const files = await processDirectory(extractPath+"/");

        // Create JSON file
        const jsonData = JSON.stringify(files, null, 2);
        const jsonPath = path.join(extractPath+"/", 'dicom_info.json');
        await fs.promises.writeFile(jsonPath, jsonData);

        // Clean up the uploaded ZIP file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            folder: folderName,
            processedFiles: files,
            jsonPath: removePathBeforeUploads(jsonPath),
            vtiPaths: files.map(file => file.vtiPath)
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

function removePathBeforeUploads(fullPath) {
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/uploads');
    console.log("parts", parts[1]);
    return '/uploads' + parts[1];
}

async function generateSagittalCoronalImages(dataset, outputDir) {
    // Extract pixel data and dimensions
    const pixelData = dataset.PixelData;
    const width = dataset.Columns;
    const height = dataset.Rows;

    // Create sagittal image
    const sagittalImage = createCanvas(height, width);
    const sagittalCtx = sagittalImage.getContext('2d');
    const sagittalData = sagittalCtx.createImageData(height, width);

    // Create coronal image
    const coronalImage = createCanvas(height, width);
    const coronalCtx = coronalImage.getContext('2d');
    const coronalData = coronalCtx.createImageData(height, width);

    // Fill in the images with pixel data
    for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++) {
            const pixelIndex = (i * width + j) * 4; // RGBA
            const value = pixelData[i * height + j]; // Assuming grayscale

            // Set pixel data for sagittal image
            sagittalData.data[pixelIndex] = value;     // R
            sagittalData.data[pixelIndex + 1] = value; // G
            sagittalData.data[pixelIndex + 2] = value; // B
            sagittalData.data[pixelIndex + 3] = 255;   // A

            // Set pixel data for coronal image
            coronalData.data[pixelIndex] = value;       // R
            coronalData.data[pixelIndex + 1] = value;   // G
            coronalData.data[pixelIndex + 2] = value;   // B
            coronalData.data[pixelIndex + 3] = 255;     // A
        }
    }

    sagittalCtx.putImageData(sagittalData, 0, 0);
    coronalCtx.putImageData(coronalData, 0, 0);

    // Save images
    const sagittalPath = path.join(outputDir, 'sagittal.jpg');
    const coronalPath = path.join(outputDir, 'coronal.jpg');
    fs.writeFileSync(sagittalPath, sagittalImage.toBuffer('image/jpeg'));
    fs.writeFileSync(coronalPath, coronalImage.toBuffer('image/jpeg'));

    return { sagittalPath, coronalPath };
}

async function processDirectory(dirPath) {

    try {
        const files = await fs.promises.readdir(dirPath);
        const processedFiles = [];
        const dicomFiles = [];

        console.log(`Processing ${files.length} files in directory:`, dirPath);

        // First pass: collect all DICOM files
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          if (filePath.toLowerCase().endsWith('.dcm')) {
              dicomFiles.push(filePath);
          }
        }

        console.log(`Found ${dicomFiles.length} DICOM files to process.`);

        const vtiPath = path.join(dirPath, 'volume.vti');
        await convertToVti(dicomFiles, vtiPath);


        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.promises.stat(filePath);

            console.log("Processing file:", file);

            if (stats.isFile()) {
                try {
                    console.log('Processing file:', file);
                    
                    // Add .dcm extension if no extension exists
                    let currentPath = filePath;
                    if (!path.extname(file)) {
                        const newPath = `${filePath}.dcm`;
                        await fs.promises.rename(filePath, newPath);
                        currentPath = newPath;
                        console.log('Renamed file to:', newPath);
                    }

                    // Only process .dcm files
                    if (currentPath.toLowerCase().endsWith('.dcm')) {
                        const outputPath = `${currentPath}.jpg`;
                        await convertToJpg(currentPath, outputPath);

                        //const outputPathVtk = `${filePath}.vtk`;
                        //await convertToVtk(filePath, outputPathVtk);

                        const dicomInfo = showDicomInfo(filePath);
                        processedFiles.push({
                            dicomPath: removePathBeforeUploads(filePath),
                            jpgPath: removePathBeforeUploads(outputPath),
                            vtiPath: removePathBeforeUploads(vtiPath),
                            dicomInfo: dicomInfo
                        });
                        console.log('Successfully converted to JPG:', outputPath);
                    }
                } catch (error) {
                    console.error(`Error processing file ${file}:`, error);
                }
            }
        }

        console.log(`Found ${dicomFiles.length} DICOM files to process.`);
        

        return processedFiles;
    } catch (error) {
        console.error('Error reading directory:', error);
        throw error;
    }
}

async function convertToJpg(inputPath, outputPath) {
    console.log("inputPath", inputPath);
    try {
        // Read the DICOM file
        const dicomFileBuffer = fs.readFileSync(inputPath);
        
        // Parse the DICOM data
        const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
        const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
        
        console.log("PixelData type:", typeof dataset.PixelData);
        console.log("PixelData value:", dataset.PixelData ? (dataset.PixelData.length || 'Unknown length') : 'null');
        
        // Extract the pixel data - dcmjs often stores it in an array with a buffer property
        let rawPixelData;
        if (!dataset.PixelData) {
          throw new Error("No pixel data found in DICOM file");
        }
        
        // Handle different ways dcmjs might store pixel data
        if (dataset.PixelData.buffer) {
          // It's already a typed array with a buffer
          rawPixelData = dataset.PixelData;
        } else if (typeof dataset.PixelData === 'object' && dataset.PixelData[0] && dataset.PixelData[0].buffer) {
          // It might be stored in an array of typed arrays
          rawPixelData = dataset.PixelData[0];
        } else if (typeof dataset.PixelData === 'string') {
          // It might be a Base64 string
          const buffer = Buffer.from(dataset.PixelData, 'base64');
          rawPixelData = new Uint8Array(buffer);
        } else {
          // Access the ByteArray property which dcmjs sometimes uses
          rawPixelData = dataset.PixelData.byteArray || dataset.PixelData;
        }
        //console.log("Raw pixel data:", rawPixelData, );
        console.log("dataset.BitsAllocated", dataset.BitsAllocated);

        // Get image dimensions
        const width = dataset.Columns;
        const height = dataset.Rows;
        
        if (!width || !height) {
          throw new Error("Invalid image dimensions in DICOM file");
        }
        
        console.log(`Image dimensions: ${width}x${height}`);
        
        // Get important DICOM attributes
        const bitsAllocated = dataset.BitsAllocated || 16;
        const bitsStored = dataset.BitsStored || bitsAllocated;
        const highBit = dataset.HighBit || (bitsStored - 1);
        const pixelRepresentation = dataset.PixelRepresentation || 0;
        const samplesPerPixel = dataset.SamplesPerPixel || 1;
        const photometricInterpretation = dataset.PhotometricInterpretation || 'MONOCHROME2';
        const rescaleSlope = dataset.RescaleSlope || 1;
        const rescaleIntercept = dataset.RescaleIntercept || 0;
        
        console.log(`Bits allocated: ${bitsAllocated}, Photometric: ${photometricInterpretation}, pixelRepresentation: ${pixelRepresentation}`);
        
        // Create properly typed array for pixel data
        let pixelData;
        if (Array.isArray(rawPixelData) && rawPixelData[0] instanceof ArrayBuffer) {
            rawPixelData = rawPixelData[0]; // Extract the ArrayBuffer from the array
        }
        if (bitsAllocated <= 8) {
            pixelData = new Uint8Array(rawPixelData);
        } else if (pixelRepresentation === 0) {
            pixelData = new Uint16Array(rawPixelData);
        } else {
            pixelData = new Int16Array(rawPixelData);
        }

        //console.log("PixelData:",pixelData, "rawPixelData: ", rawPixelData  );
        
        // Get windowing values from DICOM or use defaults
        let windowCenter = dataset.WindowCenter;
        let windowWidth = dataset.WindowWidth;
        
        // Handle array values
        if (Array.isArray(windowCenter)) windowCenter = windowCenter[0];
        if (Array.isArray(windowWidth)) windowWidth = windowWidth[0];
        
        // If windowing values are not available, calculate suitable defaults
        if (!windowCenter || !windowWidth) {
          // Find min and max values for windowing
          let min = Infinity;
          let max = -Infinity;
          
          // Determine actual pixel value range
          for (let i = 0; i < Math.min(pixelData.length, width * height); i++) {
            const value = pixelData[i] * rescaleSlope + rescaleIntercept;
            if (value < min) min = value;
            if (value > max) max = value;
          }
          
          // Set windowing values based on actual pixel range
          windowCenter = (max + min) / 2;
          windowWidth = max - min;
          
          // If the windowWidth is too small, use a default value
          if (windowWidth < 10) windowWidth = max * 2; // Arbitrary default
          
          console.log(`Calculated window: Center=${windowCenter}, Width=${windowWidth}`);
        }
        
        // Create a canvas to draw the image
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        
        // Create an ImageData object
        const imageData = ctx.createImageData(width, height);
        
        // Debug: Log a few pixel values
        console.log("First few pixel values:", pixelData.slice(0, 5));
        
        // Process pixel data based on format
        if (samplesPerPixel === 1) {
          // Grayscale image
          let pixelIndex = 0;
          
          // Calculate window parameters
          const windowLow = windowCenter - windowWidth / 2;
          const windowHigh = windowCenter + windowWidth / 2;
          
          console.log(`Window parameters: Low=${windowLow}, High=${windowHigh}`);
          
          // Apply windowing and fill image data
          for (let i = 0; i < Math.min(pixelData.length, width * height); i++) {
            // Apply rescale slope and intercept
            let pixelValue = pixelData[i] * rescaleSlope + rescaleIntercept;
            
            // Windowing transformation
            if (pixelValue <= windowLow) {
              pixelValue = 0;
            } else if (pixelValue >= windowHigh) {
              pixelValue = 255;
            } else {
              pixelValue = ((pixelValue - windowLow) / windowWidth) * 255;
            }
            
            // Handle MONOCHROME1 (inverted grayscale)
            if (photometricInterpretation === 'MONOCHROME1') {
              pixelValue = 255 - pixelValue;
            }
            
            // Ensure value is in 0-255 range
            pixelValue = Math.max(0, Math.min(255, Math.round(pixelValue)));
            
            // Set RGB channels to the same value for grayscale
            imageData.data[pixelIndex++] = pixelValue; // R
            imageData.data[pixelIndex++] = pixelValue; // G
            imageData.data[pixelIndex++] = pixelValue; // B
            imageData.data[pixelIndex++] = 255;       // Alpha (fully opaque)
          }
        } else if (samplesPerPixel === 3) {
          // RGB image
          let pixelIndex = 0;
          
          // RGB images could be stored in different ways
          if (pixelData.length >= width * height * 3) {
            // Stored as planar configuration 0 (R1G1B1R2G2B2...)
            for (let i = 0; i < width * height * 3; i += 3) {
              if (i + 2 < pixelData.length) {
                const r = Math.max(0, Math.min(255, pixelData[i]));
                const g = Math.max(0, Math.min(255, pixelData[i + 1]));
                const b = Math.max(0, Math.min(255, pixelData[i + 2]));
                
                imageData.data[pixelIndex++] = r;
                imageData.data[pixelIndex++] = g;
                imageData.data[pixelIndex++] = b;
                imageData.data[pixelIndex++] = 255; // Alpha
              }
            }
          } else {
            // Fallback - create a solid colored image
            console.warn("RGB format not properly detected, creating fallback image");
            for (let i = 0; i < width * height; i++) {
              imageData.data[pixelIndex++] = 100; // R
              imageData.data[pixelIndex++] = 100; // G
              imageData.data[pixelIndex++] = 100; // B
              imageData.data[pixelIndex++] = 255; // Alpha
            }
          }
        }
        
        // Put the image data on the canvas
        ctx.putImageData(imageData, 0, 0);
        
        // Save as JPG
        const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
        fs.writeFileSync(outputPath, buffer);
        
        console.log(`Successfully converted ${inputPath} to ${outputPath}`);
        console.log(`Window Center: ${windowCenter}, Window Width: ${windowWidth}`);
        return { windowCenter, windowWidth };
      } catch (error) {
        console.error('Error converting DICOM to JPG:', error);
        throw error;
      }
}


async function generateBumpMap(dataSet, outputPath) {
    // Get image dimensions
    const width = dataSet.uint16('x00280010');
    const height = dataSet.uint16('x00280011');
    const pixelData = new Int16Array(dataSet.byteArray.buffer, dataSet.elements.x7fe00010.dataOffset);

    // Create canvas for bump map
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    // Calculate surface normals and create bump map
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x);
            
            // Calculate gradients
            const gx = pixelData[idx + 1] - pixelData[idx - 1];
            const gy = pixelData[idx + width] - pixelData[idx - width];
            
            // Convert to normal map values (0-255)
            const normalX = Math.floor(((gx / 255) + 1) * 127.5);
            const normalY = Math.floor(((gy / 255) + 1) * 127.5);
            
            // Set pixel in imageData
            const outIdx = idx * 4;
            imageData.data[outIdx] = normalX;     // R
            imageData.data[outIdx + 1] = normalY; // G
            imageData.data[outIdx + 2] = 255;     // B
            imageData.data[outIdx + 3] = 255;     // Alpha
        }
    }

    ctx.putImageData(imageData, 0, 0);

    // Save bump map
    const buffer = canvas.toBuffer('image/jpeg');
    await sharp(buffer)
        .normalize()
        .jpeg({ quality: 90 })
        .toFile(outputPath);
}
// not working correctly
async function convertDicomToImage(dicomFilePath, outputPath) {
    try {
      // Read the DICOM file
      const dicomFileBuffer = fs.readFileSync(dicomFilePath);
      
      // Parse the DICOM data
      const dataSet = dicomParser.parseDicom(dicomFileBuffer);
      
      // Get image dimensions
      const width = dataSet.uint16('x00280011'); // Columns
      const height = dataSet.uint16('x00280010'); // Rows
      const bitsAllocated = dataSet.uint16('x00280100');
      const pixelRepresentation = dataSet.uint16('x00280103');
      const samplesPerPixel = dataSet.uint16('x00280002') || 1;
      
      // Get pixel data
      const pixelDataElement = dataSet.elements.x7fe00010;
      const pixelData = new Uint8Array(dicomFileBuffer.buffer, pixelDataElement.dataOffset, pixelDataElement.length);
      
      // Create canvas with dimensions matching the DICOM image
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // Create an ImageData object
      const imageData = ctx.createImageData(width, height);
      
      // Handle different bit allocations
      if (bitsAllocated === 8) {
        // 8-bit data is straightforward
        for (let i = 0, j = 0; i < pixelData.length; i++, j += 4) {
          const pixelValue = pixelData[i];
          
          // Set RGBA values (grayscale)
          imageData.data[j] = pixelValue;     // R
          imageData.data[j + 1] = pixelValue; // G
          imageData.data[j + 2] = pixelValue; // B
          imageData.data[j + 3] = 255;        // A (opaque)
        }
      } else if (bitsAllocated === 16) {
        // Get window center and width for proper scaling
        let windowCenter = dataSet.int16('x00281050') || 127;
        let windowWidth = dataSet.int16('x00281051') || 256;
        
        // If no window values, estimate from the data
        if (!windowWidth) {
          windowWidth = 256;
          windowCenter = 128;
        }
        
        // For 16-bit data, handle byte ordering and scaling
        const pixelDataView = new DataView(pixelData.buffer);
        const isLittleEndian = dataSet.elements.x7fe00010.dataLittleEndian;
        
        for (let i = 0, p = 0; i < width * height; i++, p += 4) {
          // Read 16-bit pixel value with correct endianness
          const pixelValue = isLittleEndian ? 
            pixelDataView.getUint16(i * 2, true) : 
            pixelDataView.getUint16(i * 2, false);
          
          // Apply windowing to scale from 16-bit to 8-bit
          const hounsfieldValue = pixelRepresentation ? 
            (pixelValue > 32767 ? pixelValue - 65536 : pixelValue) : pixelValue;
          
          // Apply windowing formula
          let windowedValue = 0;
          if (hounsfieldValue <= windowCenter - 0.5 - (windowWidth - 1) / 2) {
            windowedValue = 0;
          } else if (hounsfieldValue > windowCenter - 0.5 + (windowWidth - 1) / 2) {
            windowedValue = 255;
          } else {
            windowedValue = ((hounsfieldValue - (windowCenter - 0.5)) / (windowWidth - 1) + 0.5) * 255;
          }
          
          // Bound value between 0-255
          windowedValue = Math.max(0, Math.min(255, Math.round(windowedValue)));
          
          // Set RGBA values (grayscale)
          imageData.data[p] = windowedValue;     // R
          imageData.data[p + 1] = windowedValue; // G
          imageData.data[p + 2] = windowedValue; // B
          imageData.data[p + 3] = 255;           // A (opaque)
        }
      }
      
      // Put image data on canvas
      ctx.putImageData(imageData, 0, 0);
      
      // Save the canvas as a PNG file
      const outputStream = fs.createWriteStream(outputPath);
      const stream = canvas.createPNGStream();
      stream.pipe(outputStream);
      
      return new Promise((resolve, reject) => {
        outputStream.on('finish', () => {
          resolve(outputPath);
        });
        outputStream.on('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error converting DICOM to image:', error);
      throw error;
    }
  }

  function showDicomInfo(inputPath) {
    try {
      const dicomFileBuffer = fs.readFileSync(inputPath);
      const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
      const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
      
      console.log('DICOM Info:');
      console.log('============');
      
      // First show common important tags
      const importantTags = [
        'Modality', 'Columns', 'Rows', 'BitsAllocated', 'BitsStored', 'HighBit',
        'PixelRepresentation', 'SamplesPerPixel', 'PhotometricInterpretation',
        'WindowCenter', 'WindowWidth', 'RescaleIntercept', 'RescaleSlope',
        'TransferSyntaxUID', 'SOPClassUID'
      ];
      
      console.log('Important Tags:');
      console.log('--------------');
      importantTags.forEach(tag => {
        if (dataset[tag] !== undefined) {
          //console.log(`${tag}: ${dataset[tag]}`);
        }
      });
      
      // Check pixel data format specifically
      console.log('\nPixel Data:');
      console.log('-----------');
      if (dataset.PixelData) {
        console.log(`Type: ${typeof dataset.PixelData}`);
        if (typeof dataset.PixelData === 'object') {
          //console.log(`Is Array: ${Array.isArray(dataset.PixelData)}`);
          //console.log(`Has Buffer: ${!!dataset.PixelData.buffer}`);
          //console.log(`Has ByteArray: ${!!dataset.PixelData.byteArray}`);
          if (dataset.PixelData.byteArray) {
            //console.log(`ByteArray length: ${dataset.PixelData.byteArray.length}`);
          }
        }
        
        // Try to determine the pixel data length
        let pixelDataLength = 'Unknown';
        if (dataset.PixelData.length) {
          pixelDataLength = dataset.PixelData.length;
        } else if (dataset.PixelData.byteArray && dataset.PixelData.byteArray.length) {
          pixelDataLength = dataset.PixelData.byteArray.length;
        } else if (dataset.PixelData.buffer && dataset.PixelData.buffer.byteLength) {
          pixelDataLength = dataset.PixelData.buffer.byteLength;
        }
        
        const expectedLength = dataset.Columns * dataset.Rows * 
                            (dataset.BitsAllocated === 16 ? 2 : 1) * 
                            (dataset.SamplesPerPixel || 1);
        
        //console.log(`Pixel Data Length: ${pixelDataLength}, Expected: ${expectedLength}`);
        
        // Show a few values from pixel data if possible
        try {
          let sampleValues = [];
          if (dataset.PixelData.byteArray) {
            sampleValues = Array.from(dataset.PixelData.byteArray.slice(0, 5));
          } else if (dataset.PixelData.buffer) {
            const view = new DataView(dataset.PixelData.buffer);
            for (let i = 0; i < 10; i += 2) {
              if (i < view.byteLength) {
                sampleValues.push(view.getUint16(i, true));
              }
            }
          }
          //console.log(`Sample values: ${sampleValues.join(', ')}`);
        } catch (e) {
          //console.log(`Could not extract sample values: ${e.message}`);
        }
      } else {
        console.log('No Pixel Data found!');
      }
      
      // Display all available tags in the dataset
      console.log('\nAll DICOM Tags:');
      console.log('--------------');
      
      // Get all keys and sort them alphabetically for easier reading
      const allKeys = Object.keys(dataset).sort();
      
      allKeys.forEach(key => {
        // Skip PixelData as we've already handled it specially
        if (key === 'PixelData') {
          return;
        }
        
        let value = dataset[key];
        
        // Format the output based on the type of value
        if (Array.isArray(value)) {
          if (value.length > 10) {
            // Truncate long arrays
            //console.log(`${key}: Array[${value.length}] = [${value.slice(0, 5).join(', ')}... and ${value.length - 5} more items]`);
          } else {
            //console.log(`${key}: [${value.join(', ')}]`);
          }
        } else if (typeof value === 'object' && value !== null) {
          // Handle objects and buffers
          if (value.buffer) {
            //console.log(`${key}: TypedArray(length=${value.length})`);
          } else {
            try {
              // Try to stringify if it's a simple object
              const objStr = JSON.stringify(value);
              if (objStr.length > 100) {
                //console.log(`${key}: ${objStr.substring(0, 100)}...`);
              } else {
                //console.log(`${key}: ${objStr}`);
              }
            } catch (e) {
              //console.log(`${key}: [Complex Object]`);
            }
          }
        } else {
          // Handle primitive values
          //console.log(`${key}: ${value}`);
        }
      });
      
      // Check for key transfer syntax info that might indicate compression
      console.log('\nCompression Check:');
      console.log('----------------');
      
      const transferSyntax = dataset.TransferSyntaxUID;
      if (transferSyntax) {
        const compressionTypes = {
          '1.2.840.10008.1.2': 'Implicit VR Little Endian (uncompressed)',
          '1.2.840.10008.1.2.1': 'Explicit VR Little Endian (uncompressed)',
          '1.2.840.10008.1.2.2': 'Explicit VR Big Endian (uncompressed)',
          '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)',
          '1.2.840.10008.1.2.4.51': 'JPEG Baseline (Process 2 & 4)',
          '1.2.840.10008.1.2.4.57': 'JPEG Lossless, Non-Hierarchical',
          '1.2.840.10008.1.2.4.70': 'JPEG Lossless, Non-Hierarchical, First-Order Prediction',
          '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
          '1.2.840.10008.1.2.4.81': 'JPEG-LS Lossy',
          '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
          '1.2.840.10008.1.2.4.91': 'JPEG 2000 Lossy',
          '1.2.840.10008.1.2.5': 'RLE Lossless'
        };
        
        if (compressionTypes[transferSyntax]) {
          //console.log(`Transfer Syntax: ${transferSyntax} - ${compressionTypes[transferSyntax]}`);
          
          if (transferSyntax !== '1.2.840.10008.1.2' && 
              transferSyntax !== '1.2.840.10008.1.2.1' && 
              transferSyntax !== '1.2.840.10008.1.2.2') {
            //console.log('WARNING: This file uses compressed pixel data format.');
            //console.log('dcmjs may not be able to handle this compression type.');
            //console.log('Consider using a library like cornerstone or dicom-parser with decompression support.');
          } else {
           // console.log('This file uses uncompressed pixel data, which should be compatible with dcmjs.');
          }
        } else {
          //console.log(`Transfer Syntax: ${transferSyntax} - Unknown format`);
        }
      } else {
        //console.log('No TransferSyntaxUID found. Cannot determine compression type.');
      }
      
      return dataset;
    } catch (error) {
      //console.error('Error reading DICOM info:', error);
      return null;
    }
  }
  
  /**
   * The pixel data in dcmjs might be in a different format than expected.
   * This function attempts to directly access the raw DICOM file and extract pixel data.
   */
  function extractRawPixelData(inputPath) {
    try {
      const buffer = fs.readFileSync(inputPath);
      
      // Find the pixel data tag (7FE0,0010)
      const pixelDataTag = Buffer.from([0xE0, 0x7F, 0x10, 0x00]);
      let index = buffer.indexOf(pixelDataTag);
      
      if (index !== -1) {
        console.log(`Found pixel data tag at offset: ${index}`);
        
        // Skip the tag and value length fields (typically 8 bytes total)
        const dataStartIndex = index + 8;
        
        // Extract a portion of data for analysis
        const sampleData = buffer.slice(dataStartIndex, dataStartIndex + 100);
        console.log('Sample raw pixel data:', sampleData);
        
        return true;
      } else {
        console.log('Pixel data tag not found in raw file');
        return false;
      }
    } catch (error) {
      console.error('Error extracting raw pixel data:', error);
      return false;
    }
  }  

  function batchConvertDicomToImage(inputDir, outputDir, forceWindowCenter, forceWindowWidth) {
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Get all files in input directory
    const files = fs.readdirSync(inputDir);
    
    // Filter for DICOM files (common extensions)
    const dicomFiles = files.filter(file => 
      file.endsWith('.dcm') || 
      file.endsWith('.dicom') || 
      file.endsWith('.dic') ||
      path.extname(file) === '' // DICOM files sometimes have no extension
    );
    
    console.log(`Found ${dicomFiles.length} potential DICOM files`);
    
    // Process each file
    dicomFiles.forEach((file, index) => {
      const inputPath = path.join(inputDir, file);
      const outputPath = path.join(outputDir, `${path.parse(file).name}.jpg`);
      
      console.log(`Converting file ${index + 1}/${dicomFiles.length}: ${file}`);
      
      try {
        // Process with overridden windowing if provided
        if (forceWindowCenter !== undefined && forceWindowWidth !== undefined) {
          console.log(`Using forced windowing: Center=${forceWindowCenter}, Width=${forceWindowWidth}`);
        }
        
        const result = convertDicomToImage(inputPath, outputPath);
      } catch (error) {
        console.error(`Failed to convert ${file}:`, error.message);
      }
    });
    
    console.log('Batch conversion complete');
  }


  async function convertToVtk(dicomFiles, outputPath) {
    try {
        // Create an array to store all slices
        const slices = [];
        
        // Load and sort all DICOM files
        for (const filePath of dicomFiles) {
            const dicomFileBuffer = fs.readFileSync(filePath);
            const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
            const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
            
            // Extract position and orientation information
            const position = dataset.ImagePositionPatient || [0, 0, 0];
            const orientation = dataset.ImageOrientationPatient || [1, 0, 0, 0, 1, 0];
            const spacing = dataset.PixelSpacing || [1, 1];
            const sliceThickness = dataset.SliceThickness || 1;
            
            slices.push({
                dataset,
                position,
                orientation,
                spacing: [...spacing, sliceThickness],
                imageData: dataset.PixelData,
                rows: dataset.Rows,
                columns: dataset.Columns,
                zPosition: position[2] // For sorting slices
            });
        }
        
        // Sort slices by z-position
        slices.sort((a, b) => a.zPosition - b.zPosition);
        
        // Create VTK data structure
        const dimensions = [
            slices[0].columns,
            slices[0].rows,
            slices.length
        ];
        
        const spacing = [
            slices[0].spacing[0],
            slices[0].spacing[1],
            slices[0].spacing[2]
        ];
        
        // Create the volume data
        const volumeData = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);
        
        // Fill volume data from slices
        slices.forEach((slice, zIndex) => {
            const pixelData = new Float32Array(slice.imageData.buffer);
            const sliceOffset = zIndex * dimensions[0] * dimensions[1];
            
            for (let y = 0; y < dimensions[1]; y++) {
                for (let x = 0; x < dimensions[0]; x++) {
                    const sourceIndex = y * dimensions[0] + x;
                    const targetIndex = sliceOffset + sourceIndex;
                    volumeData[targetIndex] = pixelData[sourceIndex];
                }
            }
        });
        
        // Write VTK file
        const vtkContent = `# vtk DataFile Version 3.0
                            converted from DICOM
                            BINARY
                            DATASET STRUCTURED_POINTS
                            DIMENSIONS ${dimensions.join(' ')}
                            ORIGIN ${slices[0].position.join(' ')}
                            SPACING ${spacing.join(' ')}
                            POINT_DATA ${volumeData.length}
                            SCALARS intensity float
                            LOOKUP_TABLE default
                            `;

        // Write header as ASCII
        fs.writeFileSync(outputPath, vtkContent);
        
        // Append binary data
        const buffer = Buffer.from(volumeData.buffer);
        fs.appendFileSync(outputPath, buffer);
        
        console.log(`Successfully converted ${dicomFiles.length} files to VTP: ${outputPath}`);
        return outputPath;
    } catch (error) {
        console.error('Error converting DICOM to VTK:', error);
        throw error;
    }
}


async function convertToVtp(dicomFiles, outputPath) {
  try {
      // Create an array to store all slices
      const slices = [];
      
      // Load and sort all DICOM files
      for (const filePath of dicomFiles) {
          const dicomFileBuffer = fs.readFileSync(filePath);
          const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
          const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
          
          // Extract position and orientation information
          const position = dataset.ImagePositionPatient || [0, 0, 0];
          const orientation = dataset.ImageOrientationPatient || [1, 0, 0, 0, 1, 0];
          const spacing = dataset.PixelSpacing || [1, 1];
          const sliceThickness = dataset.SliceThickness || 1;
          
          slices.push({
              dataset,
              position,
              orientation,
              spacing: [...spacing, sliceThickness],
              imageData: dataset.PixelData,
              rows: dataset.Rows,
              columns: dataset.Columns,
              zPosition: position[2]
          });
      }
      
      // Sort slices by z-position
      slices.sort((a, b) => a.zPosition - b.zPosition);
      
      // Create XML structure for VTP file
      const vtpContent = `<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">
<PolyData>
  <Piece NumberOfPoints="${slices.length * slices[0].rows * slices[0].columns}" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="0">
    <Points>
      <DataArray type="Float32" NumberOfComponents="3" format="binary">
        ${generatePointsData(slices)}
      </DataArray>
    </Points>
    <PointData Scalars="ImageScalars">
      <DataArray type="Float32" Name="ImageScalars" format="binary">
        ${generateScalarsData(slices)}
      </DataArray>
    </PointData>
  </Piece>
</PolyData>
</VTKFile>`;

      // Write VTP file
      fs.writeFileSync(outputPath, vtpContent);
      console.log(`Successfully converted ${dicomFiles.length} files to VTP: ${outputPath}`);
      return outputPath;
  } catch (error) {
      console.error('Error converting DICOM to VTP:', error);
      throw error;
  }
}


async function convertToVti(dicomFiles, outputPath) {
    try {
      // First use ITK to read the DICOM series
      const directory = path.dirname(dicomFiles[0]);
      console.log('Reading DICOM series from:', directory);
      
      // Read the DICOM series using ITK
      const itkImage = await itk.readImageDICOMFileSeries(directory);
      console.log('ITK Image loaded:', itkImage);

      // Convert ITK image to VTK image
      const vtkImage = vtkITKImageReader.convertItkToVtkImage(itkImage);
      console.log('Converted to VTK image');

      // Set up the writer
      const writer = vtkWriter.newInstance();
      writer.setFileName(outputPath);
      writer.setInputData(vtkImage);

      // Write the VTI file
      console.log('Writing VTI file to:', outputPath);
      await writer.write();

      // Verify the file was written
      if (fs.existsSync(outputPath)) {
          console.log('Successfully wrote VTI file');
          return outputPath;
      } else {
          throw new Error('VTI file was not created');
      }
  } catch (error) {
      console.error('Error converting DICOM to VTI:', error);
      throw error;
  }
}

function generatePointsData(slices) {
  // Create points array for all voxels
  const points = [];
  const spacing = slices[0].spacing;
  
  slices.forEach((slice, z) => {
      for (let y = 0; y < slice.rows; y++) {
          for (let x = 0; x < slice.columns; x++) {
              points.push(
                  x * spacing[0],
                  y * spacing[1],
                  z * spacing[2]
              );
          }
      }
  });

  // Convert to base64
  const buffer = Buffer.from(new Float32Array(points).buffer);
  return buffer.toString('base64');
}

function generateScalarsData(slices) {
  // Create scalar array for all voxels
  const scalars = [];
  
  slices.forEach(slice => {
      const pixelData = new Float32Array(slice.imageData.buffer);
      scalars.push(...Array.from(pixelData));
  });

  // Convert to base64
  const buffer = Buffer.from(new Float32Array(scalars).buffer);
  return buffer.toString('base64');
}

  app.get('/list-uploads', async (req, res) => {
    try {
        const uploadsPath = path.join(__dirname, '../public/uploads');
        
        // Check if uploads directory exists
        if (!fs.existsSync(uploadsPath)) {
            return res.json({ jsonFiles: [] });
        }

        // Function to recursively find JSON files
        async function findJsonFiles(dir) {
            const jsonFiles = [];
            const items = await fs.promises.readdir(dir, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                
                if (item.isDirectory()) {
                    // Recursively search subdirectories
                    const nestedFiles = await findJsonFiles(fullPath);
                    jsonFiles.push(...nestedFiles);
                } else if (item.name === 'dicom_info.json') {
                    // Find associated VTI file in the same directory
                    const vtiPath = path.join(path.dirname(fullPath), 'volume.vti');
                    jsonFiles.push({
                        jsonPath: fullPath,
                        vtiPath: fs.existsSync(vtiPath) ? vtiPath : null
                    });
                }
            }
            
            return jsonFiles;
        }

        // Find all JSON files recursively
        const jsonFiles = await findJsonFiles(uploadsPath);

        
        
        // Format the results with normalized paths
        const normalizedPaths = jsonFiles.map((filePath, index) => ({
          index: index + 1,  
          path: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/')), // Normalize path separators
          vtiPath:removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'volume.vti')) // filePath.vtiPath ? removePathBeforeUploads(filePath.vtiPath.replace(/\\/g, '/')) : null
        }));

        // Write to index.json
        const indexPath = path.join(uploadsPath, 'index.json');
        await fs.promises.writeFile(
            indexPath, 
            JSON.stringify({ folders: normalizedPaths }, null, 2)
        );

        console.log('Found JSON files:', normalizedPaths);
        console.log('Index file written to:', indexPath);

        res.json({ 
            folders: normalizedPaths,
            indexPath: removePathBeforeUploads(indexPath)
        });
    } catch (error) {
        console.error('Error listing JSON files:', error);
        res.status(500).json({ error: 'Error listing JSON files' });
    }
  });


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

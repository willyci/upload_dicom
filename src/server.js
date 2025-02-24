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
//const Jimp = require('jimp');

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
        await fs.createReadStream(req.file.path)
            .pipe(unzipper.Extract({ path: extractPath }))
            .promise();

        // Process extracted files
        console.log('Starting file processing...');
        const files = await processDirectory(extractPath+"/"+req.file.originalname.replace('.zip', ''));

        // Clean up the uploaded ZIP file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            folder: folderName,
            processedFiles: files
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

async function processDirectory(dirPath) {
    try {
        const files = await fs.promises.readdir(dirPath);
        const processedFiles = [];

        console.log(`Processing ${files.length} files in directory:`, dirPath);

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
                        //await convertDicomToImage(currentPath, outputPath);
                        processedFiles.push({
                            original: file,
                            jpg: `${file}.jpg`
                        });
                        console.log('Successfully converted to JPG:', outputPath);
                    }
                } catch (error) {
                    console.error(`Error processing file ${file}:`, error);
                }
            }
        }

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

        console.log("PixelData:",pixelData, "rawPixelData: ", rawPixelData  );
        
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
      console.log('------------');
      console.log(`Modality: ${dataset.Modality}`);
      console.log(`Dimensions: ${dataset.Columns}x${dataset.Rows}`);
      console.log(`Bits Allocated: ${dataset.BitsAllocated}`);
      console.log(`Bits Stored: ${dataset.BitsStored}`);
      console.log(`High Bit: ${dataset.HighBit}`);
      console.log(`Pixel Representation: ${dataset.PixelRepresentation}`);
      console.log(`Samples Per Pixel: ${dataset.SamplesPerPixel}`);
      console.log(`Photometric Interpretation: ${dataset.PhotometricInterpretation}`);
      console.log(`Window Center: ${dataset.WindowCenter}`);
      console.log(`Window Width: ${dataset.WindowWidth}`);
      console.log(`Rescale Intercept: ${dataset.RescaleIntercept}`);
      console.log(`Rescale Slope: ${dataset.RescaleSlope}`);
      
      // Check pixel data format
      console.log('\nPixel Data:');
      if (dataset.PixelData) {
        console.log(`Type: ${typeof dataset.PixelData}`);
        if (typeof dataset.PixelData === 'object') {
          console.log(`Is Array: ${Array.isArray(dataset.PixelData)}`);
          console.log(`Has Buffer: ${!!dataset.PixelData.buffer}`);
          console.log(`Has ByteArray: ${!!dataset.PixelData.byteArray}`);
          if (dataset.PixelData.byteArray) {
            console.log(`ByteArray length: ${dataset.PixelData.byteArray.length}`);
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
        
        console.log(`Pixel Data Length: ${pixelDataLength}, Expected: ${expectedLength}`);
        
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
          console.log(`Sample values: ${sampleValues.join(', ')}`);
        } catch (e) {
          console.log(`Could not extract sample values: ${e.message}`);
        }
      } else {
        console.log('No Pixel Data found!');
      }
      
      return dataset;
    } catch (error) {
      console.error('Error reading DICOM info:', error);
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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
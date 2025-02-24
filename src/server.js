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
        console.log('Reading DICOM file:', inputPath);
        const dicomData = await fs.promises.readFile(inputPath);
        
        console.log('Parsing DICOM data with dcmjs...');
        const dicomDict = dcmjs.data.DicomMessage.readFile(dicomData.buffer);
        const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
        const pixelData = dataset.PixelData;

        const width = dataset.Columns;
        const height = dataset.Rows;
        const bitsAllocated = dataset.BitsAllocated;
        const samplesPerPixel = dataset.SamplesPerPixel || 1;

        console.log('DICOM Metadata:', {
            width,
            height,
            bitsAllocated,
            samplesPerPixel
        });

        // Use dcmjs-imaging to convert to JPG
        const image = dcmjsImaging.getImageDataFromDataset(dataset);
        console.log('Image data:', image);
        const canvas = dcmjsImaging.renderToCanvas(image);
        console.log('Canvas:', canvas);

        const buffer = canvas.toBuffer('image/jpeg', {
            quality: 0.9,
            chromaSubsampling: '4:4:4'
        });

        await fs.promises.writeFile(outputPath, buffer);

        console.log('JPG conversion complete:', outputPath);
    } catch (error) {
        console.error('Error in convertToJpg:', error);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
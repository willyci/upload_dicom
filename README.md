# DICOM Processor

This project is a DICOM file processor that allows users to upload zip files containing DICOM files, which are then processed and converted into JPG and VTP formats. The application provides a web interface for uploading files, viewing converted VTP files, and displaying images.

## Project Structure

- **public/**
  - **upload.html**: HTML page for uploading DICOM files.
  - **viewer.html**: HTML page for viewing VTP files using vtk.js.
  - **images.html**: HTML page for displaying all images in the uploaded folder.

- **src/**
  - **app.js**: Entry point of the application, sets up the Express server and routes.
  - **controllers/**
    - **uploadController.js**: Handles file uploads and processing.
    - **viewerController.js**: Renders the viewer page for VTP files.
    - **imagesController.js**: Renders the images page and lists all images.
  - **routes/**
    - **uploadRoutes.js**: Routes for file uploads.
    - **viewerRoutes.js**: Routes for viewing VTP files.
    - **imagesRoutes.js**: Routes for displaying images.
  - **utils/**
    - **dicomProcessor.js**: Utility functions for processing DICOM files.
    - **fileHandler.js**: Utility functions for file operations.

## Setup Instructions

1. **Clone the repository**:
   ```
   git clone <repository-url>
   cd dicom-processor
   ```

2. **Install dependencies**:
   ```
   npm install
   ```

3. **Run the application**:
   ```
   npm start
   ```

4. **Access the application**:
   Open your web browser and navigate to `http://localhost:3000`.

## Usage

- Navigate to the **upload page** to upload a zip file containing DICOM files.
- After uploading, you can view the converted VTP files on the **viewer page**.
- The **images page** displays all images generated from the DICOM files.

## Dependencies

- **express**: Web framework for Node.js.
- **multer**: Middleware for handling file uploads.
- **vtk.js**: Library for rendering VTP files.

## License

This project is licensed under the MIT License.
import vtk
import sys
import os
import glob

def convert_dicom_to_vti(input_dir, output_file):
    print(f"Starting conversion from {input_dir} to {output_file}")
    
    # Check if input directory exists
    if not os.path.exists(input_dir):
        print(f"Error: Input directory {input_dir} does not exist")
        sys.exit(1)

    # Find all DICOM files
    dicom_files = sorted(glob.glob(os.path.join(input_dir, "*.dcm")))
    if not dicom_files:
        print(f"Error: No .dcm files found in {input_dir}")
        sys.exit(1)
        
    print(f"Found {len(dicom_files)} DICOM files.")
    
    # Create the appender
    append = vtk.vtkImageAppend()
    append.SetAppendAxis(2) # Append along Z axis
    
    # Keep readers alive
    readers = []
    
    print("Reading files and appending...")
    for i, f in enumerate(dicom_files):
        reader = vtk.vtkDICOMImageReader()
        reader.SetFileName(f)
        reader.Update()
        
        # Check dimensions of the slice
        dims = reader.GetOutput().GetDimensions()
        if i == 0:
            print(f"First slice dimensions: {dims}")
            
        append.AddInputData(reader.GetOutput())
        readers.append(reader) # Keep reference
        
    append.Update()
    
    output_data = append.GetOutput()
    dims = output_data.GetDimensions()
    print(f"Final volume dimensions: {dims}")
    
    if dims[0] == 0:
        print("Error: Resulting volume is empty.")
        sys.exit(1)

    # Create the writer
    writer = vtk.vtkXMLImageDataWriter()
    writer.SetFileName(output_file)
    writer.SetInputData(output_data)
    
    # Configure writer to match the format expected by the viewer
    # Disable compression
    writer.SetCompressorTypeToNone()
    # Use appended data mode
    writer.SetDataModeToAppended()
    # Use raw encoding (not base64)
    writer.SetEncodeAppendedData(0)
    
    # Write the file
    print("Writing VTI file...")
    if writer.Write() == 1:
        print(f"Successfully wrote {output_file}")
    else:
        print(f"Error writing {output_file}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python dicom_converter.py <input_dir> <output_file>")
        sys.exit(1)
        
    input_dir = sys.argv[1]
    output_file = sys.argv[2]
    
    convert_dicom_to_vti(input_dir, output_file)

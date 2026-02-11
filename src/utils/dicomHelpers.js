import dcmjs from 'dcmjs';

const dcmjsData = dcmjs.default?.data || dcmjs.data;
export const { DicomMetaDictionary, DicomMessage } = dcmjsData;

let currentStatus = '';

export function setProcessingStatus(msg) {
    currentStatus = msg;
}

export function getProcessingStatus() {
    return currentStatus;
}

import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs for renderer
const api = {
    getDevices: () => ipcRenderer.invoke('get-devices'),
    getMyInfo: () => ipcRenderer.invoke('get-my-info'),
    setPublicFolder: (enabled, path) => ipcRenderer.send('set-public-folder', { enabled, path }),
    setDownloadFolder: (path) => ipcRenderer.send('set-download-folder', path),
    setIdentity: (name, avatar) => ipcRenderer.send('set-identity', { name, avatar }),
    setCastingState: (isCasting) => ipcRenderer.send('set-casting-state', isCasting),
    getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    clearInactiveDevices: () => ipcRenderer.send('clear-inactive-devices'),
    refreshDevices: () => ipcRenderer.send('refresh-devices'),
    completeOnboarding: () => ipcRenderer.send('complete-onboarding'),
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),

    // WebRTC sending
    sendWebrtcAnswer: (socketId, data) => ipcRenderer.send('send-webrtc-answer', { socketId, data }),
    sendWebrtcIceCandidate: (socketId, data) => ipcRenderer.send('send-webrtc-ice-candidate', { socketId, data }),

    // Listeners
    onDeviceDiscovered: (callback) => ipcRenderer.on('device-discovered', (_event, device) => callback(device)),
    onDeviceLost: (callback) => ipcRenderer.on('device-lost', (_, deviceId) => callback(deviceId)),
    onChatMessage: (callback) => ipcRenderer.on('chat-message', (_, msg) => callback(msg)),
    onFileReceived: (callback) => ipcRenderer.on('file-received', (_, fileInfo) => callback(fileInfo)),
    onTransferProgress: (callback) => ipcRenderer.on('transfer-progress', (_, progress) => callback(progress)),
    onWebrtcOffer: (callback) => ipcRenderer.on('webrtc-offer', (_, data, socketId) => callback(data, socketId)),
    onWebrtcAnswer: (callback) => ipcRenderer.on('webrtc-answer', (_, data) => callback(data)),
    onWebrtcIceCandidate: (callback) => ipcRenderer.on('webrtc-ice-candidate', (_, data, socketId) => callback(data, socketId)),
    onUpdateMessage: (callback) => ipcRenderer.on('update-message', (_, msg) => callback(msg))
}

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('api', api)
    } catch (error) {
        console.error(error)
    }
} else {
    window.api = api
}

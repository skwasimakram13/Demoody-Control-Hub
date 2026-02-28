import { io } from 'socket.io-client';

const state = {
    myInfo: null,
    isCasting: false,
    devices: new Map(), // Active peers on network
    activeChatDevice: null,
    activeGroupDevice: null,
    customPublicDir: null, // Keep track of the user-selected folder
    socketConnections: new Map(), // Peer TCP connections
    peerConnections: new Map(), // WebRTC RTCPeerConnections (socketId -> pc)
    localStream: null, // Our screen capture stream to push
    messages: new Map(), // Messages stored by deviceId
    activeTransfers: new Map() // fileId -> state
};

// Config
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const MAX_CONCURRENT_UPLOADS = 4;
let throttleLimitMBps = 0; // 0 = unlimited

// UI Elements
const viewRadar = document.getElementById('view-radar');
const viewChat = document.getElementById('view-chat');
const viewGroup = document.getElementById('view-group');
const devicesGrid = document.getElementById('devices-grid');

const chatEmptyState = document.getElementById('chat-empty-state');
const chatActiveState = document.getElementById('chat-active-state');
const chatRecipientName = document.getElementById('chat-recipient-name');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const btnAttach = document.getElementById('btn-attach');
const fileInput = document.getElementById('file-input');

const groupDevicesList = document.getElementById('group-devices-list');
const groupFilesList = document.getElementById('group-files-list');

// ==========================================
// Clear Inactive Devices
// ==========================================
const btnClearInactive = document.getElementById('btn-clear-inactive');
if (btnClearInactive) {
    btnClearInactive.addEventListener('click', () => {
        const offlineIds = [];
        state.devices.forEach(device => {
            if (device.status === 'offline') offlineIds.push(device.id);
        });

        if (offlineIds.length === 0) return;

        offlineIds.forEach(id => state.devices.delete(id));
        renderRadarGrid();
        renderGroupSidebar();

        if (window.api && window.api.clearInactiveDevices) {
            window.api.clearInactiveDevices();
        }
    });
}

// ==========================================
// Phase 11: WebRTC Screen Casting
// ==========================================

const btnShareScreen = document.getElementById('btn-share-screen');
const screenViewerModal = document.getElementById('screen-viewer-modal');
const remoteVideo = document.getElementById('remote-video');
const btnCloseViewer = document.getElementById('btn-close-viewer');
const viewerLoading = document.getElementById('viewer-loading');

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // Basic STUN

// 1. Caster clicking "Share Screen"
btnShareScreen?.addEventListener('click', async () => {
    if (state.isCasting) {
        stopCasting();
    } else {
        await startCasting();
    }
});

async function startCasting() {
    try {
        const sources = await window.api.getDesktopSources();
        if (!sources || sources.length === 0) return;

        // Pick the first screen source
        const primarySource = sources[0];

        state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: primarySource.id,
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080
                }
            }
        });

        state.localStream.getVideoTracks()[0].onended = () => stopCasting();

        state.isCasting = true;
        btnShareScreen.innerText = '⏹ Stop Share';
        btnShareScreen.style.background = 'var(--danger)';
        window.api.setCastingState(true);

    } catch (e) {
        console.error('Failed to start casting:', e);
    }
}

function stopCasting() {
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    state.peerConnections.forEach(pc => pc.close());
    state.peerConnections.clear();

    state.isCasting = false;
    btnShareScreen.innerText = '📺 Share';
    btnShareScreen.style.background = 'var(--accent)';
    window.api.setCastingState(false);
}

// 2. Viewer clicking "View" on a radar card
window.startViewingScreen = async (casterId) => {
    const caster = state.devices.get(casterId);
    if (!caster) return;

    // Open Modal
    screenViewerModal.style.display = 'flex';
    document.getElementById('viewer-title').innerText = `Viewing ${caster.name}'s Screen`;
    viewerLoading.style.display = 'block';

    // Establish Socket connection if not exists for signaling
    let socket = state.socketConnections.get(casterId);
    if (!socket) {
        const portToConnect = caster.port === 0 ? 3000 : caster.port;
        socket = io(`http://${caster.address}:${portToConnect}`);
        state.socketConnections.set(casterId, socket);
    }

    // Create RTCPeerConnection (Viewer)
    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.peerConnections.set('viewer', pc);

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            document.getElementById('btn-close-viewer').click();
        }
    };

    pc.ontrack = (event) => {
        viewerLoading.style.display = 'none';
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', event.candidate);
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // We send offer *along* with the sender info so the caster knows who it is
    socket.emit('webrtc-offer', offer);
};

// Viewer close button
btnCloseViewer?.addEventListener('click', () => {
    const pc = state.peerConnections.get('viewer');
    if (pc) {
        pc.close();
        state.peerConnections.delete('viewer');
    }
    remoteVideo.srcObject = null;
    screenViewerModal.style.display = 'none';
});

// 3. Signaling Listeners (Preload API -> window)
window.api.onWebrtcOffer(async (offer, socketId) => {
    // We are the caster, someone wants to view our screen
    if (!state.isCasting || !state.localStream) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.peerConnections.set(socketId, pc);

    // Add local stream tracks
    state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            window.api.sendWebrtcIceCandidate(socketId, event.candidate);
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Send answer back
    window.api.sendWebrtcAnswer(socketId, answer);
});

window.api.onWebrtcAnswer(async (answer) => {
    const pc = state.peerConnections.get('viewer');
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

window.api.onWebrtcIceCandidate(async (candidate, socketId) => {
    // If we're the viewer, socketId isn't used here, we just use our 'viewer' pc
    // If we're the caster, we use the pc mapped to the socketId
    const pc = state.peerConnections.get(socketId) || state.peerConnections.get('viewer');
    if (pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding ICE candidate', e);
        }
    }
});
// Initialize Reactivity & IPC Listeners
async function initApp() {
    if (!window.api) return;

    // 1. Get My Device Info
    state.myInfo = await window.api.getMyInfo();
    document.getElementById('my-name').innerText = state.myInfo.name;
    document.getElementById('my-avatar').innerText = state.myInfo.avatar;
    document.getElementById('my-os').innerText = state.myInfo.os;
    document.getElementById('avatar-input').value = state.myInfo.avatar;
    document.getElementById('name-input').value = state.myInfo.name;

    // First Launch Onboarding
    if (state.myInfo.isFirstLaunch) {
        document.getElementById('onboard-avatar').value = state.myInfo.avatar;
        document.getElementById('onboard-name').value = state.myInfo.name;
        document.getElementById('onboarding-modal').style.display = 'flex';

        document.getElementById('btn-finish-onboarding').addEventListener('click', () => {
            const avatar = document.getElementById('onboard-avatar').value || '💻';
            const name = document.getElementById('onboard-name').value || 'My PC';

            // Update UI
            document.getElementById('my-name').innerText = name;
            document.getElementById('my-avatar').innerText = avatar;
            document.getElementById('avatar-input').value = avatar;
            document.getElementById('name-input').value = name;

            // Send settings to backend
            window.api.setIdentity(name, avatar);
            window.api.completeOnboarding();

            // Hide modal
            document.getElementById('onboarding-modal').style.display = 'none';
        }, { once: true });
    }

    if (state.myInfo.publicFolder) {
        document.getElementById('active-folder-path').innerText = state.myInfo.publicFolder;
        document.getElementById('active-folder-path').title = state.myInfo.publicFolder;
    }

    if (state.myInfo.downloadFolder) {
        document.getElementById('active-download-path').innerText = state.myInfo.downloadFolder;
        document.getElementById('active-download-path').title = state.myInfo.downloadFolder;
    }

    // 2. Initial List of Devices
    const initialDevices = await window.api.getDevices();
    initialDevices.forEach(d => state.devices.set(d.id, d));
    renderRadarGrid();
    renderGroupSidebar();

    // 3. Listen for Network Changes
    window.api.onDeviceDiscovered((device) => {
        state.devices.set(device.id, device);
        renderRadarGrid();
        renderGroupSidebar();
    });

    window.api.onDeviceLost((device) => {
        state.devices.set(device.id, device); // Update state to offline
        renderRadarGrid();
        renderGroupSidebar();

        if (state.activeChatDevice?.id === device.id) {
            // Clean up connection but don't force them out of the chat UI
            if (state.socketConnections.has(device.id)) {
                state.socketConnections.get(device.id).disconnect();
                state.socketConnections.delete(device.id);
            }
        }

        // If we are currently watching their screen, close the viewer
        if (state.peerConnections.has('viewer')) {
            // Check if the current viewer target is this device (we only have one so it's simple)
            document.getElementById('btn-close-viewer').click();
        }
    });

    // 4. Incoming File Notifications
    window.api.onFileReceived((fileInfo) => {
        console.log('File received!', fileInfo);

        // Play notification sound using Web Audio API
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1); // Slide up to A5

            gainNode.gain.setValueAtTime(0, ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);

            osc.connect(gainNode);
            gainNode.connect(ctx.destination);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
        } catch (e) {
            console.error("Audio playback failed", e);
        }

        // If from active chat device, show it
        if (state.activeChatDevice && state.activeChatDevice.id === fileInfo.sender) {
            addMessageToState(state.activeChatDevice.id, {
                type: 'file',
                senderInfo: 'their',
                file: fileInfo,
                text: `Successfully received file: ${fileInfo.name}`
            });
            renderChatMessages();
        }
    });

    // 5. Transfer Progress
    window.api.onTransferProgress((progress) => {
        // This event fires for incoming transfers.
        // Progress for outgoing is handled locally in the sender loop.
        console.log(`Incoming transfer progress: ${progress.receivedChunks}/${progress.totalChunks}`);
        // We could update the UI here for incoming file progress
    });

    // Periodically re-render radar grid to update 'timeAgo'
    setInterval(renderRadarGrid, 30 * 1000); // Every 30 seconds
}

// ---- UI RENDERING ----

// Helper for relative time
function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `< 1m ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

function renderRadarGrid() {
    devicesGrid.innerHTML = '';
    if (state.devices.size === 0) {
        devicesGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1">
        <div class="radar-pulse"></div>
        <p class="radar-text">Scanning for devices on network...</p>
      </div>
    `;
        return;
    }

    state.devices.forEach(device => {
        // Build an OS specific icon or string if we wanted, but we'll show their custom avatar
        const card = document.createElement('div');
        card.className = 'device-card';

        const osString = device.os === 'win32' ? 'Windows' : device.os === 'darwin' ? 'Mac' : device.os === 'linux' ? 'Linux' : device.os;
        const statusString = device.status === 'offline' ? `Seen ${timeAgo(device.lastSeen)}` : 'Online';

        card.innerHTML = `
      <div class="device-avatar">${device.avatar || '💻'}</div>
      <div class="device-info">
        <div class="device-name">${device.name}</div>
        <div class="device-os">${osString} • ${statusString}</div>
      </div>
      <div style="display: flex; gap: 8px;">
        ${device.isCasting && device.status !== 'offline' ? `<button class="view-screen-btn" style="background: var(--accent); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;" onclick="event.stopPropagation(); window.startViewingScreen('${device.id}')">📺 View</button>` : ''}
        <div class="device-action">▶</div>
      </div>
    `;
        // Grey out if offline (preview for the next phase, though we haven't implemented offline state fully yet)
        if (device.status === 'offline') {
            card.style.opacity = '0.5';
            card.querySelector('.device-action').style.display = 'none';
        } else {
            card.onclick = () => openChatWith(device);
        }

        devicesGrid.appendChild(card);
    });
}

function openChatWith(device) {
    state.activeChatDevice = device;
    switchView('chat');
    chatEmptyState.style.display = 'none';
    chatActiveState.style.display = 'flex';
    chatRecipientName.innerText = device.name;

    ensureSocketConnection(device);
    renderChatMessages();
}

function ensureSocketConnection(device) {
    if (!state.socketConnections.has(device.id)) {
        console.log(`Establishing peer connection to ${device.address}:${device.port}`);
        // Connect to their server
        const socket = io(`http://${device.address}:${device.port}`);

        socket.on('connect', () => {
            console.log('Connected to peer!', device.name);
        });

        // Handle messages THEY send US (since they broadcast to sockets)
        // Actually, in LanServer, we send messages over IPC when received.
        // If they connect to our socket and send, our IPC handles it. Wait, when they send a message to US,
        // they send it via our Express server or Socket.
        // Let's use pure HTTP for sending text and files to them to keep it simple!
        // We don't need socket.io for client sending, we could just `fetch` to their IP.
        // But since server.js uses Socket.IO, let's keep socket connections for real time text.
        state.socketConnections.set(device.id, socket);
    }
}

// Handle incoming chat over IPC from our local server
window.api?.onChatMessage((msgObj) => {
    console.log('[Renderer] Raw chat message rx:', msgObj);
    try {
        const data = JSON.parse(msgObj);
        console.log('[Renderer] Parsed chat message:', data);
        addMessageToState(data.senderId, {
            type: 'text',
            senderInfo: 'their',
            text: data.text
        });
        // Find the sender's device name
        const senderDevice = state.devices.get(data.senderId);
        const senderName = senderDevice ? senderDevice.name : 'Someone';

        if (state.activeChatDevice?.id === data.senderId && document.getElementById('view-chat').classList.contains('view-active')) {
            renderChatMessages();
        } else {
            // Not looking at the chat right now, alert the user!
            const audio = new Audio('./chime.mp3');
            audio.play().catch(e => console.log('Audio play error:', e));

            new Notification(`Message from ${senderName}`, {
                body: data.text.length > 50 ? data.text.substring(0, 50) + '...' : data.text
            });

            document.getElementById('radar-btn')?.classList.add('pulse'); // small visual indicator
        }
    } catch (e) {
        console.error('[Renderer] Failed to parse message', e);
    }
});

function addMessageToState(deviceId, msg) {
    if (!state.messages.has(deviceId)) {
        state.messages.set(deviceId, []);
    }
    state.messages.get(deviceId).push(msg);
}

function renderChatMessages() {
    chatMessages.innerHTML = '';
    const deviceId = state.activeChatDevice.id;
    const msgs = state.messages.get(deviceId) || [];

    msgs.forEach(msg => {
        const div = document.createElement('div');
        div.className = `message ${msg.senderInfo === 'my' ? 'sent' : 'received'}`;

        if (msg.type === 'text') {
            div.innerText = msg.text;
        } else if (msg.type === 'file') {
            div.innerHTML = `
        <div>${msg.text}</div>
        <div class="message-file">
          <div class="message-file-icon">📄</div>
          <div class="message-file-info">
            <span class="message-file-name">${msg.file.name}</span>
            <span class="message-file-size">${(msg.file.size / 1024 / 1024).toFixed(2)} MB</span>
          </div>
        </div>
      `;
        } else if (msg.type === 'transfer') {
            // Dynamic Transfer Box
            const isPaused = msg.status === 'paused';
            const isCancelled = msg.status === 'cancelled';
            const isDone = msg.status === 'completed';

            let statusText = `${Math.floor(msg.progress)}%`;
            if (isPaused) statusText = 'Paused';
            if (isCancelled) statusText = 'Cancelled';
            if (isDone) statusText = 'Completed ✓';

            div.innerHTML = `
        <div style="margin-bottom: 8px;">Sending file...</div>
        <div class="transfer-box" style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 12px; min-width: 250px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <strong style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${msg.file.name}</strong>
            <span style="font-size: 0.8rem; opacity: 0.8;">${statusText}</span>
          </div>
          
          ${(!isDone && !isCancelled && msg.speeds && msg.speeds.length > 0) ? renderGraph(msg.speeds) : ''}
          
          <div style="height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 12px;">
            <div style="height: 100%; width: ${msg.progress}%; background: ${isDone ? 'var(--success)' : 'var(--accent)'}; transition: width 0.3s ease;"></div>
          </div>
          
          ${!isDone && !isCancelled ? `
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button onclick="window.toggleTransfer('${deviceId}', '${msg.id}')" style="padding: 4px 12px; border-radius: 4px; border: none; background: rgba(255,255,255,0.1); color: white; cursor: pointer; font-size: 0.8rem;">
                ${isPaused ? 'Resume' : 'Pause'}
              </button>
              <button onclick="window.cancelTransfer('${deviceId}', '${msg.id}')" style="padding: 4px 12px; border-radius: 4px; border: none; background: var(--danger); color: white; cursor: pointer; font-size: 0.8rem;">
                Cancel
              </button>
            </div>
          ` : ''}
        </div>
      `;
        }
        chatMessages.appendChild(div);
    });

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Chat Sending Logic
btnSend.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (!text || !state.activeChatDevice) return;

    // Connect to their Socket server and emit
    const socket = state.socketConnections.get(state.activeChatDevice.id);
    if (socket) {
        console.log(`[Renderer] Emitting message to socket for ${state.activeChatDevice.id}`);
        socket.emit('message', JSON.stringify({
            senderId: state.myInfo.id,
            text: text
        }));

        // Add to my own view
        addMessageToState(state.activeChatDevice.id, {
            type: 'text',
            senderInfo: 'my',
            text: text
        });
        renderChatMessages();
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSend.click();
});

// File Upload Logic (Ultra Fast Multi-Threaded Chunker)
btnAttach.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !state.activeChatDevice) return;

    // Clean up input
    e.target.value = '';

    await initiateTransfer(file, state.activeChatDevice);
});

async function initiateTransfer(file, device) {
    const fileId = `${state.myInfo.id}-${Date.now()}-${file.size}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Clean up input
    e.target.value = '';

    // Initialize UI message
    const msgObj = {
        id: fileId,
        type: 'transfer',
        senderInfo: 'my',
        file: { name: file.name, size: file.size },
        progress: 0,
        status: 'uploading'
    };
    addMessageToState(device.id, msgObj);
    if (state.activeChatDevice && state.activeChatDevice.id === device.id) {
        renderChatMessages();
    }

    // State tracker for this transfer
    state.activeTransfers.set(fileId, {
        file,
        deviceId: device.id,
        devicePort: device.port,
        deviceAddress: device.address,
        totalChunks,
        sentChunks: new Set(),
        isPaused: false,
        cancel: false,
        speeds: [], // Array to store last 20 speed readings (MB/s) for the graph
        lastSentBytes: 0,
        lastSpeedCheck: Date.now()
    });

    startChunkedTransfer(fileId);
}

async function startChunkedTransfer(fileId) {
    const transfer = state.activeTransfers.get(fileId);
    if (!transfer) return;

    const { file, deviceAddress, devicePort, totalChunks } = transfer;

    // 1. Check if we are resuming (fetch status from receiver)
    try {
        const res = await fetch(`http://${deviceAddress}:${devicePort}/upload/status/${fileId}`);
        if (res.ok) {
            const data = await res.json();
            if (data.receivedChunks) {
                data.receivedChunks.forEach(idx => transfer.sentChunks.add(idx));
            }
        }
    } catch (e) {
        console.log("Could not fetch remote status, assuming fresh start");
    }

    // 2. Identify missing chunks
    const pendingIndices = [];
    for (let i = 0; i < totalChunks; i++) {
        if (!transfer.sentChunks.has(i)) {
            pendingIndices.push(i);
        }
    }

    updateTransferMessageUI(transfer.deviceId, fileId, transfer.sentChunks.size, totalChunks);

    // 3. Worker Pool for parallel uploads
    const pool = [];
    let index = 0;

    const worker = async () => {
        while (index < pendingIndices.length && !transfer.isPaused && !transfer.cancel) {
            const chunkIndex = pendingIndices[index++];
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            const startTime = Date.now();

            const formData = new FormData();
            formData.append('chunk', chunk, 'chunk.bin');
            formData.append('meta', JSON.stringify({
                fileId: fileId,
                fileName: file.name,
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                senderId: state.myInfo.id,
                totalSize: file.size
            }));

            try {
                const response = await fetch(`http://${deviceAddress}:${devicePort}/upload/chunk`, {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    transfer.sentChunks.add(chunkIndex);

                    // Throttling logic & Speed calculation
                    const now = Date.now();
                    const dt = (now - startTime) / 1000;

                    if (throttleLimitMBps > 0) {
                        const targetTime = (CHUNK_SIZE / 1024 / 1024) / throttleLimitMBps;
                        if (dt < targetTime) {
                            await new Promise(r => setTimeout(r, (targetTime - dt) * 1000));
                        }
                    }

                    updateTransferMessageUI(transfer.deviceId, fileId, transfer.sentChunks.size, totalChunks, transfer);
                } else {
                    // If a chunk fails, put it back in the queue
                    pendingIndices.push(chunkIndex);
                }
            } catch (err) {
                console.error("Chunk failed", err);
                pendingIndices.push(chunkIndex);

                // Add a small delay on error to prevent slamming
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    };

    // Launch parallel workers
    for (let i = 0; i < Math.min(MAX_CONCURRENT_UPLOADS, pendingIndices.length); i++) {
        pool.push(worker());
    }

    await Promise.all(pool);

    if (transfer.cancel) {
        state.activeTransfers.delete(fileId);
        markTransferMessageUI(transfer.deviceId, fileId, 'cancelled');
    } else if (!transfer.isPaused && transfer.sentChunks.size === totalChunks) {
        state.activeTransfers.delete(fileId);
        markTransferMessageUI(transfer.deviceId, fileId, 'completed');
    }
}

// UI Updating Hooks
let speedInterval = setInterval(() => {
    calculateSpeeds();
    renderRadarGrid(); // Periodically update the "time ago" texts
}, 1000);

function calculateSpeeds() {
    state.activeTransfers.forEach((transfer, fileId) => {
        if (transfer.isPaused || transfer.cancel) return;

        const now = Date.now();
        const dt = (now - transfer.lastSpeedCheck) / 1000;
        const currentBytes = transfer.sentChunks.size * CHUNK_SIZE;
        const sentDiff = currentBytes - transfer.lastSentBytes;

        let speedMBps = 0;
        if (dt > 0) {
            speedMBps = (sentDiff / 1024 / 1024) / dt;
        }

        // Keep last 20 readings
        transfer.speeds.push(speedMBps);
        if (transfer.speeds.length > 20) transfer.speeds.shift();

        transfer.lastSentBytes = currentBytes;
        transfer.lastSpeedCheck = now;

        updateTransferMessageUI(transfer.deviceId, fileId, transfer.sentChunks.size, transfer.totalChunks, transfer);
    });
}

function updateTransferMessageUI(deviceId, fileId, sent, total, transfer) {
    const msgs = state.messages.get(deviceId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === fileId);
    if (msg) {
        msg.progress = Math.round((sent / total) * 100);
        if (transfer) msg.speeds = transfer.speeds;
        renderChatMessages();
    }
}

function markTransferMessageUI(deviceId, fileId, status) {
    const msgs = state.messages.get(deviceId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === fileId);
    if (msg) {
        msg.status = status;
        msg.progress = status === 'completed' ? 100 : msg.progress;
        renderChatMessages();
    }
}

// Global pause/resume handlers attached to window
window.toggleTransfer = (deviceId, fileId) => {
    const transfer = state.activeTransfers.get(fileId);
    if (transfer) {
        transfer.isPaused = !transfer.isPaused;
        if (!transfer.isPaused) {
            startChunkedTransfer(fileId); // Resume
        }

        // Update UI status text
        const msgs = state.messages.get(deviceId);
        const msg = msgs.find(m => m.id === fileId);
        if (msg) {
            msg.status = transfer.isPaused ? 'paused' : 'uploading';
            renderChatMessages();
        }
    }
};

window.cancelTransfer = (deviceId, fileId) => {
    const transfer = state.activeTransfers.get(fileId);
    if (transfer) {
        transfer.cancel = true;
    }
};


// ---- PUBLIC GROUPS ----

function renderGroupSidebar() {
    groupDevicesList.innerHTML = '';
    if (state.devices.size === 0) {
        groupDevicesList.innerHTML = '<p class="muted">No devices on network.</p>';
        return;
    }

    state.devices.forEach(device => {
        const item = document.createElement('div');
        item.className = 'group-folder-item';
        item.innerHTML = `
      <div class="icon">📁</div>
      <span>${device.name}</span>
    `;
        item.onclick = () => loadPublicFolder(device);
        groupDevicesList.appendChild(item);
    });
}

async function loadPublicFolder(device) {
    state.activeGroupDevice = device;
    groupFilesList.innerHTML = '<div class="muted">Loading files...</div>';

    try {
        const response = await fetch(`http://${device.address}:${device.port}/public-files`);
        if (!response.ok) {
            if (response.status === 403) {
                groupFilesList.innerHTML = `
          <div class="empty-state">
            <div class="icon">🔒</div>
            <h2>Private</h2>
            <p>${device.name} has not enabled Public Sharing.</p>
          </div>`;
            } else {
                throw new Error();
            }
            return;
        }

        const files = await response.json();
        if (files.length === 0) {
            groupFilesList.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <h2>Folder is empty</h2>
        </div>`;
            return;
        }

        let html = '<div class="files-grid">';
        files.forEach(file => {
            // In a real app we'd link to download endpoint. For now, just show visually
            html += `
        <div class="file-card" onclick="window.open('http://${device.address}:${device.port}/public/${file}', '_blank')">
          <div class="icon">📄</div>
          <div class="name">${file}</div>
        </div>
      `;
        });
        html += '</div>';
        groupFilesList.innerHTML = html;

    } catch (e) {
        groupFilesList.innerHTML = `<div class="muted">Failed to connect to ${device.name}</div>`;
    }
}

// Nav Logic
function switchView(viewName) {
    document.querySelectorAll('.main-view').forEach(v => v.classList.remove('view-active'));
    document.getElementById(`view-${viewName}`).classList.add('view-active');

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });
}

document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', (e) => switchView(e.target.dataset.view));
});

// Settings Toggle Local State
const publicFolderToggle = document.getElementById('public-folder-toggle');
const btnSelectFolder = document.getElementById('btn-select-folder');
const btnSelectDownload = document.getElementById('btn-select-download');

publicFolderToggle?.addEventListener('change', (e) => {
    if (window.api) {
        window.api.setPublicFolder(e.target.checked, state.customPublicDir);
    }
});

btnSelectFolder?.addEventListener('click', async () => {
    if (window.api) {
        const selectedPath = await window.api.selectFolder();
        if (selectedPath) {
            state.customPublicDir = selectedPath;
            btnSelectFolder.innerText = 'Folder Selected ✓';

            const pathDisplay = document.getElementById('active-folder-path');
            if (pathDisplay) {
                pathDisplay.innerText = selectedPath;
                pathDisplay.title = selectedPath;
            }

            // Auto-update server if toggle is already on
            if (publicFolderToggle.checked) {
                window.api.setPublicFolder(true, selectedPath);
            }
        }
    }
});

btnSelectDownload?.addEventListener('click', async () => {
    if (window.api) {
        const selectedPath = await window.api.selectFolder();
        if (selectedPath) {
            window.api.setDownloadFolder(selectedPath);
            btnSelectDownload.innerText = 'Folder Selected ✓';

            const pathDisplay = document.getElementById('active-download-path');
            if (pathDisplay) {
                pathDisplay.innerText = selectedPath;
                pathDisplay.title = selectedPath;
            }
        }
    }
});

// Identity Save Logic
const btnSaveIdentity = document.getElementById('btn-save-identity');
const avatarInput = document.getElementById('avatar-input');
const nameInput = document.getElementById('name-input');

btnSaveIdentity?.addEventListener('click', () => {
    if (window.api) {
        const newName = nameInput.value.trim();
        const newAvatar = avatarInput.value.trim();

        if (newName && newAvatar) {
            window.api.setIdentity(newName, newAvatar);

            // Update local UI
            state.myInfo.name = newName;
            state.myInfo.avatar = newAvatar;
            document.getElementById('my-name').innerText = newName;
            document.getElementById('my-avatar').innerText = newAvatar;

            btnSaveIdentity.innerText = 'Saved ✓';
            setTimeout(() => { btnSaveIdentity.innerText = 'Update Identity'; }, 2000);
        }
    }
});


// Throttle Slider
const throttleSlider = document.getElementById('throttle-slider');
const throttleValue = document.getElementById('throttle-value');

throttleSlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (val === 0) {
        throttleLimitMBps = 0;
        throttleValue.innerText = 'Unlim';
    } else {
        throttleLimitMBps = val;
        throttleValue.innerText = `${val} MB/s`;
    }
});

// Graph Renderer
function renderGraph(speeds = []) {
    if (speeds.length < 2) return '';

    const maxSpeed = Math.max(...speeds, 1); // Minimum 1MB/s scale
    const width = 200;
    const height = 40;
    const ptDist = width / (speeds.length - 1);

    let path = `M 0 ${height}`;
    speeds.forEach((s, i) => {
        const x = i * ptDist;
        const y = height - ((s / maxSpeed) * height * 0.9); // 0.9 padding
        path += ` L ${x} ${y}`;
    });
    // Close path for fill
    path += ` L ${width} ${height} Z`;

    let strokePath = `M 0 ${height - ((speeds[0] / maxSpeed) * height * 0.9)}`;
    speeds.forEach((s, i) => {
        if (i === 0) return;
        const x = i * ptDist;
        const y = height - ((s / maxSpeed) * height * 0.9);
        strokePath += ` L ${x} ${y}`;
    });

    return `
      <div style="position: relative; width: 100%; height: ${height}px; margin-bottom: 8px; overflow: hidden; border-radius: 4px; background: rgba(0,0,0,0.3);">
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.5" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d="${path}" fill="url(#grad)" />
          <path d="${strokePath}" fill="none" stroke="var(--accent)" stroke-width="2" />
        </svg>
        <div style="position: absolute; top: 2px; right: 4px; font-size: 0.7rem; opacity: 0.8;">
           ${speeds[speeds.length - 1].toFixed(1)} MB/s
        </div>
      </div>
    `;
}

// -----------------------------------------------------
// ZERO FRICTION UX: Drag & Drop and Global Pasting
// -----------------------------------------------------

const dropOverlay = document.getElementById('drop-overlay');
const deviceSelectModal = document.getElementById('device-select-modal');
const modalDeviceList = document.getElementById('modal-device-list');
const btnCloseModal = document.getElementById('btn-close-modal');

let dragCounter = 0; // Needed to handle child nodes firing dragleave
let pendingFileToShare = null;

// Show overlay when dragging into window
window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        dropOverlay.style.display = 'flex';
    }
});

window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        dropOverlay.style.display = 'none';
    }
});

// Required to allow dropping
window.addEventListener('dragover', (e) => {
    e.preventDefault();
});

// Handle the actual drop
window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.style.display = 'none';

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        handleGlobalFileIntent(file);
    }
});

// Central routing for any globally dragged or pasted file
function handleGlobalFileIntent(file) {
    if (state.activeChatDevice) {
        // We are already in a chat, send it immediately! (Zero Friction)
        initiateTransfer(file, state.activeChatDevice);
    } else {
        // We are not in a chat, ask where to send it
        showDeviceSelectModal(file);
    }
}

// Device Selection Modal Logic
function showDeviceSelectModal(file) {
    if (state.devices.size === 0) {
        alert("No devices found on the network yet.");
        return;
    }

    pendingFileToShare = file;
    modalDeviceList.innerHTML = '';

    state.devices.forEach(device => {
        // Skip ourselves
        if (device.id === state.myInfo.id) return;

        const btn = document.createElement('button');
        btn.style.cssText = `
            padding: 12px;
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text);
            cursor: pointer;
            text-align: left;
            display: flex;
            align-items: center;
            gap: 12px;
            transition: background 0.2s;
        `;
        btn.innerHTML = `
            <div class="device-icon" style="width: 32px; height: 32px;"></div>
            <div>
                <div style="font-weight: 500;">${device.name || 'Unknown Device'}</div>
                <div class="muted" style="font-size: 0.8rem;">${device.id.substring(0, 10)}...</div>
            </div>
        `;

        btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,0.1)';
        btn.onmouseout = () => btn.style.background = 'rgba(255,255,255,0.05)';

        btn.onclick = () => {
            deviceSelectModal.style.display = 'none';
            // Switch to their chat view organically
            document.querySelector(`.device-card[data-id="${device.id}"]`)?.click();
            // Start transfer
            initiateTransfer(pendingFileToShare, device);
            pendingFileToShare = null;
        };

        modalDeviceList.appendChild(btn);
    });

    if (modalDeviceList.children.length === 0) {
        modalDeviceList.innerHTML = '<div class="muted">No other devices available.</div>';
    }

    deviceSelectModal.style.display = 'flex';
}

btnCloseModal.addEventListener('click', () => {
    deviceSelectModal.style.display = 'none';
    pendingFileToShare = null;
});

// Clipboard Paste Support
window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let pastedFile = null;

    for (const index in items) {
        const item = items[index];
        if (item.kind === 'file') {
            const blob = item.getAsFile();
            if (blob) {
                // If it's an image without a real name (e.g. from print screen), name it
                let name = blob.name;
                if (!name || name === 'image.png') {
                    name = `Pasted-Image-${Date.now()}.png`;
                }

                // Reconstruct a File object to ensure name and lastModified are set properly
                pastedFile = new File([blob], name, { type: blob.type });
                break; // Just grab the first file
            }
        }
    }

    if (pastedFile) {
        handleGlobalFileIntent(pastedFile);
    }
});

// Start Engine
initApp();

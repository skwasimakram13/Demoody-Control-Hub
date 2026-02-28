import { Server as SocketIOServer } from 'socket.io'
import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs'
import os from 'os'
import multer from 'multer'

export class LanServer {
    constructor(port = 0, onMessage, onFileReceived, onTransferProgress, onWebRTCSignal) {
        this.app = express()
        this.server = http.createServer(this.app)
        this.io = new SocketIOServer(this.server, {
            cors: { origin: '*' }
        })

        this.port = port
        this.onMessage = onMessage
        this.onFileReceived = onFileReceived
        this.onTransferProgress = onTransferProgress
        this.onWebRTCSignal = onWebRTCSignal

        // Setup file storage directory
        this.downloadDir = path.join(os.homedir(), 'Downloads', 'LAN_Share')
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true })
        }

        // Public folder for sharing
        this.publicDir = path.join(os.homedir(), 'LAN_Public')
        if (!fs.existsSync(this.publicDir)) {
            fs.mkdirSync(this.publicDir, { recursive: true })
        }

        // Temp directory for chunk storage
        this.tempDir = path.join(os.tmpdir(), 'LAN_Share_Chunks')
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true })
        }

        // In-memory tracker for active transfers: fileId -> { totalChunks, receivedChunks: Set }
        this.activeTransfers = new Map()

        this.isPublicFolderEnabled = false

        this.setupRoutes()
        this.setupSockets()

        // Cleanup abandoned chunks every hour
        this.cleanupInterval = setInterval(() => {
            this.cleanupAbandonedTransfers()
        }, 1000 * 60 * 60)
    }

    setupRoutes() {
        this.app.use(express.json())

        // Global CORS Middleware for fetch requests from renderer
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });

        // Middleware to block public folder access if not enabled
        this.app.use('/public', (req, res, next) => {
            if (!this.isPublicFolderEnabled) {
                return res.status(403).json({ error: 'Public folder is not enabled on this device.' })
            }
            // Dynamically serve from the currently active directory
            const activeDir = this.customPublicDir || this.publicDir;
            const requestedFile = path.join(activeDir, req.url);

            // Basic security check to prevent directory traversal
            if (!requestedFile.startsWith(activeDir)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            res.sendFile(requestedFile, (err) => {
                if (err) {
                    res.status(404).json({ error: 'File not found' });
                }
            });
        })

        // New Endpoint for Chunked Uploads
        const upload = multer({ dest: path.join(os.tmpdir(), 'lanshare_uploads') })

        // Check status of a transfer (for resuming)
        this.app.get('/upload/status/:fileId', (req, res) => {
            const { fileId } = req.params;
            const transfer = this.activeTransfers.get(fileId);
            if (!transfer) {
                return res.json({ status: 'unknown', receivedChunks: [] });
            }
            res.json({
                status: 'active',
                receivedChunks: Array.from(transfer.receivedChunks)
            });
        });

        // Receive a specific chunk
        this.app.post('/upload/chunk', upload.single('chunk'), async (req, res) => {
            const file = req.file;
            const meta = JSON.parse(req.body.meta || '{}');

            /* meta expected: {
               fileId: string, 
               fileName: string,
               chunkIndex: number, 
               totalChunks: number,
               senderId: string,
               totalSize: number
            } */

            if (!file || !meta.fileId) {
                return res.status(400).json({ error: 'Missing chunk or metadata' });
            }

            // Initialize tracker if missing
            if (!this.activeTransfers.has(meta.fileId)) {
                this.activeTransfers.set(meta.fileId, {
                    totalChunks: meta.totalChunks,
                    receivedChunks: new Set(),
                    fileName: meta.fileName,
                    totalSize: meta.totalSize,
                    senderId: meta.senderId,
                    lastActive: Date.now()
                });

                // Ensure dedicated temp folder for this file
                const fileTempDir = path.join(this.tempDir, meta.fileId);
                if (!fs.existsSync(fileTempDir)) fs.mkdirSync(fileTempDir, { recursive: true });
            }

            const transfer = this.activeTransfers.get(meta.fileId);
            transfer.lastActive = Date.now();

            const chunkPath = path.join(this.tempDir, meta.fileId, `${meta.chunkIndex}.chunk`);

            // Move temp multer file to specific chunk path
            try {
                await fs.promises.rename(file.path, chunkPath);
                transfer.receivedChunks.add(meta.chunkIndex);

                // Notify UI about progress
                if (this.onTransferProgress) {
                    this.onTransferProgress({
                        fileId: meta.fileId,
                        receivedChunks: transfer.receivedChunks.size,
                        totalChunks: transfer.totalChunks
                    });
                }

                // Check if finished
                if (transfer.receivedChunks.size === transfer.totalChunks && !transfer.isMerging) {
                    transfer.isMerging = true; // Lock it against parallel chunks finishing at exactly the same time
                    const activeDownloadDir = this.customDownloadDir || this.downloadDir;

                    // Secure filename + avoid collisions
                    const finalPath = await this.getUniqueFilePath(activeDownloadDir, meta.fileName);

                    await this.mergeChunks(meta.fileId, transfer.totalChunks, finalPath);

                    if (this.onFileReceived) {
                        this.onFileReceived({
                            name: path.basename(finalPath),
                            size: transfer.totalSize,
                            path: finalPath,
                            sender: transfer.senderId
                        });
                    }

                    // Clean up memory and temp dir
                    this.activeTransfers.delete(meta.fileId);
                    await fs.promises.rm(path.join(this.tempDir, meta.fileId), { recursive: true, force: true }).catch(() => { });

                    return res.json({ success: true, status: 'completed' });
                }

                res.json({ success: true, status: 'uploading' });

            } catch (err) {
                console.error('Error saving chunk', err);
                return res.status(500).json({ error: 'Chunk save failed' });
            }
        });

        // Endpoint for receiving files (1-to-1)
        // const upload = multer({ dest: path.join(os.tmpdir(), 'lanshare_uploads') }) // This line was moved up

        this.app.post('/upload', upload.single('file'), async (req, res) => {
            const file = req.file
            const meta = JSON.parse(req.body.meta || '{}')

            if (!file) {
                return res.status(400).json({ error: 'No file uploaded' })
            }

            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8')
            const activeDownloadDir = this.customDownloadDir || this.downloadDir;

            // Secure filename + avoid collisions
            const targetPath = await this.getUniqueFilePath(activeDownloadDir, originalName)

            fs.rename(file.path, targetPath, (err) => {
                if (err) {
                    console.error('Failed to move uploaded file', err)
                    return res.status(500).json({ error: 'Failed to process file' })
                }

                if (this.onFileReceived) {
                    this.onFileReceived({
                        name: path.basename(targetPath),
                        size: file.size,
                        path: targetPath,
                        sender: meta.senderId
                    })
                }

                res.status(200).json({ success: true, path: targetPath })
            })
        })

        // Endpoint to list public files
        this.app.get('/public-files', (req, res) => {
            if (!this.isPublicFolderEnabled) {
                return res.status(403).json({ error: 'Public folder is not enabled' })
            }

            const activeDir = this.customPublicDir || this.publicDir

            fs.readdir(activeDir, (err, files) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to read directory' })
                }
                res.json(files)
            })
        })
    }

    setupSockets() {
        this.io.on('connection', (socket) => {
            console.log(`Socket client connected: ${socket.id}`)

            socket.on('message', (data) => {
                console.log(`[LANServer] Received raw message: ${data}`);
                if (this.onMessage) {
                    this.onMessage(data)
                }
            })

            // WebRTC Signaling Relays
            socket.on('webrtc-offer', (data) => {
                if (this.onWebRTCSignal) this.onWebRTCSignal('webrtc-offer', data, socket.id)
            })

            socket.on('webrtc-answer', (data) => {
                if (this.onWebRTCSignal) this.onWebRTCSignal('webrtc-answer', data)
            })

            socket.on('webrtc-ice-candidate', (data) => {
                if (this.onWebRTCSignal) this.onWebRTCSignal('webrtc-ice-candidate', data, socket.id)
            })

            socket.on('disconnect', () => {
                console.log(`Socket client disconnected: ${socket.id}`)
            })
        })
    }

    setPublicFolderAccess(enabled, customPath) {
        this.isPublicFolderEnabled = enabled;
        if (customPath) {
            this.customPublicDir = customPath;
            console.log('Public folder updated to:', customPath);
        }
    }

    setDownloadFolder(customPath) {
        if (customPath) {
            this.customDownloadDir = customPath;
            console.log('Download folder updated to:', customPath);
        }
    }

    async mergeChunks(fileId, totalChunks, outputPath) {
        console.log(`Merging ${totalChunks} chunks into ${outputPath}`);
        const writeStream = fs.createWriteStream(outputPath);

        for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(this.tempDir, fileId, `${i}.chunk`);
            const data = await fs.promises.readFile(chunkPath);
            writeStream.write(data);
        }

        return new Promise((resolve, reject) => {
            writeStream.end();
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    async cleanupAbandonedTransfers() {
        const threshold = Date.now() - (1000 * 60 * 60 * 2); // 2 hours
        for (const [fileId, transfer] of this.activeTransfers.entries()) {
            if (transfer.lastActive < threshold) {
                console.log(`Cleaning up abandoned transfer: ${fileId}`);
                this.activeTransfers.delete(fileId);
                const fileTempDir = path.join(this.tempDir, fileId);
                if (fs.existsSync(fileTempDir)) {
                    await fs.promises.rm(fileTempDir, { recursive: true, force: true }).catch(() => { });
                }
            }
        }
    }

    async getUniqueFilePath(dir, originalName) {
        // Prevent directory traversal attacks by forcing it to just the base filename
        // We replace slashes just to be absolutely certain it doesn't try escaping
        let baseName = path.basename(originalName.replace(/\\/g, '/'));

        // Strip out any weird unprintable chars just in case
        baseName = baseName.replace(/[\0\/\\:\*\?\"<>\|]/g, '_')

        if (!baseName || baseName === '..') {
            baseName = `file_${Date.now()}.bin`;
        }

        let targetPath = path.join(dir, baseName);
        let counter = 1;

        while (fs.existsSync(targetPath)) {
            const ext = path.extname(baseName);
            const base = path.basename(baseName, ext);
            targetPath = path.join(dir, `${base} (${counter})${ext}`);
            counter++;
        }
        return targetPath;
    }

    start() {
        return new Promise((resolve) => {
            this.server.listen(this.port, '0.0.0.0', () => {
                // Find assigned port if port 0 was passed
                const address = this.server.address()
                this.port = address.port
                console.log(`LAN Server listening on port ${this.port}`)
                resolve(this.port)
            })
        })
    }

    stop() {
        this.server.close()
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

import { app, shell, BrowserWindow, ipcMain, dialog, desktopCapturer, Notification, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { DiscoveryService } from './discovery'
import { LanServer } from './server'
import icon from '../../build/icon.png?asset'

let mainWindow = null
let lanServer = null
let discoveryService = null
let tray = null
let isQuitting = false

function getStableHardwareId() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Find the first external MAC address
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                return crypto.createHash('sha256').update(iface.mac).digest('hex').substring(0, 16);
            }
        }
    }
    return crypto.randomUUID(); // Fallback if no valid network interface found
}

let appConfig = {
    deviceId: getStableHardwareId(),
    deviceName: os.hostname(),
    avatar: '💻',
    isFirstLaunch: true
}

function loadConfig() {
    const configPath = join(app.getPath('userData'), 'app-config.json')
    if (fs.existsSync(configPath)) {
        try {
            const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'))
            Object.assign(appConfig, stored)
        } catch (e) { }
    } else {
        fs.writeFileSync(configPath, JSON.stringify(appConfig))
    }
}

function saveConfig() {
    const configPath = join(app.getPath('userData'), 'app-config.json')
    fs.writeFileSync(configPath, JSON.stringify(appConfig))
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        show: false,
        icon: icon,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true
        }
    })

    // Hide instead of close to run in background
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault()
            mainWindow.hide()

            // Optionally notify user it's still running
            if (Notification.isSupported()) {
                new Notification({
                    title: 'Demoody Control Hub',
                    body: 'App is still running in the background. Check your system tray.'
                }).show()
            }
        }
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow.show()
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

async function startServices() {
    lanServer = new LanServer(
        0, // Random port
        (msg) => {
            if (mainWindow) mainWindow.webContents.send('chat-message', msg)
        },
        (fileInfo) => {
            if (mainWindow) mainWindow.webContents.send('file-received', fileInfo)

            // Show Native OS Notification
            if (Notification.isSupported()) {
                new Notification({
                    title: 'Demoody Control Hub',
                    body: `Received file: ${fileInfo.name}`
                }).show()
            }
        },
        (progress) => {
            if (mainWindow) mainWindow.webContents.send('transfer-progress', progress)
        }
    )

    // Add explicit listener for WebRTC signaling so main process routes them
    // Actually, LanServer already emits to `mainWindow` directly lines 239-246.
    // So we just need to expose them in preload

    const port = await lanServer.start()

    discoveryService = new DiscoveryService(
        port,
        (device) => {
            if (mainWindow) mainWindow.webContents.send('device-discovered', device)
        },
        (deviceId) => {
            if (mainWindow) mainWindow.webContents.send('device-lost', deviceId)
        },
        appConfig
    )

    discoveryService.start()
}

app.whenReady().then(() => {
    loadConfig()

    // Enable auto-start on boot
    app.setLoginItemSettings({
        openAtLogin: true,
        args: ['--hidden']
    })

    // Setup Auto Updater
    autoUpdater.logger = console;
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
        if (mainWindow) mainWindow.webContents.send('update-message', 'Update available. Downloading...');
    });
    autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('update-message', 'Update downloaded. Restarting...');
        autoUpdater.quitAndInstall();
    });

    electronApp.setAppUserModelId('com.lanshare.app')

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    // IPC handlers
    ipcMain.handle('get-devices', () => {
        return discoveryService ? discoveryService.getDevices() : []
    })

    ipcMain.on('clear-inactive-devices', () => {
        if (discoveryService) {
            discoveryService.clearInactiveDevices()
        }
    })

    ipcMain.on('refresh-devices', () => {
        if (discoveryService) {
            discoveryService.refresh()
        }
    })

    ipcMain.on('set-public-folder', (_, { enabled, path }) => {
        if (lanServer) lanServer.setPublicFolderAccess(enabled, path)
    })

    ipcMain.on('set-download-folder', (_, path) => {
        if (lanServer) lanServer.setDownloadFolder(path)
    })

    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        })
        return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.on('set-identity', (_, { name, avatar }) => {
        if (name) appConfig.deviceName = name;
        if (avatar) appConfig.avatar = avatar;
        saveConfig();

        if (discoveryService) {
            discoveryService.updateIdentity(name, avatar)
        }
    })

    ipcMain.on('complete-onboarding', () => {
        appConfig.isFirstLaunch = false;
        saveConfig();
    })

    ipcMain.on('set-casting-state', (_, isCasting) => {
        if (discoveryService) {
            discoveryService.setCastingState(isCasting)
        }
    })

    // WebRTC signaling routing (Renderer -> Server -> Remote Socket)
    ipcMain.on('send-webrtc-answer', (_, { socketId, data }) => {
        if (lanServer) lanServer.io.to(socketId).emit('webrtc-answer', data)
    })

    ipcMain.on('send-webrtc-ice-candidate', (_, { socketId, data }) => {
        if (lanServer) lanServer.io.to(socketId).emit('webrtc-ice-candidate', data)
    })

    ipcMain.handle('get-desktop-sources', async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        return sources.map(s => ({ id: s.id, name: s.name }))
    })

    ipcMain.handle('get-my-info', () => {
        return {
            id: appConfig.deviceId,
            name: appConfig.deviceName,
            os: discoveryService?.platform,
            avatar: appConfig.avatar,
            isFirstLaunch: appConfig.isFirstLaunch,
            port: lanServer?.port,
            publicFolder: lanServer?.customPublicDir || lanServer?.publicDir,
            downloadFolder: lanServer?.customDownloadDir || lanServer?.downloadDir
        }
    })

    startServices().then(() => {
        if (!process.argv.includes('--hidden')) {
            createWindow()
        } else {
            // If it was auto-started via boot/background, create window but don't show it immediately
            createWindow()
            if (mainWindow) mainWindow.hide()
        }
    })

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // Create Tray
    let trayIcon = nativeImage.createFromPath(icon)
    if (trayIcon.isEmpty()) {
        // Fallback to empty transparent icon if no file exists
        trayIcon = nativeImage.createEmpty()
        trayIcon.resize({ width: 16, height: 16 })
    }
    tray = new Tray(trayIcon)

    // Set context menu
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Demoody Control Hub', click: () => { if (mainWindow) mainWindow.show() } },
        { type: 'separator' },
        {
            label: 'Quit Demoody Control Hub', click: () => {
                isQuitting = true
                app.quit()
            }
        }
    ])

    tray.setToolTip('Demoody Control Hub is running')
    tray.setContextMenu(contextMenu)

    tray.on('double-click', () => {
        if (mainWindow) mainWindow.show()
    })
})

// We no longer quit when windows are closed, because the tray handles it
app.on('window-all-closed', () => {
    // Keep running
})

app.on('before-quit', () => {
    isQuitting = true
})

app.on('quit', () => {
    if (discoveryService) discoveryService.stop()
    if (lanServer) lanServer.stop()
})

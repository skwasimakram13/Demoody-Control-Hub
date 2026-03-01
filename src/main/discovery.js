import os from 'os'
import dgram from 'dgram'

export class DiscoveryService {
    constructor(port, onDeviceFound, onDeviceLost, appConfig) {
        this.port = port
        this.onDeviceFound = onDeviceFound
        this.onDeviceLost = onDeviceLost

        this.appConfig = appConfig
        this.deviceName = appConfig.deviceName
        this.platform = os.platform()
        this.bestIp = this.getBestLocalIp()
        this.avatar = appConfig.avatar
        this.isCasting = false

        this.devices = new Map()

        this.udpPort = 41234; // Dedicated port for Wassu LAN Discovery broadcasts
        this.socket = null;
        this.broadcastInterval = null;
        this.cleanupInterval = null;
    }

    getBestLocalIp() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            // Skip common virtual or hyper-v interfaces
            if (name.toLowerCase().includes('vEthernet') ||
                name.toLowerCase().includes('virtual') ||
                name.toLowerCase().includes('wsl')) continue;

            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return '';
    }

    start() {
        console.log(`Starting UDP discovery service on port ${this.udpPort}`);

        this.socket = dgram.createSocket('udp4');

        this.socket.on('error', (err) => {
            console.error(`Discovery socket error:\n${err.stack}`);
            this.socket.close();
        });

        this.socket.on('message', (msg, rinfo) => {
            try {
                const data = JSON.parse(msg.toString());

                // Ensure it's our protocol
                if (data.type !== 'wassu-discovery') return;

                // Ignore our own broadcasts
                if (data.deviceId === this.appConfig.deviceId) return;

                // Build peer object matching former Bonjour output
                // STRICTLY use rinfo.address, as this is the exact, proven IP the UDP packet arrived from
                // over the Wi-Fi router, completely bypassing any virtual or VPN adapter confusion.
                const physicalOriginIp = rinfo.address;

                const device = {
                    id: data.deviceId,
                    instanceName: data.name,
                    name: data.name || 'Unknown Device',
                    os: data.os || 'unknown',
                    avatar: data.avatar || '💻',
                    isCasting: data.isCasting === true,
                    address: physicalOriginIp,
                    port: data.port,
                    status: 'online',
                    lastSeen: Date.now()
                };

                // Add or update
                const isNew = !this.devices.has(device.id);
                this.devices.set(device.id, device);

                this.onDeviceFound(device);

            } catch (e) {
                // Ignore malformed packets from other local traffic
            }
        });

        this.socket.on('listening', () => {
            this.socket.setBroadcast(true);
            const address = this.socket.address();
            console.log(`Discovery listening on ${address.address}:${address.port}`);

            // Start announcing ourselves
            this.broadcastPresence();
            this.broadcastInterval = setInterval(() => {
                this.broadcastPresence();
            }, 5000); // Heartbeat every 5 seconds

            // Start cleanup sweep for silent devices (timeout after 15 seconds)
            this.cleanupInterval = setInterval(() => {
                this.checkSilentDevices();
            }, 5000);
        });

        // Try binding. It's OK if it fails, meaning another instance is already bound (which shouldn't happen due to single-instance lock)
        try {
            this.socket.bind(this.udpPort);
        } catch (e) {
            console.error("Failed to bind UDP port required for discovery", e);
        }
    }

    broadcastPresence() {
        if (!this.socket) return;

        const payload = JSON.stringify({
            type: 'wassu-discovery',
            deviceId: this.appConfig.deviceId,
            name: this.deviceName,
            os: this.platform,
            // We no longer strictly need bestIp, but keeping it for legacy or future routing checks
            ip: this.bestIp,
            port: this.port,
            avatar: this.avatar,
            isCasting: this.isCasting
        });

        const message = Buffer.from(payload);

        // Broadcast to classic IPv4 broadcast address AND explicitly calculated subnet broadcast addresses
        // Many Wi-Fi routers drop 255.255.255.255 to prevent broadcast storms.
        const broadcastAddresses = new Set(['255.255.255.255']);

        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    // Calculate exact subnet broadcast address e.g. 192.168.1.netmask -> 192.168.1.255
                    const ipParts = iface.address.split('.').map(Number);
                    const maskParts = iface.netmask.split('.').map(Number);

                    if (ipParts.length === 4 && maskParts.length === 4) {
                        const broadcastParts = ipParts.map((ipPart, i) => ipPart | (~maskParts[i] & 255));
                        const subnetBroadcast = broadcastParts.join('.');
                        broadcastAddresses.add(subnetBroadcast);
                    }
                }
            }
        }

        for (const address of broadcastAddresses) {
            try {
                this.socket.send(message, 0, message.length, this.udpPort, address);
            } catch (e) {
                // Ignore temporary network drops for specific subnets
            }
        }
    }

    checkSilentDevices() {
        const now = Date.now();
        for (const [id, dev] of this.devices.entries()) {
            if (dev.status === 'online' && (now - dev.lastSeen) > 15000) {
                console.log(`Device lost (timed out): ${dev.name}`);
                dev.status = 'offline';
                this.devices.set(id, dev);
                if (this.onDeviceLost) {
                    this.onDeviceLost(dev);
                }
            }
        }
    }

    refresh() {
        console.log('Discovery refresh triggered');
        this.broadcastPresence(); // Fire an immediate heartbeat
    }

    getDevices() {
        return Array.from(this.devices.values())
    }

    clearInactiveDevices() {
        for (const [id, dev] of this.devices.entries()) {
            if (dev.status === 'offline') {
                this.devices.delete(id);
                console.log(`Cleared inactive device from memory: ${dev.name}`);
            }
        }
    }

    updateIdentity(name, avatar) {
        if (name) this.deviceName = name;
        if (avatar) this.avatar = avatar;
        this.broadcastPresence(); // Instant update to peers
    }

    setCastingState(isCasting) {
        if (this.isCasting === isCasting) return;
        this.isCasting = isCasting;
        this.broadcastPresence(); // Instant update to peers
    }

    stop() {
        console.log('Stopping discovery service')
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) { }
            this.socket = null;
        }
    }
}

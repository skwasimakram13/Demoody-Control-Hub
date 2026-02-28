import { Bonjour } from 'bonjour-service'
import os from 'os'

export class DiscoveryService {
    constructor(port, onDeviceFound, onDeviceLost, appConfig) {
        this.bonjour = new Bonjour()
        this.port = port
        this.onDeviceFound = onDeviceFound
        this.onDeviceLost = onDeviceLost

        this.appConfig = appConfig
        // mDNS instances must have semi-unique names, but we broadcast the STABLE deviceId within the txt metadata
        this.instanceName = `hub-${this.appConfig.deviceId.substring(0, 8)}-${Math.random().toString(36).substring(2, 6)}`

        this.deviceName = appConfig.deviceName
        this.platform = os.platform()
        this.avatar = appConfig.avatar
        this.isCasting = false

        this.devices = new Map()
        this.service = null
        this.browser = null
    }

    start() {
        console.log(`Starting discovery service as ${this.instanceName} on port ${this.port}`)

        // Broadcast our presence on the LAN
        this.service = this.bonjour.publish({
            name: this.instanceName,
            type: 'wassu',
            port: this.port,
            txt: {
                deviceId: this.appConfig.deviceId,
                name: this.deviceName,
                os: this.platform,
                avatar: this.avatar,
                isCasting: this.isCasting ? 'true' : 'false'
            }
        })

        // Listen for others
        this.browser = this.bonjour.find({ type: 'wassu' })

        this.browser.on('up', (service) => {
            if (service.txt?.deviceId === this.appConfig.deviceId) return // Ignore ourselves

            const deviceId = service.txt?.deviceId || service.name;
            console.log('Found peer:', service.name, service.host)

            let bestAddress = service.host;
            if (service.addresses && service.addresses.length > 0) {
                // Try to find an IPv4 address to avoid IPv6 URL parsing headaches
                const ipv4 = service.addresses.find(ip => ip.includes('.'));
                bestAddress = ipv4 || service.addresses[0];
            }
            // Format for URL interpolation if it is an IPv6 address
            if (bestAddress && bestAddress.includes(':') && !bestAddress.startsWith('[')) {
                bestAddress = `[${bestAddress}]`;
            }

            const device = {
                id: deviceId,
                instanceName: service.name,
                name: service.txt?.name || 'Unknown Device',
                os: service.txt?.os || 'unknown',
                avatar: service.txt?.avatar || '💻',
                isCasting: service.txt?.isCasting === 'true',
                address: bestAddress,
                port: service.port,
                status: 'online',
                lastSeen: Date.now()
            }

            this.devices.set(device.id, device)
            this.onDeviceFound(device)
        })

        this.browser.on('down', (service) => {
            // we must find the device by instanceName
            let foundDevice = null;
            for (const [id, dev] of this.devices.entries()) {
                if (dev.instanceName === service.name) {
                    foundDevice = dev;
                    break;
                }
            }

            if (foundDevice) {
                console.log(`Device lost: ${foundDevice.name}`)
                foundDevice.status = 'offline'
                foundDevice.lastSeen = Date.now()
                this.devices.set(foundDevice.id, foundDevice)

                if (this.onDeviceLost) {
                    this.onDeviceLost(foundDevice)
                }
            }
        })

        // Periodically refresh to catch any delayed devices
        if (!this.refreshInterval) {
            this.refreshInterval = setInterval(() => {
                this.refresh();
            }, 30000);
        }
    }

    refresh() {
        console.log('Discovery refresh triggered');
        if (this.browser && typeof this.browser.update === 'function') {
            this.browser.update();
        } else if (this.browser) {
            this.browser.stop();
            this.browser.start();
        }
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

        if (this.service) {
            // Stop existing broadcast
            this.service.stop(() => {
                // Restart with new txt records
                this.service = this.bonjour.publish({
                    name: this.instanceName,
                    type: 'wassu',
                    port: this.port,
                    txt: {
                        deviceId: this.appConfig.deviceId,
                        name: this.deviceName,
                        os: this.platform,
                        avatar: this.avatar,
                        isCasting: this.isCasting ? 'true' : 'false'
                    }
                });
            });
        }
    }

    setCastingState(isCasting) {
        if (this.isCasting === isCasting) return;
        this.isCasting = isCasting;

        if (this.service) {
            this.service.stop(() => {
                this.service = this.bonjour.publish({
                    name: this.instanceName,
                    type: 'wassu',
                    port: this.port,
                    txt: {
                        deviceId: this.appConfig.deviceId,
                        name: this.deviceName,
                        os: this.platform,
                        avatar: this.avatar,
                        isCasting: this.isCasting ? 'true' : 'false'
                    }
                });
            });
        }
    }

    stop() {
        console.log('Stopping discovery service')
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.service) {
            this.service.stop()
            this.service = null
        }
        if (this.browser) {
            this.browser.stop()
            this.browser = null
        }
        this.bonjour.destroy()
    }
}

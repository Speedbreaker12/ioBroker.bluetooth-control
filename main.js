'use strict';

const utils = require('@iobroker/adapter-core');
const noble = require('@abandonware/noble');

class BluetoothControl extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'bluetooth-control',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // Struktur in config.native.devices:
        // [
        //   {
        //     address: 'xx:xx:xx:xx:xx:xx',
        //     characteristics: [
        //        { serviceUUID: '...', characteristicUUID: '...' },
        //        { ... }
        //     ]
        //   },
        //   ...
        // ]
        this.devicesConfig = this.config.devices || [];
        this.peripherals = new Map(); 
        this.MAX_RETRIES = 30;
        this.isProcessing = false;
        this.isResetting = false;
        this.actionQueue = [];
    }

    async onReady() {
        this.log.info('Adapter gestartet. Konfigurierte Geräte: ' + JSON.stringify(this.devicesConfig));

        // Für jede konfigurierte Characteristic ein State anlegen
        for (const dev of this.devicesConfig) {
            const baseId = `${this.namespace}.${dev.address.replace(/:/g, '_')}`;
            for (const charObj of dev.characteristics) {
                const charId = `${baseId}.${charObj.characteristicUUID}`;
                await this.setObjectNotExistsAsync(charId, {
                    type: 'state',
                    common: {
                        name: `Characteristic ${charObj.characteristicUUID}`,
                        type: 'string',
                        role: 'state',
                        read: true,
                        write: true,
                        desc: `Write hex value to send to ${dev.address}, service:${charObj.serviceUUID}, char:${charObj.characteristicUUID}`
                    },
                    native: {}
                });
                // Default ack = true setzen, damit ein leerer Wert existiert
                const existing = await this.getStateAsync(charId);
                if (!existing) {
                    await this.setStateAsync(charId, { val: '', ack: true });
                }
            }
        }
    }

    onUnload(callback) {
        try {
            for (const info of this.peripherals.values()) {
                if (info.peripheral && info.peripheral.disconnect) {
                    info.peripheral.disconnect();
                }
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            switch (obj.command) {
                case 'scan':
                    this.log.info('Starte BLE-Scan auf Anfrage aus Admin...');
                    this.scanForDevices(obj);
                    break;
                case 'discover':
                    if (obj.message.address) {
                        this.log.info('Service/Characteristic-Discovery für: ' + obj.message.address);
                        this.discoverDeviceDetails(obj.message.address, obj.from, obj.callback);
                    }
                    break;
                case 'saveDeviceConfig':
                    if (obj.message.devices && Array.isArray(obj.message.devices)) {
                        this.log.info('Speichere neue Geräte-Konfiguration...');
                        this.updateDeviceConfig(obj.message.devices, obj.from, obj.callback);
                    }
                    break;
                default:
                    this.log.warn('Unbekannter command: ' + obj.command);
                    if (obj.callback) this.sendTo(obj.from, obj.command, {error: 'Unknown command'}, obj.callback);
                    break;
            }
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || this.isResetting) return;
        // Charakteristik-Werte sind string (Hex)
        // Finde das zugehörige Gerät und Charakteristik
        const info = this.getDeviceCharacteristicFromId(id);
        if (!info) return;
        const { address, serviceUUID, characteristicUUID } = info;

        const oldState = await this.getStateAsync(id);
        const oldValue = oldState && oldState.val !== undefined ? oldState.val : '';

        // Neuer Wert ist state.val (String)
        const newValue = state.val;
        // HEX-Check (optional)
        const hexRegex = /^[0-9A-Fa-f]*$/;
        if (newValue && !hexRegex.test(newValue.replace(/\s+/g, ''))) {
            this.log.warn(`Der eingegebene Wert für ${id} ist kein gültiger Hex-String.`);
            // Zurücksetzen auf alten Wert
            this.isResetting = true;
            await this.setStateAsync(id, { val: oldValue, ack: true });
            this.isResetting = false;
            return;
        }

        this.actionQueue.push({
            address,
            serviceUUID,
            characteristicUUID,
            valueHex: newValue,
            oldValue: oldValue,
            datapoint: id
        });

        await this.processQueue();
    }

    getDeviceCharacteristicFromId(id) {
        // id hat Format: adapter.instance.MAC_with_underscores.CHAR_UUID
        // devicesConfig liefert uns die Info
        const parts = id.split('.');
        if (parts.length < 4) return null;
        const macPart = parts[2]; 
        const charUUID = parts[3];

        const address = macPart.replace(/_/g, ':').toLowerCase();
        const dev = this.devicesConfig.find(d => d.address.toLowerCase() === address);
        if (!dev) return null;

        const charObj = dev.characteristics.find(c => c.characteristicUUID.toLowerCase() === charUUID.toLowerCase());
        if (!charObj) return null;

        return {
            address,
            serviceUUID: charObj.serviceUUID,
            characteristicUUID: charObj.characteristicUUID
        };
    }

    async processQueue() {
        if (this.isProcessing) {
            this.log.info('Warteschlange wird bereits verarbeitet.');
            return;
        }

        if (this.actionQueue.length === 0) {
            this.log.info('Warteschlange ist leer.');
            return;
        }

        this.isProcessing = true;
        this.log.info(`Starte Verarbeitung der Warteschlange (Aktuell: ${this.actionQueue.length} Aktionen)...`);

        while (this.actionQueue.length > 0) {
            const current = this.actionQueue[0];
            const { address, serviceUUID, characteristicUUID, valueHex, oldValue, datapoint } = current;

            try {
                await this.writeValueWithRetries(address, serviceUUID, characteristicUUID, valueHex, oldValue, datapoint);
                this.log.info(`Wert erfolgreich an ${address} geschrieben: ${valueHex}`);
            } catch (error) {
                this.log.error(`Fehler bei der Aktion an ${address}/${characteristicUUID}: ${error}`);
            } finally {
                this.actionQueue.shift();
                this.log.info(`Verbleibende Aktionen: ${this.actionQueue.length}`);
            }
        }

        this.log.info('Verarbeitung der Warteschlange abgeschlossen.');
        this.isProcessing = false;
    }

    async writeValueWithRetries(address, serviceUUID, characteristicUUID, valueHex, oldValue, datapoint) {
        let attempts = 0;
        let delay = 5000;
        const cleanHex = valueHex.replace(/\s+/g, ''); // Leerzeichen entfernen
        const dataBuffer = Buffer.from(cleanHex, 'hex');

        while (attempts < this.MAX_RETRIES) {
            try {
                this.log.info(`Versuch ${attempts+1}/${this.MAX_RETRIES} Schreibe an ${address} (Service:${serviceUUID} Char:${characteristicUUID}) Wert: ${cleanHex}`);
                await this.writeGattValue(address, serviceUUID, characteristicUUID, dataBuffer);
                this.log.info('Wert erfolgreich geschrieben.');
                return;
            } catch (err) {
                attempts++;
                this.log.warn(`Fehler beim Schreiben (Versuch ${attempts}): ${err}`);
                if (attempts >= this.MAX_RETRIES) {
                    this.log.error('Maximale Anzahl an Versuchen erreicht. Abbruch.');
                    if (oldValue !== undefined && oldValue !== null) {
                        this.isResetting = true;
                        this.log.info(`Setze Datenpunkt "${datapoint}" auf den alten Wert: ${oldValue}`);
                        await this.setStateAsync(datapoint, { val: oldValue, ack: true });
                        this.isResetting = false;
                    } else {
                        this.log.error(`Kein alter Wert für "${datapoint}" vorhanden. Kein Reset möglich.`);
                    }
                    throw new Error('GATT-Befehl fehlgeschlagen.');
                }
                await this.wait(delay);
                delay *= 1.1;
            }
        }
    }

    async writeGattValue(address, serviceUUID, characteristicUUID, dataBuffer) {
        const { characteristic } = await this.getPeripheralAndCharacteristic(address, serviceUUID, characteristicUUID);
        return new Promise((resolve, reject) => {
            characteristic.write(dataBuffer, false, (error) => {
                if (error) return reject(error);
                resolve();
            });
        });
    }

    async getPeripheralAndCharacteristic(address, serviceUUID, characteristicUUID) {
        const key = `${address.toLowerCase()}_${serviceUUID.toLowerCase()}_${characteristicUUID.toLowerCase()}`;
        if (this.peripherals.has(key)) {
            return this.peripherals.get(key);
        }

        const peripheral = await this.findPeripheralByAddress(address);
        await this.connectPeripheral(peripheral);
        const { characteristic } = await this.findCharacteristic(peripheral, serviceUUID, characteristicUUID);
        const info = { peripheral, characteristic, serviceUUID, characteristicUUID };
        this.peripherals.set(key, info);
        return info;
    }

    findPeripheralByAddress(address) {
        return new Promise((resolve, reject) => {
            let found = false;
            const onDiscover = (p) => {
                if (p.address === address.toLowerCase()) {
                    noble.removeListener('discover', onDiscover);
                    noble.stopScanning();
                    found = true;
                    resolve(p);
                }
            };
            noble.on('discover', onDiscover);
            noble.startScanning([], true, (err) => {
                if (err) {
                    noble.removeListener('discover', onDiscover);
                    return reject(err);
                }
                setTimeout(() => {
                    if (!found) {
                        noble.removeListener('discover', onDiscover);
                        noble.stopScanning();
                        reject(new Error(`Gerät ${address} nicht gefunden.`));
                    }
                }, 5000);
            });
        });
    }

    connectPeripheral(peripheral) {
        return new Promise((resolve, reject) => {
            if (peripheral.state === 'connected') return resolve();
            peripheral.connect((error) => {
                if (error) return reject(error);
                resolve();
            });
        });
    }

    findCharacteristic(peripheral, serviceUUID, characteristicUUID) {
        return new Promise((resolve, reject) => {
            peripheral.discoverSomeServicesAndCharacteristics([serviceUUID], [characteristicUUID], (err, services, characteristics) => {
                if (err) return reject(err);
                if (!characteristics || characteristics.length === 0) return reject(new Error('Characteristic nicht gefunden.'));
                resolve({ service: services[0], characteristic: characteristics[0] });
            });
        });
    }

    wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    scanForDevices(obj) {
        const discovered = [];
        const onDiscover = (peripheral) => {
            const address = peripheral.address;
            const name = peripheral.advertisement.localName || 'Unbekannt';
            if (!discovered.find(d => d.address === address)) {
                discovered.push({ address, name });
            }
        };
        noble.on('discover', onDiscover);
        noble.startScanning([], true, (err) => {
            if (err) {
                this.log.error('Fehler beim Scannen: ' + err);
                if (obj.callback) this.sendTo(obj.from, obj.command, {error: err}, obj.callback);
            } else {
                setTimeout(() => {
                    noble.stopScanning();
                    noble.removeListener('discover', onDiscover);
                    if (obj.callback) this.sendTo(obj.from, obj.command, {devices: discovered}, obj.callback);
                }, 5000);
            }
        });
    }

    async discoverDeviceDetails(address, from, callback) {
        try {
            const peripheral = await this.findPeripheralByAddress(address);
            await this.connectPeripheral(peripheral);
            const services = await this.discoverAllServicesAndCharacteristics(peripheral);
            if (callback) this.sendTo(from, 'discover', {services}, callback);
        } catch (err) {
            this.log.error('Fehler bei discoverDeviceDetails: ' + err);
            if (callback) this.sendTo(from, 'discover', {error: err.message}, callback);
        }
    }

    discoverAllServicesAndCharacteristics(peripheral) {
        return new Promise((resolve, reject) => {
            peripheral.discoverAllServicesAndCharacteristics((err, services) => {
                if (err) return reject(err);
                const result = [];
                services.forEach(s => {
                    const servObj = {
                        uuid: s.uuid,
                        characteristics: s.characteristics.map(c => ({
                            uuid: c.uuid,
                            properties: c.properties
                        }))
                    };
                    result.push(servObj);
                });
                resolve(result);
            });
        });
    }

    async updateDeviceConfig(newDevices, from, callback) {
        // Speichern in Adapter-Config
        this.getForeignObject('system.adapter.' + this.namespace, (err, obj) => {
            if (err || !obj) {
                this.log.error('Kann Adapter-Objekt nicht laden: ' + err);
                if (callback) this.sendTo(from, 'saveDeviceConfig', {error: err}, callback);
                return;
            }
            obj.native.devices = newDevices;
            this.setForeignObject('system.adapter.' + this.namespace, obj, (err2) => {
                if (err2) {
                    this.log.error('Fehler beim Speichern der neuen Config: ' + err2);
                    if (callback) this.sendTo(from, 'saveDeviceConfig', {error: err2}, callback);
                } else {
                    this.log.info('Konfiguration erfolgreich aktualisiert. Bitte Adapter neu starten.');
                    if (callback) this.sendTo(from, 'saveDeviceConfig', {success: true}, callback);
                }
            });
        });
    }
}

if (require.main !== module) {
    module.exports = (options) => new BluetoothControl(options);
} else {
    new BluetoothControl();
}

let adapterName = 'bluetooth-control';
let devices = [];
let selectedDevice = null;
let discoveredServices = [];
let configuredDevices = [];

// Nachricht an Adapter senden
async function sendMessage(command, message) {
    return new Promise((resolve, reject) => {
        sendTo(`${adapterName}.${instance}`, command, message, (result) => {
            if (result && result.error) return reject(result.error);
            resolve(result);
        });
    });
}

function updateConfiguredDevicesTable() {
    const tbody = document.querySelector('#configuredDevices tbody');
    tbody.innerHTML = '';
    configuredDevices.forEach(dev => {
        dev.characteristics.forEach(ch => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${dev.address}</td><td>${ch.serviceUUID}</td><td>${ch.characteristicUUID}</td>`;
            tbody.appendChild(tr);
        });
    });
}

async function loadConfig() {
    const config = await socket.emitPromise('getObject', `system.adapter.${adapterName}.${instance}`);
    configuredDevices = config.native.devices || [];
    updateConfiguredDevicesTable();
}

document.getElementById('scanBtn').addEventListener('click', async () => {
    try {
        const res = await sendMessage('scan', {});
        devices = res.devices || [];
        const devicesList = document.getElementById('devicesList');
        devicesList.innerHTML = '';
        devices.forEach(d => {
            const li = document.createElement('li');
            li.textContent = d.name + ' (' + d.address + ')';
            li.addEventListener('click', () => selectDevice(d));
            devicesList.appendChild(li);
        });
    } catch (err) {
        alert('Fehler beim Scannen: ' + err);
    }
});

function selectDevice(d) {
    selectedDevice = d;
    document.getElementById('deviceDetails').innerHTML = 'Lade Details...';
    sendMessage('discover', {address: d.address}).then(res => {
        discoveredServices = res.services || [];
        renderDeviceDetails();
    }).catch(err => {
        document.getElementById('deviceDetails').innerHTML = 'Fehler: ' + err;
    });
}

function renderDeviceDetails() {
    const container = document.getElementById('deviceDetails');
    container.innerHTML = '';
    discoveredServices.forEach(s => {
        const sdiv = document.createElement('div');
        sdiv.innerHTML = `<strong>Service: ${s.uuid}</strong>`;
        s.characteristics.forEach(c => {
            const cdiv = document.createElement('div');
            cdiv.style.marginLeft = '20px';
            cdiv.innerHTML = `Characteristic: ${c.uuid} [${c.properties.join(', ')}]`;
            cdiv.style.cursor = 'pointer';
            cdiv.addEventListener('click', () => addCharacteristicConfig(selectedDevice.address, s.uuid, c.uuid));
            sdiv.appendChild(cdiv);
        });
        container.appendChild(sdiv);
    });
    container.innerHTML += '<p>Klicken Sie auf eine Characteristic, um sie zur Konfiguration hinzuzufügen.</p>';
}

function addCharacteristicConfig(address, serviceUUID, characteristicUUID) {
    let dev = configuredDevices.find(d => d.address === address);
    if (!dev) {
        dev = {address, characteristics: []};
        configuredDevices.push(dev);
    }
    if (!dev.characteristics.find(ch => ch.serviceUUID === serviceUUID && ch.characteristicUUID === characteristicUUID)) {
        dev.characteristics.push({serviceUUID, characteristicUUID});
    }
    updateConfiguredDevicesTable();
}

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
    try {
        await sendMessage('saveDeviceConfig', {devices: configuredDevices});
        alert('Konfiguration gespeichert. Bitte Adapter ggf. neu starten.');
    } catch (err) {
        alert('Fehler beim Speichern: ' + err);
    }
});

// Konfiguration beim Laden initialisieren
loadConfig().catch(err => console.error(err));

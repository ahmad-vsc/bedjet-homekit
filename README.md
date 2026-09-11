# homebridge-bedjet-v3

Control a BedJet V3 from Apple HomeKit — direct Bluetooth LE, no cloud.

Exposes a **Thermostat** (off / heat / cool + target temperature) and a
**Fan** (speed in 5% steps). Built around a BLE command queue and an
auto-reconnecting state machine, so it recovers from the stale-connection
failures (`DBusError: In Progress`, `ATT error: 0x0e`) that plagued older
BedJet plugins.

## Requirements

- Raspberry Pi (or any Linux host) running Homebridge with BlueZ 5.50+
- Node.js >= 18.15, Homebridge >= 1.8
- BedJet V3 within Bluetooth range. The BedJet allows **one** BLE client:
  close the BedJet phone app, or the plugin cannot connect.

## Install

```bash
# from a release tarball
sudo npm install -g ./homebridge-bedjet-v3-0.1.0.tgz
```

### D-Bus permission (one-time)

node-ble talks to BlueZ over D-Bus. Allow the user that runs Homebridge
(usually `homebridge`) by creating `/etc/dbus-1/system.d/homebridge-bedjet.conf`:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="homebridge">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

Then `sudo systemctl restart dbus homebridge`.

## Find your BedJet's MAC address

```bash
npx homebridge-bedjet-v3 scan
```

## Configure

Via the Homebridge UI (recommended), or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BedJetV3",
      "devices": [{ "name": "BedJet", "mac": "AA:BB:CC:DD:EE:FF" }]
    }
  ]
}
```

Advanced (defaults shown): `"statusTimeoutSeconds": 300` — recycle the BLE
connection after this much status silence; `"maxReconnectBackoffSeconds": 60`.

## Verification checklist (after install)

- [ ] BedJet appears in the Home app as Thermostat + Fan
  (note: the Thermostat tile's "current temperature" is the BedJet's outlet
  air temperature — the air it's blowing, per the device's own sensor — so
  expect ~35-40°C readings while heating; this matches the BedJet app's
  behavior, not room temperature)
- [ ] Set Heat + a target temperature → BedJet starts heating
- [ ] Change fan speed from the Fan tile → BedJet fan changes
- [ ] Turn off from Home app → BedJet stops
- [ ] Change mode on the BedJet remote → Home app reflects it within seconds
- [ ] Unplug the BedJet for a minute, plug back in → plugin reconnects by itself
- [ ] Open the BedJet phone app → Homebridge log says the app may be holding the connection
- [ ] Homebridge restart → accessory restored, still controllable

## Troubleshooting

- **"connect failed ... is the BedJet app open on your phone?"** — the BedJet
  accepts one BLE connection; force-close the phone app.
- **No devices found by scan** — check `bluetoothctl show` says `Powered: yes`,
  and that your user is in the `bluetooth` group.

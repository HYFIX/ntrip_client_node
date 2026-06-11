# NTRIP RTK Client & Dashboard

A Node.js NTRIP client with a real-time web dashboard for managing RTK rover networks. Connects to any NTRIP caster, parses RTCM v3 correction streams, forwards corrections to rover receivers via serial ports, and visualises position quality live in the browser.

![HyFix](public/hyfix_logo_updated.png)

---

## Features

### NTRIP Caster Connection
- NTRIP v2.0 HTTP/1.1 client over TCP with Basic Authentication
- Accepts both standard `HTTP/1.1 200 OK` and legacy `ICY 200 OK` caster responses
- Periodic GGA heartbeat to the caster (configurable interval) for VRS / nearest-mountpoint selection
- Auto-reconnect with configurable delay

### RTCM v3 Stream Processing
- Binary frame parser with `0xD3` preamble detection and 10-bit length framing
- Decodes message type **1005 / 1006** (base station ECEF → WGS84 via Bowring's method) to plot the base station on the map
- Packet-type frequency statistics for all **received** message types and separately for all **forwarded** message types — makes filter and converter effects immediately visible
- **Ephemeris filter**: optionally strips ephemeris messages from the forwarded stream to reduce serial bandwidth — GPS (1019), GLONASS (1020), NavIC (1041), BeiDou (1042), QZSS (1044), Galileo FNAV/INAV (1045 / 1046)
- **MSM4 conversion**: optionally down-converts MSM5/6/7 observation messages to MSM4 before forwarding — strips phase-rate fields and truncates extended-precision signal fields (20-bit → 15-bit pseudorange, 24-bit → 22-bit phase range), producing a stream compatible with older rovers that only support MSM4

### Serial Port Management
- Supports any number of physical or simulated serial ports simultaneously
- Per-port configuration: baud rate, GGA provider flag, RTCM forwarding flag
- Differential RTCM TX bytes and manual command TX bytes tracked separately
- Hot-reload: changing port settings reconnects only affected ports, leaving others running

### NTRIP Uploader (Base Station Mode)
- Each serial port can optionally **upload its raw data stream to an NTRIP caster**, turning the system into a base station broadcaster
- Supports **NTRIP 1.0** (`SOURCE` method, raw streaming) and **NTRIP 2.0** (`POST` / chunked transfer encoding)
- Per-port configuration: host, port, mountpoint, username, password, NTRIP version
- Auto-reconnects on disconnect or error; live upload status (connecting / connected / error) and bytes-sent counter shown in the serial ports table

### Simulated Rover
- Built-in mock serial port that generates synthetic NMEA (GGA + GSV) at 1 Hz
- Simulates RTK convergence when corrections are flowing: SPP → DGPS (5 s) → RTK Float (15 s) → RTK Fix
- Degrades back to SPP when corrections stop
- Configurable walk speed and starting coordinates

### Gap Simulation
- Periodically interrupts RTCM forwarding to test rover RTK convergence and reconvergence performance
- Configurable **forward duration** and **gap duration** (default 180 s / 180 s)
- Live countdown shown on the dashboard: `FORWARDING → gap in 2m47s` / `GAP ACTIVE → resume in 1m12s`
- Example with defaults — data timeline: `0h0m0s–0h3m0s forward`, `0h3m0s–0h6m0s gap`, `0h6m0s–0h9m0s forward`, …

### Real-time Web Dashboard
- **RTK Map** — Leaflet map with dark tile theme; plots base station marker, per-rover position markers colour-coded by fix quality, trajectory trails, and dashed baseline lines
- **Rovers RTK Matrix** — live card per rover showing coordinates, RTK fix quality badge, HDOP, satellite count, correction age, fix rate bar, and SPP / DGPS / Float / Fix epoch counters
- **Satellite Skyplot & SNR bars** — canvas-rendered per rover, colour-coded by constellation (GPS / GLONASS / Galileo / BeiDou / QZSS)
- **NTRIP Caster card** — connection status, bytes received, base station ID, WGS84 and ECEF coordinates; dual RTCM message statistics showing received-from-caster and forwarded-to-rovers counts separately
- **Serial Ports table** — live per-port Rx / RTCM Tx / command Tx byte counters plus uploader connection status
- **Serial Command Terminal** — send ASCII or hex commands to any connected port directly from the browser; up/down arrow key history; EOL selector (None / CR / LF / CR+LF)
- **Live Stream Console** — scrolling timestamped log of all events
- **Data Logs viewer** — browse, view, and download session log files

### Session Logging
- All data is logged to `logs/` using a custom binary framing format: `$GEOD,<unix_ms>,<length>,<payload>\r\n`
- `rover_<port>_<timestamp>.nmea` — raw bidirectional serial data (received NMEA + sent commands)
- `caster_<mountpoint>_<timestamp>.rtcm` — raw binary RTCM stream from caster
- `caster_<mountpoint>_activity_<timestamp>.log` — human-readable byte-count activity log

---

## Requirements

- Node.js ≥ 18
- On Windows, the `serialport` native module requires the Visual C++ Build Tools (installed with `npm install` automatically via node-gyp). If native bindings fail to load, the application falls back to simulation mode automatically.

---

## Installation

```bash
git clone https://github.com/HYFIX/ntrip_client_node.git
cd ntrip_client_node
npm install
```

---

## Usage

```bash
npm start
```

Open **http://localhost:3000** in a browser. The port can be overridden with the `PORT` environment variable.

On first run a default `config.json` is created automatically. Use the **Configure Systems** button in the dashboard to change settings; changes are applied immediately without restarting the server.

---

## Configuration

All settings are managed through the web UI and persisted to `config.json`. The file is excluded from version control because it contains credentials.

### NTRIP Caster

| Field | Description |
|---|---|
| Host | NTRIP caster hostname (e.g. `rtk.geodnet.com`, apply for a free account at https://www.geodnet.com/free if you do not have one) |
| Port | TCP port (typically `2101`) |
| Mountpoint | Stream mountpoint name |
| Username / Password | Caster credentials |
| Send GGA | Forward rover GGA to caster (required for VRS / nearest-stream selection) |
| GGA Interval | How often to send the GGA heartbeat (ms) |
| Block Ephemeris | Strip ephemeris frames before forwarding to rovers |
| Convert to MSM4 | Down-convert MSM5/6/7 observations to MSM4 (for older rover firmware that lacks MSM5-7 support) |
| Gap Simulation | Enable periodic RTCM gaps; set forward and gap durations in seconds |

### Serial / Rover Interfaces

| Field | Description |
|---|---|
| Port / COM Name | System port path (`COM3`, `/dev/ttyUSB0`, etc.) — type or pick from the detected-ports dropdown |
| Baud Rate | Serial baud rate |
| Enabled | Activate / deactivate without removing the entry |
| GGA Provider | Feed this port's GGA sentences to the NTRIP caster |
| Forward RTCM | Write incoming RTCM corrections to this port |
| Simulated Rover | Use the built-in mock rover instead of a physical port |
| Walk Speed | Simulated rover movement speed (km/h) |
| Start Lat / Lon | Simulated rover starting position |
| Upload to NTRIP Caster | Stream raw data from this port to an NTRIP caster (base station upload) |
| Upload Host / Port | Target caster address and TCP port |
| Upload Mountpoint | Mountpoint name to register on the caster |
| Upload Username / Password | Caster credentials for the upload connection |
| NTRIP Version | `1.0` (SOURCE method) or `2.0` (POST / chunked) |

Configuration can also be exported to or imported from a JSON file using the **Export File** / **Import File** buttons.

---

## Architecture

```
NTRIP Caster (TCP)
  └─► ntrip-client.js       parse HTTP response, stream RTCM frames
        ├─► rtcm-parser.js  decode type 1005/1006 → base station coords & packet stats
        └─► server.js       ephemeris filter → MSM4 converter → gap simulation gate → serial-manager.js
                                                                            └─► rover serial ports

Rover serial ports
  └─► serial-manager.js     raw data → ntrip-uploader.js → NTRIP caster (base station upload)
                             parse NMEA lines → nmea-parser.js → GGA → ntrip-client (VRS)

server.js  (1 Hz broadcast)
  └─► WebSocket clients     telemetry: ntrip status, serial stats, uploader status,
                                       rover NMEA stats, forwarded RTCM stats, gap sim state
```

---

## License

MIT

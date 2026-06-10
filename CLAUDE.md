# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start       # Start the server (node server.js)
npm run dev     # Same as start
```

The server runs on `http://localhost:3000` by default (override with `PORT` env var). There is no test suite or linter configured.

## Architecture

This is a Node.js NTRIP client with a real-time web dashboard. The system bridges an NTRIP caster (RTK correction source) to rover GPS receivers connected via serial ports.

### Data Flow

```
Serial Port (physical or simulated)
  → emits NMEA GGA/GSV sentences
  → serialPortManager → ntripClient.sendGga()   (rover position → caster)

NTRIP Caster (TCP)
  → streams binary RTCM v3 corrections
  → rtcmParser.feed()                           (extract base station coords from type 1005/1006)
  → serialPortManager.forwardRtcm()             (corrections → rover serial ports)

server.js WebSocket broadcast (1 Hz)
  → telemetry: { ntrip status, serial port statuses, per-rover NMEA stats }
```

### Module Roles

- **`server.js`** — Express HTTP + WebSocket server. Owns config load/save (`config.json`), REST API, hot-reload via `POST /api/config`, and the 1 Hz WebSocket telemetry broadcast.
- **`src/ntrip-client.js`** — TCP connection to NTRIP caster. Sends HTTP/1.1 GET with Basic Auth and `Ntrip-Version: Ntrip/2.0`. Handles header parsing (accepts both `HTTP/1.1 200 OK` and `ICY 200 OK`), periodic GGA heartbeat interval, and auto-reconnect.
- **`src/rtcm-parser.js`** — Streaming RTCM v3 binary parser. Scans for `0xD3` preamble, frames packets by 10-bit length field + 3-byte CRC24. Only fully decodes message types 1005/1006 (base station ECEF coordinates → WGS84 via Bowring's method). All other message types are counted but not decoded.
- **`src/nmea-parser.js`** — Parses GGA (position fix quality, coordinates, RTK fix rate) and GSV (satellites in view, skyplot data). Stats are keyed per port name; trajectory trail is capped at 100 entries.
- **`src/serial-manager.js`** — Manages physical and simulated serial ports. When `serialport` native bindings are unavailable or `isSimulated: true`, uses the internal `MockSerialPort` class which generates synthetic NMEA (GGA + GSV) at 1 Hz and simulates RTK quality progression (SPP → DGPS → RTK Float → RTK Fix) based on whether RTCM corrections are actively flowing.
- **`src/logger.js`** — Writes binary log files using a custom `$GEOD,<unix_ms>,<length>,<payload>\r\n` frame format. Creates timestamped files in `logs/` on first write. Rover serial data → `rover_<portName>.nmea`; caster RTCM → `caster_<mountpoint>.rtcm` + a human-readable `_activity.log`.

### Singleton Pattern

All `src/` modules export a single shared instance (`module.exports = new X()`). They are not classes to be instantiated — import and use directly.

### Configuration

`config.json` is auto-created in the project root with defaults if missing. It is hot-reloaded in memory and written to disk on every `POST /api/config` call. The config structure requires `ntrip` (object) and `serialPorts` (array) keys.

### Frontend

`public/index.html` + `public/js/app.js` + `public/css/style.css` — served statically. The frontend connects via WebSocket to receive the 1 Hz telemetry broadcast and can POST to `/api/config` to reconfigure the system without restart.

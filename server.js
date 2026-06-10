const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const logger = require('./src/logger');
const nmeaParser = require('./src/nmea-parser');
const rtcmParser = require('./src/rtcm-parser');
const serialPortManager = require('./src/serial-manager');
const ntripClient = require('./src/ntrip-client');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let config = {};

// ==========================================
// RTCM EPHEMERIS FRAME FILTER
// ==========================================

const EPHEMERIS_TYPES = new Set([1019, 1020, 1041, 1042, 1044, 1045, 1046]);
let rtcmFilterBuf = Buffer.alloc(0);

function filterEphemerisFrames(chunk) {
  rtcmFilterBuf = Buffer.concat([rtcmFilterBuf, chunk]);
  const kept = [];

  while (rtcmFilterBuf.length >= 3) {
    if (rtcmFilterBuf[0] !== 0xD3) {
      const next = rtcmFilterBuf.indexOf(0xD3, 1);
      rtcmFilterBuf = next === -1 ? Buffer.alloc(0) : rtcmFilterBuf.slice(next);
      continue;
    }

    const length = ((rtcmFilterBuf[1] & 0x03) << 8) | rtcmFilterBuf[2];
    const totalSize = length + 6; // preamble(1) + length(2) + payload + CRC(3)

    if (rtcmFilterBuf.length < totalSize) break; // incomplete frame, wait for more data

    // 12-bit message type occupies the first 12 bits of the payload (bytes 3-4 of the frame)
    const msgType = (rtcmFilterBuf[3] << 4) | (rtcmFilterBuf[4] >> 4);

    if (!EPHEMERIS_TYPES.has(msgType)) {
      kept.push(rtcmFilterBuf.slice(0, totalSize));
    }

    rtcmFilterBuf = rtcmFilterBuf.slice(totalSize);
  }

  return kept.length > 0 ? Buffer.concat(kept) : null;
}

// ==========================================
// FORWARDED RTCM STATS
// ==========================================

const fwdStats = { packetTypes: {}, totalPackets: 0 };

function countForwardedFrames(chunk) {
  let offset = 0;
  while (offset + 5 <= chunk.length) {
    if (chunk[offset] !== 0xD3) { offset++; continue; }
    const length = ((chunk[offset + 1] & 0x03) << 8) | chunk[offset + 2];
    const totalSize = length + 6;
    if (offset + totalSize > chunk.length) break;
    const msgType = (chunk[offset + 3] << 4) | (chunk[offset + 4] >> 4);
    fwdStats.packetTypes[msgType] = (fwdStats.packetTypes[msgType] || 0) + 1;
    fwdStats.totalPackets++;
    offset += totalSize;
  }
}

// ==========================================
// MSM5/6/7 → MSM4 CONVERTER
// ==========================================

const MSM_CONSTELLATION_BASES = [1070, 1080, 1090, 1100, 1110, 1120];

function getMsmLevel(msgType) {
  for (const base of MSM_CONSTELLATION_BASES) {
    const level = msgType - base;
    if (level >= 1 && level <= 7) return { base, level };
  }
  return null;
}

function crc24q(buf, len) {
  const POLY = 0x1864CFB;
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i] << 16;
    for (let j = 0; j < 8; j++) { crc <<= 1; if (crc & 0x1000000) crc ^= POLY; }
  }
  return crc & 0xFFFFFF;
}

function msmPopcount(bigint, bits) {
  let n = 0;
  for (let i = 0; i < bits; i++) { if (bigint & (1n << BigInt(i))) n++; }
  return n;
}

class MsmBitReader {
  constructor(buffer) { this.buf = buffer; this.pos = 0; }
  readU(n) {
    let v = 0n;
    for (let i = 0; i < n; i++) {
      const b = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      v = (v << 1n) | BigInt(b);
      this.pos++;
    }
    return v;
  }
  readS(n) {
    const v = this.readU(n);
    return v & (1n << BigInt(n - 1)) ? v - (1n << BigInt(n)) : v;
  }
}

class MsmBitWriter {
  constructor() { this.bits = []; }
  writeU(v, n) {
    v = BigInt(v) & ((1n << BigInt(n)) - 1n);
    for (let i = n - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n));
  }
  writeS(v, n) {
    v = BigInt(v);
    if (v < 0n) v += 1n << BigInt(n);
    this.writeU(v, n);
  }
  toBuffer() {
    while (this.bits.length & 7) this.bits.push(0);
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j];
      bytes.push(b);
    }
    return Buffer.from(bytes);
  }
}

function convertMsmFrameToMsm4(frame) {
  const payload = frame.slice(3, frame.length - 3);
  const r = new MsmBitReader(payload);
  const w = new MsmBitWriter();

  const msgType = Number(r.readU(12));
  const msm = getMsmLevel(msgType);
  if (!msm || msm.level <= 4) return frame;

  w.writeU(msm.base + 4, 12);    // rewrite message type → MSM4
  w.writeU(r.readU(30), 30);     // epoch time (30 bits for all GNSS; GLONASS = 3-bit day + 27-bit time)
  w.writeU(r.readU(19), 19);     // multiple-msg(1) + IODS(3) + reserved(7) + clk steering(2) + ext clk(2) + smoothing(1+3)

  const satMask  = r.readU(64); w.writeU(satMask, 64);
  const nSat = msmPopcount(satMask, 64);

  const sigMask  = r.readU(32); w.writeU(sigMask, 32);
  const nSig = msmPopcount(sigMask, 32);

  const cellBits = nSat * nSig;
  const cellMask = r.readU(cellBits); w.writeU(cellMask, cellBits);
  const nCell = msmPopcount(cellMask, cellBits);

  // Satellite data — DF397(10) + DF398(4) + DF399(10) per sat, identical for MSM4-7
  for (let i = 0; i < nSat; i++) w.writeU(r.readU(10), 10);
  for (let i = 0; i < nSat; i++) w.writeU(r.readU(4),  4);
  for (let i = 0; i < nSat; i++) w.writeU(r.readU(10), 10);
  // MSM5/7 only: rough phase-range rates (DF405, 14 bits) — drop
  if (msm.level === 5 || msm.level === 7) r.readU(14 * nSat);

  // Signal data
  if (msm.level === 5) {
    // MSM5 field widths are identical to MSM4; just drop the trailing rate field
    for (let i = 0; i < nCell; i++) w.writeS(r.readS(15), 15); // fine pseudorange
    for (let i = 0; i < nCell; i++) w.writeS(r.readS(22), 22); // fine phase range
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(4),  4);  // lock time indicator
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(1),  1);  // half-cycle ambiguity
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(6),  6);  // CNR
    r.readU(15 * nCell); // drop fine phase-range rates (DF404)
  } else {
    // MSM6/7: extended-resolution fields → truncate to MSM4 widths
    // pseudorange: 20-bit signed → 15-bit (drop 5 LSBs; arithmetic right shift)
    for (let i = 0; i < nCell; i++) w.writeS(r.readS(20) >> 5n, 15);
    // phase range: 24-bit signed → 22-bit
    for (let i = 0; i < nCell; i++) w.writeS(r.readS(24) >> 2n, 22);
    // lock time: 10-bit → 4-bit
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(10) >> 6n, 4);
    // half-cycle ambiguity: 1 bit (unchanged)
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(1), 1);
    // CNR: 10-bit → 6-bit
    for (let i = 0; i < nCell; i++) w.writeU(r.readU(10) >> 4n, 6);
    if (msm.level === 7) r.readU(15 * nCell); // MSM7: drop fine phase-range rates
  }

  const newPayload = w.toBuffer();
  const newFrame = Buffer.alloc(newPayload.length + 6);
  newFrame[0] = 0xD3;
  newFrame[1] = (newPayload.length >> 8) & 0x03;
  newFrame[2] = newPayload.length & 0xFF;
  newPayload.copy(newFrame, 3);
  const crc = crc24q(newFrame, newPayload.length + 3);
  newFrame[newPayload.length + 3] = (crc >> 16) & 0xFF;
  newFrame[newPayload.length + 4] = (crc >> 8) & 0xFF;
  newFrame[newPayload.length + 5] = crc & 0xFF;
  return newFrame;
}

let msmConvertBuf = Buffer.alloc(0);

function convertChunkToMsm4(chunk) {
  msmConvertBuf = Buffer.concat([msmConvertBuf, chunk]);
  const out = [];

  while (msmConvertBuf.length >= 3) {
    if (msmConvertBuf[0] !== 0xD3) {
      const next = msmConvertBuf.indexOf(0xD3, 1);
      msmConvertBuf = next === -1 ? Buffer.alloc(0) : msmConvertBuf.slice(next);
      continue;
    }
    const length = ((msmConvertBuf[1] & 0x03) << 8) | msmConvertBuf[2];
    const totalSize = length + 6;
    if (msmConvertBuf.length < totalSize) break;

    const frame = msmConvertBuf.slice(0, totalSize);
    msmConvertBuf = msmConvertBuf.slice(totalSize);

    const msgType = (frame[3] << 4) | (frame[4] >> 4);
    const msm = getMsmLevel(msgType);
    if (msm && msm.level > 4) {
      try {
        out.push(convertMsmFrameToMsm4(frame));
      } catch (e) {
        console.error('[MSM4] Conversion error for type', msgType, ':', e.message);
        out.push(frame); // fall back to original on error
      }
    } else {
      out.push(frame);
    }
  }

  return out.length > 0 ? Buffer.concat(out) : null;
}

// ==========================================
// RTCM GAP SIMULATION
// ==========================================

const gapSim = {
  enabled: false,
  isForwarding: true,
  timer: null,
  nextSwitchAt: null,
  forwardDuration: 180,
  gapDuration: 180
};

function stopGapSimulation() {
  if (gapSim.timer) {
    clearTimeout(gapSim.timer);
    gapSim.timer = null;
  }
  gapSim.enabled = false;
  gapSim.isForwarding = true;
  gapSim.nextSwitchAt = null;
}

function scheduleGapSwitch() {
  const delay = (gapSim.isForwarding ? gapSim.forwardDuration : gapSim.gapDuration) * 1000;
  gapSim.nextSwitchAt = Date.now() + delay;
  gapSim.timer = setTimeout(() => {
    gapSim.isForwarding = !gapSim.isForwarding;
    console.log(`[GapSim] ${gapSim.isForwarding ? 'RESUMING' : 'STOPPING'} RTCM forwarding to rovers`);
    scheduleGapSwitch();
  }, delay);
}

function startGapSimulation(forwardDuration, gapDuration) {
  stopGapSimulation();
  gapSim.enabled = true;
  gapSim.isForwarding = true;
  gapSim.forwardDuration = forwardDuration;
  gapSim.gapDuration = gapDuration;
  scheduleGapSwitch();
  console.log(`[GapSim] Started: forward ${forwardDuration}s / gap ${gapDuration}s`);
}

// Load configuration initially
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = JSON.parse(raw);
      // Double check that it has the required fields, otherwise throw to trigger default generation
      if (!config || !config.ntrip || !Array.isArray(config.serialPorts)) {
        throw new Error('Config file is incomplete or corrupted');
      }
      console.log('[Server] Configuration loaded from config.json');
    } else {
      throw new Error('Config file does not exist');
    }
  } catch (err) {
    console.warn(`[Server] Error/Missing config.json (${err.message}). Regenerating defaults...`);
    // Fallback default config if file is missing or corrupted
    config = {
      ntrip: {
        host: 'rtk.geodnet.com',
        port: 2101,
        mountpoint: 'AUTO',
        username: '',
        password: '',
        sendGga: true,
        ggaInterval: 5000,
        autoReconnect: true,
        reconnectDelay: 5000
      },
      serialPorts: [
        {
          id: 'mock_rover_1',
          portName: 'MOCK_ROVER_1',
          baudRate: 115200,
          enabled: true,
          sendGgaToCaster: true,
          receiveRtcm: true,
          isSimulated: true,
          simulatedSpeed: 5.0,
          startLat: 37.7749,
          startLon: -122.4194
        }
      ]
    };
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      console.log('[Server] Created default config.json file.');
    } catch (writeErr) {
      console.error('[Server] Failed to write default config.json:', writeErr.message);
    }
  }
}

// Hot reload configuration changes dynamically
function hotReloadConfig(newConfig) {
  config = newConfig;
  
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
    console.log('[Server] Saved updated configuration to disk.');
  } catch (err) {
    console.error('[Server] Failed to write config.json:', err.message);
  }

  // 1. Reconfigure and open serial ports
  rtcmFilterBuf = Buffer.alloc(0);  // reset filter/converter state on any config change
  msmConvertBuf = Buffer.alloc(0);
  fwdStats.packetTypes = {};
  fwdStats.totalPackets = 0;
  console.log('[Server] Hot-reloading Serial Port connections...');
  serialPortManager.configurePorts(config.serialPorts);

  // 2. Reconnect NTRIP Client
  console.log('[Server] Hot-reloading NTRIP Caster connection...');
  if (config.ntrip) {
    ntripClient.connect(config.ntrip);
  } else {
    ntripClient.disconnect();
  }

  // 3. Restart gap simulation
  if (config.ntrip && config.ntrip.gapSimEnabled) {
    startGapSimulation(
      config.ntrip.gapSimForwardDuration || 180,
      config.ntrip.gapSimGapDuration || 180
    );
  } else {
    stopGapSimulation();
  }
}

// Initialize system pipelines
function initPipelines() {
  // Feed GGA sentences from selected rover ports to NTRIP Caster
  serialPortManager.onGgaReceived((ggaLine) => {
    ntripClient.sendGga(ggaLine);
  });

  // Forward incoming RTCM corrections back to targeted rovers (filtered, converted, gated by gap simulation)
  ntripClient.onRawRtcm((rtcmChunk) => {
    let chunk = rtcmChunk;
    if (config.ntrip && config.ntrip.filterEphemeris) {
      chunk = filterEphemerisFrames(chunk);
      if (!chunk) return;
    }
    if (config.ntrip && config.ntrip.convertToMsm4) {
      chunk = convertChunkToMsm4(chunk);
      if (!chunk) return;
    }
    if (!gapSim.enabled || gapSim.isForwarding) {
      countForwardedFrames(chunk);
      serialPortManager.forwardRtcm(chunk);
    }
  });

  // Boot Serial ports
  if (config.serialPorts) {
    serialPortManager.configurePorts(config.serialPorts);
  }

  // Connect NTRIP Caster
  if (config.ntrip) {
    ntripClient.connect(config.ntrip);
  }

  // Start gap simulation if configured
  if (config.ntrip && config.ntrip.gapSimEnabled) {
    startGapSimulation(
      config.ntrip.gapSimForwardDuration || 180,
      config.ntrip.gapSimGapDuration || 180
    );
  }
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Get current configuration
app.get('/api/config', (req, res) => {
  res.json(config);
});

// Update configuration (hot-reloads immediately)
app.post('/api/config', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || !newConfig.ntrip || !Array.isArray(newConfig.serialPorts)) {
      return res.status(400).json({ error: 'Invalid configuration structure' });
    }
    hotReloadConfig(newConfig);
    res.json({ success: true, message: 'Configuration hot-reloaded successfully', config });
  } catch (err) {
    res.status(500).json({ error: `Failed to update configuration: ${err.message}` });
  }
});

// List physical serial ports available on system
app.get('/api/ports/available', async (req, res) => {
  const list = await serialPortManager.listAvailablePorts();
  res.json(list);
});

// Get log files list
app.get('/api/logs', (req, res) => {
  res.json(logger.getLogFiles());
});

// View contents of a log file
app.get('/api/logs/read', (req, res) => {
  const { name, maxLines } = req.query;
  if (!name) return res.status(400).json({ error: 'Log name required' });
  const linesCount = parseInt(maxLines, 10) || 100;
  const content = logger.readLogFile(name, linesCount);
  res.json({ name, content });
});

// Download a log file directly
app.get('/api/logs/download', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Log name required' });
  const logsPath = path.join(__dirname, 'logs', path.basename(name));
  if (fs.existsSync(logsPath)) {
    res.download(logsPath);
  } else {
    res.status(404).json({ error: 'Log file not found' });
  }
});

// Send a command to a specific serial port
app.post('/api/ports/:portId/command', (req, res) => {
  const { portId } = req.params;
  const { data, hex } = req.body;
  if (!data) return res.status(400).json({ error: 'data field required' });

  let buf;
  try {
    buf = hex
      ? Buffer.from(data.replace(/\s+/g, ''), 'hex')
      : Buffer.from(data, 'utf8');
  } catch (err) {
    return res.status(400).json({ error: `Invalid data: ${err.message}` });
  }

  if (buf.length === 0) return res.status(400).json({ error: 'No bytes to send' });

  const result = serialPortManager.sendCommand(portId, buf);
  if (result.success) {
    res.json({ success: true, portName: result.portName, bytes: result.bytes });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Reset rover statistics
app.post('/api/rovers/reset', (req, res) => {
  const { portName } = req.body;
  if (portName) {
    nmeaParser.resetPortStats(portName);
    res.json({ success: true, message: `Reset stats for ${portName}` });
  } else {
    res.status(400).json({ error: 'Port name required' });
  }
});

// ==========================================
// WEBSOCKET BROADCAST CONTROLLER
// ==========================================

wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected.');
  
  // Instantly send configuration to new client
  ws.send(JSON.stringify({
    type: 'config',
    config
  }));

  ws.on('message', (msgStr) => {
    try {
      const msg = JSON.parse(msgStr);
      if (msg.type === 'request_logs') {
        ws.send(JSON.stringify({
          type: 'logs_list',
          logs: logger.getLogFiles()
        }));
      }
    } catch (e) {
      console.error('[WebSocket] Error parsing client message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected.');
  });
});

// Periodic broadcasting loop (1Hz)
setInterval(() => {
  if (wss.clients.size === 0) return;

  const baseCoords = rtcmParser.getStats().baseCoordinates;
  const baseStationId = rtcmParser.getStats().baseStationId;
  const roversStats = nmeaParser.getAllStats();

  // Dynamic baseline calculations and base ID sync
  Object.keys(roversStats).forEach(portName => {
    const rover = roversStats[portName];
    if (rover.lastLatitude !== null && rover.lastLongitude !== null && baseCoords) {
      rover.baselineLength = rtcmParser.calculateBaseline(
        rover.lastLatitude,
        rover.lastLongitude,
        baseCoords.latitude,
        baseCoords.longitude
      );
    } else {
      rover.baselineLength = null;
    }
    
    if (baseStationId !== null) {
      rover.lastBaseStationId = baseStationId;
    }
  });

  const payload = {
    type: 'telemetry',
    timestamp: Date.now(),
    ntrip: ntripClient.getTelemetry(),
    rtcmFwdStats: { packetTypes: { ...fwdStats.packetTypes }, totalPackets: fwdStats.totalPackets },
    serialPorts: serialPortManager.getPortStatuses(),
    rovers: roversStats,
    gapSim: gapSim.enabled ? {
      enabled: true,
      isForwarding: gapSim.isForwarding,
      secondsUntilSwitch: gapSim.nextSwitchAt ? Math.max(0, Math.round((gapSim.nextSwitchAt - Date.now()) / 1000)) : 0
    } : { enabled: false }
  };

  const jsonPayload = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN state
      client.send(jsonPayload);
    }
  });
}, 1000);

// Start Server
loadConfig();
initPipelines();

server.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(` NTRIP Client Dashboard server running on http://localhost:${PORT}`);
  console.log(`===========================================================`);
});

// Graceful shutdowns
process.on('SIGINT', () => {
  console.log('[Server] Shutting down gracefully...');
  stopGapSimulation();
  serialPortManager.closeAll();
  ntripClient.disconnect();
  logger.closeAll();
  process.exit(0);
});

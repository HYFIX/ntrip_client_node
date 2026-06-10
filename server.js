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
        host: 'rtk2go.com',
        port: 2101,
        mountpoint: 'TEST_MOUNTPOINT',
        username: 'yydgi@example.com',
        password: 'password',
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
  rtcmFilterBuf = Buffer.alloc(0); // reset filter state on any config change
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

  // Forward incoming RTCM corrections back to targeted rovers (filtered, gated by gap simulation)
  ntripClient.onRawRtcm((rtcmChunk) => {
    let chunk = rtcmChunk;
    if (config.ntrip && config.ntrip.filterEphemeris) {
      chunk = filterEphemerisFrames(rtcmChunk);
      if (!chunk) return; // entire chunk was ephemeris frames
    }
    if (!gapSim.enabled || gapSim.isForwarding) {
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

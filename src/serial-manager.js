const EventEmitter = require('events');
const logger = require('./logger');
const nmeaParser = require('./nmea-parser');
const rtcmParser = require('./rtcm-parser');

let SerialPort = null;
let ReadlineParser = null;

// Proactively load serialport, handle failures gracefully
try {
  const serialportLib = require('serialport');
  SerialPort = serialportLib.SerialPort;
  // In v12, ReadlineParser is under @serialport/parser-readline, which is standard. 
  // Let's import it or build a simple parser if not found.
  try {
    const { ReadlineParser: RealReadlineParser } = require('@serialport/parser-readline');
    ReadlineParser = RealReadlineParser;
  } catch (e) {
    // Basic fallback line parser if readline parser import fails
    ReadlineParser = class BasicParser extends EventEmitter {
      constructor() {
        super();
        this.buffer = '';
      }
      write(chunk) {
        this.buffer += chunk.toString('utf8');
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          this.emit('data', line);
        }
      }
    };
  }
  console.log('[SerialPort] Loaded physical serial port drivers.');
} catch (err) {
  console.warn('[SerialPort] Native serialport bindings could not be loaded. Falling back entirely to Simulation Mode.');
}

/**
 * Mock Serial Port class that mimics physical serial port behavior
 */
class MockSerialPort extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.isOpen = false;
    this.timer = null;
    
    // Simulation state
    this.lat = config.startLat || 37.7749;
    this.lon = config.startLon || -122.4194;
    this.angle = Math.random() * Math.PI * 2; // For movement direction
    this.quality = 1; // Start with Single Point Positioning
    this.satellites = 8;
    this.hdop = 1.8;
    this.lastRtcmTime = 0;
    this.bytesRx = 0;
    this.bytesTx = 0;
    this.correctionSeconds = 0;
  }

  open(callback) {
    this.isOpen = true;
    this.bytesRx = 0;
    this.bytesTx = 0;
    
    // Start generating NMEA data periodically (1Hz)
    this.timer = setInterval(() => {
      this.updateSimulation();
    }, 1000);

    if (callback) callback(null);
  }

  close(callback) {
    this.isOpen = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (callback) callback(null);
  }

  // Receive RTCM corrections from NTRIP caster
  write(data, callback) {
    if (!this.isOpen) {
      if (callback) callback(new Error('Port not open'));
      return;
    }
    
    this.bytesTx += data.length;
    this.lastRtcmTime = Date.now();
    
    if (callback) callback(null);
  }

  updateSimulation() {
    // 1. Move rover slightly (simulating walking/driving trajectory)
    const speed = this.config.simulatedSpeed || 5.0; // km/h
    const distancePerSecond = (speed / 3600.0); // km per second
    const earthRadius = 6371.0;
    
    // Small random walk angle adjustments
    this.angle += (Math.random() - 0.5) * 0.4;
    
    const dLat = (distancePerSecond / earthRadius) * Math.sin(this.angle);
    const dLon = (distancePerSecond / (earthRadius * Math.cos(this.lat * Math.PI / 180.0))) * Math.cos(this.angle);

    this.lat += dLat * 180.0 / Math.PI;
    this.lon += dLon * 180.0 / Math.PI;

    // 2. Compute RTK state based on RTCM corrections
    const timeSinceLastRtcm = Date.now() - this.lastRtcmTime;
    const baseStats = rtcmParser.getStats();

    if (timeSinceLastRtcm < 6000 && baseStats.baseStationId !== null) {
      // Actively receiving RTCM data -> Improve RTK fix quality over time
      this.correctionSeconds++;
      
      if (this.correctionSeconds < 5) {
        this.quality = 2; // DGPS
        this.satellites = 12;
        this.hdop = 1.2;
      } else if (this.correctionSeconds < 15) {
        this.quality = 5; // RTK Float
        this.satellites = 16;
        this.hdop = 0.8;
      } else {
        this.quality = 4; // RTK Fix
        this.satellites = 21;
        this.hdop = 0.5;
      }
    } else {
      // Degrade quality if we don't get corrections
      this.correctionSeconds = 0;
      this.quality = 1; // SPP
      this.satellites = 8;
      this.hdop = 1.8;
    }

    // 3. Generate GGA Sentence
    const sentence = this.generateGga(
      this.lat,
      this.lon,
      this.quality,
      this.satellites,
      this.hdop,
      baseStats.baseStationId
    );

    this.bytesRx += sentence.length + 2; // +CRLF
    this.emit('data', sentence);

    // 4. Periodically (every 2 seconds) emit GSV sequences
    if (!this.gsvCounter) this.gsvCounter = 0;
    this.gsvCounter++;
    if (this.gsvCounter % 2 === 0) {
      const gsvList = this.generateGsvSequences();
      gsvList.forEach(gsvLine => {
        this.bytesRx += gsvLine.length + 2; // +CRLF
        this.emit('data', gsvLine);
      });
    }
  }

  generateGsvSequences() {
    const time = Date.now() / 25000; // slow orbits animation
    
    // Simulated satellites coordinates
    const sats = [
      { prn: '03', const: 'GP', elev: 45 + Math.sin(time) * 6, azim: 120 + Math.cos(time) * 15, snr: 42 + Math.floor(Math.sin(time)*3) },
      { prn: '08', const: 'GP', elev: 65 + Math.cos(time) * 3, azim: 310 + Math.sin(time) * 10, snr: 46 },
      { prn: '14', const: 'GP', elev: 25 + Math.sin(time) * 10, azim: 45 - Math.cos(time) * 12, snr: 33 },
      { prn: '22', const: 'GP', elev: 12 + Math.cos(time) * 4, azim: 210 + Math.sin(time) * 5, snr: 28 },
      { prn: '01', const: 'GL', elev: 30 + Math.sin(time) * 7, azim: 90 + Math.cos(time) * 12, snr: 38 },
      { prn: '07', const: 'GL', elev: 55 + Math.cos(time) * 4, azim: 260 + Math.sin(time) * 9, snr: 44 },
      { prn: '18', const: 'GL', elev: 72 + Math.sin(time) * 3, azim: 180 - Math.cos(time) * 8, snr: 48 },
      { prn: '12', const: 'GA', elev: 40 + Math.cos(time) * 5, azim: 15 + Math.sin(time) * 8, snr: 40 }
    ];

    const gpSats = sats.filter(s => s.const === 'GP');
    const glSats = sats.filter(s => s.const === 'GL');
    const gaSats = sats.filter(s => s.const === 'GA');

    const sentences = [];

    const formatGsv = (talker, total, num, totalSats, satList) => {
      let body = `${talker}GSV,${total},${num},${totalSats}`;
      satList.forEach(s => {
        body += `,${parseInt(s.prn, 10)},${Math.round(s.elev)},${Math.round(s.azim)},${s.snr}`;
      });
      // Checksum
      let checksum = 0;
      for (let i = 0; i < body.length; i++) {
        checksum ^= body.charCodeAt(i);
      }
      return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
    };

    sentences.push(formatGsv('GP', 1, 1, gpSats.length, gpSats));
    sentences.push(formatGsv('GL', 1, 1, glSats.length, glSats));
    sentences.push(formatGsv('GA', 1, 1, gaSats.length, gaSats));

    return sentences;
  }

  generateGga(lat, lon, quality, satCount, hdop, baseStationId) {
    // Format latitude: DDMM.MMMMM
    const latDeg = Math.floor(Math.abs(lat));
    const latMin = (Math.abs(lat) - latDeg) * 60.0;
    const latStr = `${latDeg.toString().padStart(2, '0')}${latMin.toFixed(5)}`;
    const latDir = lat >= 0 ? 'N' : 'S';

    // Format longitude: DDDMM.MMMMM
    const lonDeg = Math.floor(Math.abs(lon));
    const lonMin = (Math.abs(lon) - lonDeg) * 60.0;
    const lonStr = `${lonDeg.toString().padStart(3, '0')}${lonMin.toFixed(5)}`;
    const lonDir = lon >= 0 ? 'E' : 'W';

    // UTC Time
    const now = new Date();
    const timeStr = `${now.getUTCHours().toString().padStart(2, '0')}${now.getUTCMinutes().toString().padStart(2, '0')}${now.getUTCSeconds().toString().padStart(2, '0')}.00`;

    const alt = 45.3 + Math.sin(Date.now() / 10000) * 2; // slight height oscillation
    const corrAge = quality > 1 ? '1.2' : '';
    const refStation = baseStationId !== null ? baseStationId.toString().padStart(4, '0') : '0000';

    const body = `GPGGA,${timeStr},${latStr},${latDir},${lonStr},${lonDir},${quality},${satCount.toString().padStart(2, '0')},${hdop.toFixed(1)},${alt.toFixed(1)},M,0.0,M,${corrAge},${refStation}`;

    // Calculate NMEA Checksum
    let checksum = 0;
    for (let i = 0; i < body.length; i++) {
      checksum ^= body.charCodeAt(i);
    }
    const hexChecksum = checksum.toString(16).toUpperCase().padStart(2, '0');

    return `$${body}*${hexChecksum}`;
  }
}

class SerialPortManager {
  constructor() {
    this.ports = {}; // portId -> { config, portObj, parserObj, stats }
    this.ggaCallback = null;
    this.rawDataCallback = null;
  }

  // Set the callback triggered whenever a GGA sentence is parsed
  onGgaReceived(callback) {
    this.ggaCallback = callback;
  }

  // Set the callback triggered for every raw chunk received from any port
  onRawData(callback) {
    this.rawDataCallback = callback;
  }

  // Get physical system serial ports
  async listAvailablePorts() {
    if (!SerialPort) {
      return [{ path: 'MOCK_PORT_A', manufacturer: 'Virtual Driver' }];
    }
    try {
      const list = await SerialPort.list();
      return list;
    } catch (err) {
      console.error('[SerialManager] Error listing ports:', err.message);
      return [];
    }
  }

  // Configure and open ports incrementally (only opening new/changed, keeping connected ones running)
  configurePorts(serialConfigs) {
    // 1. Remove deleted or disabled ports, or reconfigure changed ports
    Object.keys(this.ports).forEach(portId => {
      const portData = this.ports[portId];
      const newConfig = serialConfigs.find(c => c.id === portId);

      if (!newConfig || !newConfig.enabled) {
        // Port was removed or disabled
        console.log(`[SerialManager] Closing removed or disabled port: ${portData.config.portName}`);
        if (portData.portObj && portData.stats.connected) {
          portData.portObj.close();
        }
        delete this.ports[portId];
      } else {
        // Port exists. Check if core connection parameters changed
        const coreChanged = 
          portData.config.portName !== newConfig.portName ||
          portData.config.baudRate !== newConfig.baudRate ||
          portData.config.isSimulated !== newConfig.isSimulated;

        if (coreChanged) {
          console.log(`[SerialManager] Reconfiguring core parameters for: ${portData.config.portName}`);
          if (portData.portObj && portData.stats.connected) {
            portData.portObj.close();
          }
          delete this.ports[portId];
        } else {
          // Connection parameters are identical, just update telemetry settings dynamically
          console.log(`[SerialManager] Dynamic settings update for: ${portData.config.portName}`);
          portData.config.sendGgaToCaster = !!newConfig.sendGgaToCaster;
          portData.config.receiveRtcm = !!newConfig.receiveRtcm;
          portData.config.simulatedSpeed = newConfig.simulatedSpeed;
          portData.config.startLat = newConfig.startLat;
          portData.config.startLon = newConfig.startLon;
          
          if (portData.config.isSimulated && portData.portObj) {
            portData.portObj.config = portData.config;
          }
        }
      }
    });

    // 2. Initialize and open NEW or reconfigured ports
    serialConfigs.forEach(config => {
      if (!config.enabled) return;

      const portId = config.id;
      
      // If port already exists and is running, skip it!
      if (this.ports[portId]) {
        return;
      }

      const portStats = {
        bytesRx: 0,
        bytesTx: 0,
        cmdBytesTx: 0,
        connected: false,
        error: null
      };

      let portObj = null;

      if (config.isSimulated || !SerialPort) {
        console.log(`[SerialManager] Starting Virtual Serial Port: ${config.portName}`);
        portObj = new MockSerialPort(config);
      } else {
        console.log(`[SerialManager] Opening Physical Serial Port: ${config.portName} @ ${config.baudRate}`);
        try {
          portObj = new SerialPort({
            path: config.portName,
            baudRate: parseInt(config.baudRate, 10),
            autoOpen: false
          });
        } catch (err) {
          console.error(`[SerialManager] Failed to create port ${config.portName}:`, err.message);
          portStats.error = err.message;
          this.ports[portId] = { config, portStats };
          return;
        }
      }

      this.ports[portId] = {
        config,
        portObj,
        stats: portStats
      };
      
      this.openPort(portId);
    });
  }

  // Open a configured port
  openPort(portId) {
    const portData = this.ports[portId];
    if (!portData || !portData.portObj) return;

    portData.portObj.open((err) => {
      if (err) {
        console.error(`[SerialManager] Error opening ${portData.config.portName}:`, err.message);
        portData.stats.connected = false;
        portData.stats.error = err.message;
        return;
      }

      portData.stats.connected = true;
      portData.stats.error = null;
      console.log(`[SerialManager] Connected to ${portData.config.portName}`);

      // Handle data streams
      if (portData.config.isSimulated || !SerialPort) {
        // Mock port triggers NMEA lines directly
        portData.portObj.on('data', (line) => {
          this.handlePortLine(portId, line);
        });
      } else {
        // Log raw origin mixed ASCII/binary data directly from physical serial port
        portData.portObj.on('data', (chunk) => {
          portData.stats.bytesRx += chunk.length;
          logger.logSerialRx(portData.config.portName, chunk);
          if (this.rawDataCallback) this.rawDataCallback(portId, chunk);
        });

        // Physical port requires parsing byte-by-byte for complete text lines
        const parser = portData.portObj.pipe(new ReadlineParser({ delimiter: '\r\n' }));
        portData.parserObj = parser;
        parser.on('data', (line) => {
          this.handlePortLine(portId, line);
        });
      }
    });
  }

  // Process NMEA line read from a port
  handlePortLine(portId, line) {
    const portData = this.ports[portId];
    if (!portData) return;

    // For simulated ports, we count bytes and log raw data here since there is no raw hardware event
    if (portData.config.isSimulated || !SerialPort) {
      const buf = Buffer.from(line + '\r\n', 'utf8');
      portData.stats.bytesRx += buf.length;
      logger.logSerialRx(portData.config.portName, buf);
      if (this.rawDataCallback) this.rawDataCallback(portId, buf);
    }

    // Feed to NMEA parser (handles both GGA and GSV)
    const parsed = nmeaParser.parseNmea(portData.config.portName, line);
    if (parsed && parsed.sentenceType === 'GGA' && portData.config.sendGgaToCaster && this.ggaCallback) {
      // Feed GGA sentence to the NTRIP caster handler
      this.ggaCallback(line);
    }
  }

  // Forward RTCM Corrections to designated serial ports
  forwardRtcm(rtcmData) {
    Object.keys(this.ports).forEach(portId => {
      const portData = this.ports[portId];
      if (
        portData &&
        portData.portObj &&
        portData.stats.connected &&
        portData.config.receiveRtcm
      ) {
        portData.portObj.write(rtcmData, (err) => {
          if (err) {
            console.error(`[SerialManager] Write error on ${portData.config.portName}:`, err.message);
            portData.stats.error = err.message;
          } else {
            portData.stats.bytesTx += rtcmData.length;
            // TX corrections are forwarded to the physical serial port but NOT logged to the rover's NMEA file
          }
        });
      }
    });
  }

  // Get active status and byte count for all serial ports
  getPortStatuses() {
    const statuses = {};
    Object.keys(this.ports).forEach(portId => {
      const portData = this.ports[portId];
      // Sync simulated port bytes directly
      if (portData.config.isSimulated && portData.portObj) {
        portData.stats.bytesRx = portData.portObj.bytesRx;
        portData.stats.bytesTx = portData.portObj.bytesTx;
      }
      statuses[portId] = {
        portName: portData.config.portName,
        isSimulated: portData.config.isSimulated,
        enabled: portData.config.enabled,
        sendGgaToCaster: portData.config.sendGgaToCaster,
        receiveRtcm: portData.config.receiveRtcm,
        connected: portData.stats.connected,
        error: portData.stats.error,
        bytesRx: portData.stats.bytesRx,
        bytesTx: portData.stats.bytesTx,
        cmdBytesTx: portData.stats.cmdBytesTx
      };
    });
    return statuses;
  }

  // Send a raw command buffer to a specific port by ID
  sendCommand(portId, data) {
    const portData = this.ports[portId];
    if (!portData) return { success: false, error: `Port ID "${portId}" not found` };
    if (!portData.portObj || !portData.stats.connected) {
      return { success: false, error: `Port "${portData.config.portName}" is not connected` };
    }

    portData.portObj.write(data, (err) => {
      if (err) {
        console.error(`[SerialManager] Command write error on ${portData.config.portName}:`, err.message);
        portData.stats.error = err.message;
      } else {
        portData.stats.cmdBytesTx += data.length;
        logger.logSerialTx(portData.config.portName, data);
        console.log(`[SerialManager] Sent ${data.length} bytes to ${portData.config.portName}`);
      }
    });

    return { success: true, portName: portData.config.portName, bytes: data.length };
  }

  // Close all open ports
  closeAll() {
    Object.keys(this.ports).forEach(portId => {
      const portData = this.ports[portId];
      if (portData && portData.portObj && portData.stats.connected) {
        console.log(`[SerialManager] Closing port ${portData.config.portName}`);
        portData.portObj.close();
      }
    });
    this.ports = {};
  }
}

module.exports = new SerialPortManager();

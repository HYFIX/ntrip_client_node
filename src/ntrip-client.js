const net = require('net');
const logger = require('./logger');
const rtcmParser = require('./rtcm-parser');

class NtripClient {
  constructor() {
    this.socket = null;
    this.config = null;
    this.status = {
      connected: false,
      connecting: false,
      bytesReceived: 0,
      mountpoint: '',
      host: '',
      port: 0,
      error: null
    };
    
    this.reconnectTimer = null;
    this.ggaTimer = null;
    this.lastGga = null;
    this.headersParsed = false;
    this.onRtcmDataCallback = null;
    this.onRawRtcmCallback = null;
    this.onStatusChangeCallback = null;
  }

  // Set callbacks
  onRtcmData(callback) {
    this.onRtcmDataCallback = callback;
  }

  onRawRtcm(callback) {
    this.onRawRtcmCallback = callback;
  }

  onStatusChange(callback) {
    this.onStatusChangeCallback = callback;
  }

  // Connect to NTRIP Caster
  connect(config) {
    this.disconnect(); // Close any existing connections first
    this.config = config;

    this.status.connecting = true;
    this.status.connected = false;
    this.status.error = null;
    this.status.host = config.host;
    this.status.port = config.port;
    this.status.mountpoint = config.mountpoint;
    this.status.bytesReceived = 0;
    
    this.headersParsed = false;
    this.notifyStatus();

    console.log(`[NtripClient] Connecting to ${config.host}:${config.port}/${config.mountpoint}...`);

    this.socket = net.createConnection({
      host: config.host,
      port: parseInt(config.port, 10)
    });

    this.socket.on('connect', () => {
      console.log('[NtripClient] Socket connected, sending HTTP GET request...');
      this.sendRequest();
    });

    this.socket.on('data', (chunk) => {
      this.handleIncomingData(chunk);
    });

    this.socket.on('close', (hadError) => {
      console.log('[NtripClient] Connection closed.');
      this.handleDisconnect(hadError ? 'Socket closed due to transmission error' : null);
    });

    this.socket.on('error', (err) => {
      console.error('[NtripClient] Socket error:', err.message);
      this.status.error = err.message;
      this.notifyStatus();
    });
  }

  // Disconnect from caster
  disconnect() {
    this.stopGgaInterval();
    this.stopReconnectTimer();

    if (this.socket) {
      console.log('[NtripClient] Closing connection manually...');
      this.socket.destroy();
      this.socket = null;
    }

    if (this.status.connected || this.status.connecting) {
      this.status.connected = false;
      this.status.connecting = false;
      this.notifyStatus();
    }
  }

  // Construct and send the HTTP GET request with Basic Authorization
  sendRequest() {
    if (!this.socket || !this.config) return;

    const authStr = `${this.config.username}:${this.config.password}`;
    const base64Auth = Buffer.from(authStr).toString('base64');
    
    // Construct standard NTRIP GET request headers
    // Support standard Ntrip/2.0 headers, falling back to typical Ntrip HTTP request
    let headers = '';
    headers += `GET /${this.config.mountpoint} HTTP/1.1\r\n`;
    headers += `Host: ${this.config.host}:${this.config.port}\r\n`;
    headers += `Ntrip-Version: Ntrip/2.0\r\n`;
    headers += `User-Agent: NTRIP AntigravityClient/1.0\r\n`;
    headers += `Authorization: Basic ${base64Auth}\r\n`;
    headers += `Accept: */*\r\n`;
    headers += `Connection: keep-alive\r\n`;

    // Proactively embed the last known GGA sentence if available
    if (this.config.sendGga && this.lastGga) {
      headers += `Ntrip-GGA: ${this.lastGga.trim()}\r\n`;
    }

    headers += `\r\n`; // Ending empty line
    this.socket.write(headers);
  }

  // Handle bytes streaming from TCP socket
  handleIncomingData(chunk) {
    if (!this.headersParsed) {
      // We haven't parsed the HTTP headers yet
      const text = chunk.toString('utf8');
      
      // Inspect standard responses like 'HTTP/1.1 200 OK' or ICY response 'ICY 200 OK'
      const hasOk = text.includes('200 OK') || text.includes('ICY 200');
      const hasError = text.includes('HTTP/') && !hasOk;

      if (hasOk) {
        this.headersParsed = true;
        this.status.connected = true;
        this.status.connecting = false;
        this.status.error = null;
        console.log(`[NtripClient] Connection authorized! RTCM correction stream started.`);
        this.notifyStatus();

        // Start periodic GGA streaming interval
        this.startGgaInterval();

        // Extract payload start if standard headers are in this chunk
        const headerEndIdx = chunk.indexOf('\r\n\r\n');
        if (headerEndIdx !== -1) {
          const payloadStart = chunk.slice(headerEndIdx + 4);
          if (payloadStart.length > 0) {
            this.processRtcmData(payloadStart);
          }
        }
      } else if (hasError) {
        // Parse authorization or mountpoint errors
        const line = text.split('\r\n')[0];
        console.error('[NtripClient] Authorization rejected:', line);
        this.status.error = `Rejected: ${line}`;
        this.disconnect();
      } else {
        // Partial or waiting header bytes, do nothing
      }
    } else {
      // Stream is actively flowing RTCM bytes
      this.processRtcmData(chunk);
    }
  }

  // Process incoming RTCM frames
  processRtcmData(chunk) {
    this.status.bytesReceived += chunk.length;
    
    // Log RTCM binary stream to disk
    if (this.config) {
      logger.logCasterRx(this.config.mountpoint, chunk);
    }

    // Forward raw RTCM bytes to physical/mock serial ports
    if (this.onRawRtcmCallback) {
      this.onRawRtcmCallback(chunk);
    }

    // Feed raw bytes into RTCM Parser to parse Base details
    rtcmParser.feed(chunk, (parsedPacket) => {
      if (this.onRtcmDataCallback) {
        this.onRtcmDataCallback(parsedPacket);
      }
    });

    // Notify listeners of bytes received increase
    this.notifyStatus();
  }

  // Write new GGA sentences received from active serial port
  sendGga(ggaSentence) {
    if (!ggaSentence || typeof ggaSentence !== 'string') return;
    
    this.lastGga = ggaSentence.trim();

    if (this.status.connected && this.socket && this.config && this.config.sendGga) {
      // Send GGA sentence to socket
      this.socket.write(`${this.lastGga}\r\n`);
      console.log('[NtripClient] Streaming updated GGA to caster:', this.lastGga);
    }
  }

  // Send the periodic GGA string (VRS heartbeat)
  startGgaInterval() {
    this.stopGgaInterval();

    const interval = this.config ? this.config.ggaInterval || 5000 : 5000;
    this.ggaTimer = setInterval(() => {
      if (this.status.connected && this.socket && this.lastGga) {
        this.socket.write(`${this.lastGga}\r\n`);
        console.log('[NtripClient] Sending periodic GGA heartbeat:', this.lastGga);
      }
    }, interval);
  }

  stopGgaInterval() {
    if (this.ggaTimer) {
      clearInterval(this.ggaTimer);
      this.ggaTimer = null;
    }
  }

  // Handle socket closed or crashed
  handleDisconnect(errorReason) {
    this.stopGgaInterval();
    this.status.connected = false;
    this.status.connecting = false;
    
    if (errorReason) {
      this.status.error = errorReason;
    }

    this.notifyStatus();

    // Start auto-reconnection
    if (this.config && this.config.autoReconnect) {
      this.startReconnectTimer();
    }
  }

  startReconnectTimer() {
    this.stopReconnectTimer();
    const delay = this.config ? this.config.reconnectDelay || 5000 : 5000;
    
    console.log(`[NtripClient] Scheduling automatic reconnect in ${delay}ms...`);
    
    this.reconnectTimer = setTimeout(() => {
      if (this.config) {
        this.connect(this.config);
      }
    }, delay);
  }

  stopReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  notifyStatus() {
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback({
        ...this.status,
        rtcmParserStats: rtcmParser.getStats()
      });
    }
  }

  // Retrieve current active telemetry
  getTelemetry() {
    return {
      ...this.status,
      rtcmParserStats: rtcmParser.getStats()
    };
  }
}

module.exports = new NtripClient();

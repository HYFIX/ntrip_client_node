const net = require('net');

class PortUploader {
  constructor(portId, config) {
    this.portId = portId;
    this.config = config;
    this.socket = null;
    this.connected = false;
    this.handshakeDone = false;
    this.reconnectTimer = null;
    this.bytesSent = 0;
    this.status = 'connecting';
    this.statusMsg = '';
    this._connect();
  }

  _connect() {
    this.status = 'connecting';
    this.statusMsg = '';
    this.handshakeDone = false;

    const socket = net.createConnection({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.setTimeout(10000);

    let headerBuf = '';

    socket.on('connect', () => {
      socket.setTimeout(0);
      const mp = (this.config.mountpoint || '').replace(/^\//, '');
      const password = this.config.password || '';
      const username = this.config.username || 'anonymous';

      let request;
      if (this.config.ntripVersion === '2.0') {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        request = [
          `POST /${mp} HTTP/1.1`,
          `Host: ${this.config.host}:${this.config.port}`,
          `Ntrip-Version: Ntrip/2.0`,
          `Authorization: Basic ${auth}`,
          `Content-Type: gnss/data`,
          `Transfer-Encoding: chunked`,
          '', ''
        ].join('\r\n');
      } else {
        // NTRIP 1.0 SOURCE method (standard for data providers / base stations)
        request = [
          `SOURCE ${password} /${mp}`,
          `Source-Agent: NTRIP NodeClient/1.0`,
          `Content-Type: gnss/data`,
          '', ''
        ].join('\r\n');
      }

      socket.write(request);
    });

    socket.on('data', (data) => {
      if (this.handshakeDone) return;
      headerBuf += data.toString('ascii');
      if (!headerBuf.includes('\r\n')) return;

      if (/200 OK|ICY 200/i.test(headerBuf)) {
        this.handshakeDone = true;
        this.connected = true;
        this.status = 'connected';
        this.statusMsg = '';
        console.log(`[Uploader:${this.portId}] Connected → ${this.config.host}:${this.config.port}/${this.config.mountpoint}`);
      } else if (/401|403/.test(headerBuf)) {
        this.status = 'error';
        this.statusMsg = 'Auth failed (401/403)';
        console.error(`[Uploader:${this.portId}] ${this.statusMsg}`);
        socket.destroy();
      } else {
        const first = headerBuf.split('\r\n')[0].trim().substring(0, 60);
        this.status = 'error';
        this.statusMsg = first || 'Rejected';
        console.error(`[Uploader:${this.portId}] Caster rejected: ${first}`);
        socket.destroy();
      }
    });

    socket.on('timeout', () => {
      this.status = 'error';
      this.statusMsg = 'Timeout';
      socket.destroy();
    });

    socket.on('error', (err) => {
      this.connected = false;
      this.handshakeDone = false;
      if (this.status !== 'error') {
        this.status = 'error';
        this.statusMsg = err.message;
      }
    });

    socket.on('close', () => {
      this.connected = false;
      this.handshakeDone = false;
      if (this.status === 'connected') this.status = 'disconnected';
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket) { this.socket.destroy(); this.socket = null; }
      this._connect();
    }, 5000);
  }

  send(data) {
    if (!this.connected || !this.handshakeDone || !this.socket) return;
    if (this.config.ntripVersion === '2.0') {
      const hexLen = data.length.toString(16);
      this.socket.write(`${hexLen}\r\n`);
      this.socket.write(data);
      this.socket.write('\r\n');
    } else {
      this.socket.write(data);
    }
    this.bytesSent += data.length;
  }

  destroy() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    this.connected = false;
  }

  getTelemetry() {
    return {
      status: this.status,
      statusMsg: this.statusMsg,
      bytesSent: this.bytesSent,
      host: this.config.host,
      mountpoint: this.config.mountpoint
    };
  }
}

class NtripUploaderManager {
  constructor() {
    this.uploaders = {};
  }

  configure(serialPortConfigs) {
    const activeIds = new Set();

    for (const portConfig of serialPortConfigs) {
      const ul = portConfig.uploader;
      if (!portConfig.enabled || !ul || !ul.enabled || !ul.host || !ul.mountpoint) {
        this._destroy(portConfig.id);
        continue;
      }

      activeIds.add(portConfig.id);
      const existing = this.uploaders[portConfig.id];

      if (existing && this._sameConfig(existing.config, ul)) continue;

      this._destroy(portConfig.id);
      this.uploaders[portConfig.id] = new PortUploader(portConfig.id, ul);
    }

    for (const portId of Object.keys(this.uploaders)) {
      if (!activeIds.has(portId)) this._destroy(portId);
    }
  }

  _sameConfig(a, b) {
    return a.host === b.host && String(a.port) === String(b.port) &&
      a.mountpoint === b.mountpoint && a.password === b.password &&
      a.username === b.username && a.ntripVersion === b.ntripVersion;
  }

  _destroy(portId) {
    if (this.uploaders[portId]) {
      this.uploaders[portId].destroy();
      delete this.uploaders[portId];
    }
  }

  feed(portId, data) {
    if (this.uploaders[portId]) this.uploaders[portId].send(data);
  }

  getStatuses() {
    const out = {};
    for (const [id, ul] of Object.entries(this.uploaders)) out[id] = ul.getTelemetry();
    return out;
  }
}

module.exports = new NtripUploaderManager();

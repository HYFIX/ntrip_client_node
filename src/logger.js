const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

class StreamLogger {
  constructor() {
    this.streams = {};
  }

  // Helper to get or create a write stream for a specific file
  getStream(filename, isBinary = false) {
    if (this.streams[filename]) {
      return this.streams[filename];
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${year}_${month}_${day}_${hour}_${min}_${sec}`;

    const baseName = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename);
    const datedFilename = `${baseName}_${timestamp}${ext}`;
    const fullPath = path.join(LOGS_DIR, datedFilename);

    const stream = fs.createWriteStream(fullPath, {
      flags: 'a',
      encoding: isBinary ? null : 'utf8'
    });

    this.streams[filename] = stream;
    return stream;
  }

  // Log data received from a serial port (mixed ASCII/binary raw data from serial)
  logSerialRx(portName, data) {
    try {
      const cleanName = portName.replace(/[^a-zA-Z0-9_]/g, '_');
      const filename = `rover_${cleanName}.nmea`;
      const stream = this.getStream(filename, true); // Open in binary write mode
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      
      // Store in mixed ASCII/Binary format to preserve raw binary
      const header = `$GEOD,${Date.now()},${buf.length},`;
      const footer = '\r\n';
      const frame = Buffer.concat([
        Buffer.from(header, 'utf8'),
        buf,
        Buffer.from(footer, 'utf8')
      ]);
      
      stream.write(frame);
    } catch (err) {
      console.error(`[Logger] Error logging serial RX for ${portName}:`, err.message);
    }
  }

  // Log data written to a serial port (typically RTCM corrections)
  logSerialTx(portName, data) {
    try {
      const cleanName = portName.replace(/[^a-zA-Z0-9_]/g, '_');
      const filename = `rover_${cleanName}.nmea`;
      const stream = this.getStream(filename, true); // Open in binary write mode
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      
      // Store in mixed ASCII/Binary format to preserve raw binary
      const header = `$GEOD,${Date.now()},${buf.length},`;
      const footer = '\r\n';
      const frame = Buffer.concat([
        Buffer.from(header, 'utf8'),
        buf,
        Buffer.from(footer, 'utf8')
      ]);
      
      stream.write(frame);
    } catch (err) {
      console.error(`[Logger] Error logging serial TX for ${portName}:`, err.message);
    }
  }

  // Log raw RTCM bytes from NTRIP Caster
  logCasterRx(mountpoint, data) {
    try {
      const cleanMount = mountpoint.replace(/[^a-zA-Z0-9_]/g, '_');
      const binFilename = `caster_${cleanMount}.rtcm`;
      const binStream = this.getStream(binFilename, true); // Open in binary write mode
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      
      // Store in mixed ASCII/Binary format to preserve raw binary
      const header = `$GEOD,${Date.now()},${buf.length},`;
      const footer = '\r\n';
      const frame = Buffer.concat([
        Buffer.from(header, 'utf8'),
        buf,
        Buffer.from(footer, 'utf8')
      ]);
      
      binStream.write(frame);

      // Also log human-readable stats in an ASCII text file using the old format
      const txtFilename = `caster_${cleanMount}_activity.log`;
      const txtStream = this.getStream(txtFilename, false);
      const timestamp = new Date().toISOString();
      txtStream.write(`[${timestamp}] Received ${buf.length} bytes of RTCM corrections\n`);
    } catch (err) {
      console.error(`[Logger] Error logging caster RTCM for ${mountpoint}:`, err.message);
    }
  }

  // List all log files
  getLogFiles() {
    try {
      if (!fs.existsSync(LOGS_DIR)) return [];
      const files = fs.readdirSync(LOGS_DIR);
      return files.map(file => {
        const stats = fs.statSync(path.join(LOGS_DIR, file));
        return {
          name: file,
          size: stats.size,
          updatedAt: stats.mtime
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      console.error('[Logger] Error listing logs:', err.message);
      return [];
    }
  }

  // Read end of log file
  readLogFile(filename, maxLines = 100) {
    try {
      const fullPath = path.join(LOGS_DIR, filename);
      if (!fs.existsSync(fullPath)) return 'File not found';
      
      // For binary RTCM and NMEA logs, return size and formatted parsed $GEOD records
      if (filename.endsWith('.rtcm') || filename.endsWith('.nmea')) {
        const buffer = fs.readFileSync(fullPath);
        let offset = 0;
        const parsedLines = [];
        
        while (offset < buffer.length) {
          const magicIndex = buffer.indexOf(Buffer.from('$GEOD,'), offset);
          if (magicIndex === -1) break;
          
          let searchIdx = magicIndex;
          let commaIndices = [];
          while (commaIndices.length < 3 && searchIdx < buffer.length) {
            if (buffer[searchIdx] === 44) { // ',' character code is 44
              commaIndices.push(searchIdx);
            }
            searchIdx++;
          }
          
          if (commaIndices.length < 3) break;
          
          const timestamp = buffer.toString('utf8', commaIndices[0] + 1, commaIndices[1]);
          const lengthStr = buffer.toString('utf8', commaIndices[1] + 1, commaIndices[2]);
          const payloadLength = parseInt(lengthStr, 10);
          
          if (isNaN(payloadLength)) {
            offset = commaIndices[2] + 1;
            continue;
          }
          
          const payloadStart = commaIndices[2] + 1;
          const payloadEnd = payloadStart + payloadLength;
          
          if (payloadEnd > buffer.length) {
            break;
          }
          
          const payload = buffer.slice(payloadStart, payloadEnd);
          const hexPayload = payload.toString('hex');
          let timeString = 'Unknown';
          try {
            timeString = new Date(parseInt(timestamp, 10)).toISOString().split('T')[1].replace('Z', '');
          } catch (e) {}
          
          // Determine display payload based on log file extension
          const payloadStr = payload.toString('utf8');
          let displayPayload = '';
          if (filename.endsWith('.nmea')) {
            // For rover NMEA files, try to display as printable ASCII, replacing control bytes with dots
            displayPayload = payloadStr.replace(/[^\x20-\x7E\r\n\t]/g, '.').trim();
          } else {
            // For RTCM caster log files, default to hex unless it is printable ASCII
            const isAscii = /^[\x20-\x7E\r\n\t]*$/.test(payloadStr);
            displayPayload = isAscii 
              ? payloadStr.trim() 
              : `Hex: ${hexPayload.substring(0, 64)}${hexPayload.length > 64 ? '...' : ''}`;
          }
            
          parsedLines.push(`[$GEOD at ${timeString}] Len: ${payloadLength} | ${displayPayload}`);
          
          offset = payloadEnd + 2; // +CRLF
        }
        
        const fileType = filename.endsWith('.rtcm') ? 'RTCM' : 'NMEA';
        let output = `[${fileType} Log File - Size: ${buffer.length} bytes]\n\n`;
        if (parsedLines.length > 0) {
          const recentLines = parsedLines.slice(Math.max(0, parsedLines.length - maxLines));
          output += recentLines.join('\n');
        } else {
          // Fallback to simple snippet if parsing failed (e.g. legacy logs)
          const snippet = buffer.slice(Math.max(0, buffer.length - 512));
          const hexLines = snippet.toString('hex').match(/.{1,32}/g)?.join('\n') || '';
          output += `Could not parse structured $GEOD frames (legacy log format). Hex dump:\n${hexLines}`;
        }
        return output;
      }

      // ASCII file logs
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop(); // Remove trailing empty line
      }
      return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
    } catch (err) {
      return `Error reading log file: ${err.message}`;
    }
  }

  // Close all streams
  closeAll() {
    Object.keys(this.streams).forEach(key => {
      this.streams[key].end();
      delete this.streams[key];
    });
  }
}

module.exports = new StreamLogger();

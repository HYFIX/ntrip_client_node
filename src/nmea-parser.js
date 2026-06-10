/**
 * Parsers NMEA GGA Sentences
 * Example: $GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
 */

class NmeaParser {
  constructor() {
    this.stats = {};
  }

  // Initialize stats for a serial port
  initPortStats(portName) {
    if (!this.stats[portName]) {
      this.stats[portName] = {
        portName,
        totalGga: 0,
        sppCount: 0,
        dgpsCount: 0,
        rtkFloatCount: 0,
        rtkFixCount: 0,
        otherQualityCount: 0,
        fixRate: 0,
        lastLatitude: null,
        lastLongitude: null,
        lastAltitude: null,
        lastQuality: 0,
        lastSatellites: 0,
        lastHdop: null,
        lastCorrectionAge: null,
        lastBaseStationId: null,
        trajectory: [], // Array of {lat, lon, alt, timestamp}
        satellitesMap: {}, // satKey -> satellite data
        satellitesList: [] // compiled list for skyplot
      };
    }
    return this.stats[portName];
  }

  // Convert NMEA Latitude/Longitude (DDMM.MMMM) to Decimal Degrees (DD.DDDD)
  nmeaToDecimal(value, direction) {
    if (!value || !direction) return null;

    const dotIndex = value.indexOf('.');
    if (dotIndex === -1) return null;

    // Degrees are the characters before the last 2 digits before the dot
    const degreesPartLength = dotIndex - 2;
    if (degreesPartLength <= 0) return null;

    const degrees = parseFloat(value.substring(0, degreesPartLength));
    const minutes = parseFloat(value.substring(degreesPartLength));

    let decimal = degrees + minutes / 60.0;
    if (direction === 'S' || direction === 'W') {
      decimal = -decimal;
    }

    return parseFloat(decimal.toFixed(8));
  }

  // Parse a single raw GGA sentence
  parseGga(portName, line) {
    const portStats = this.initPortStats(portName);
    
    // Check if line is a GGA sentence
    if (!line || typeof line !== 'string') return null;
    const cleanLine = line.trim();
    if (!cleanLine.startsWith('$') || !cleanLine.includes('GGA')) return null;

    // Optional Checksum Validation
    const starIndex = cleanLine.lastIndexOf('*');
    if (starIndex !== -1) {
      const sentenceWithoutChecksum = cleanLine.substring(1, starIndex);
      const hexChecksum = cleanLine.substring(starIndex + 1);
      let calculatedChecksum = 0;
      for (let i = 0; i < sentenceWithoutChecksum.length; i++) {
        calculatedChecksum ^= sentenceWithoutChecksum.charCodeAt(i);
      }
      const calculatedHex = calculatedChecksum.toString(16).toUpperCase().padStart(2, '0');
      if (calculatedHex !== hexChecksum.toUpperCase()) {
        console.warn(`[NMEA] Checksum failed for ${portName}: calculated ${calculatedHex}, got ${hexChecksum}`);
        // We still attempt to parse but alert
      }
    }

    const fields = cleanLine.split(',');
    if (fields.length < 15) return null;

    const time = fields[1];
    const rawLat = fields[2];
    const latDir = fields[3];
    const rawLon = fields[4];
    const lonDir = fields[5];
    const quality = parseInt(fields[6], 10);
    const satellites = parseInt(fields[7], 10);
    const hdop = parseFloat(fields[8]);
    const altitude = parseFloat(fields[9]);
    const correctionAge = fields[13] ? parseFloat(fields[13]) : null;
    const baseStationId = fields[14] ? fields[14].split('*')[0].trim() : null;

    const latitude = this.nmeaToDecimal(rawLat, latDir);
    const longitude = this.nmeaToDecimal(rawLon, lonDir);

    if (latitude === null || longitude === null) {
      return null; // Invalid position data
    }

    // Update aggregated stats
    portStats.totalGga++;
    portStats.lastLatitude = latitude;
    portStats.lastLongitude = longitude;
    portStats.lastAltitude = altitude || 0;
    portStats.lastQuality = isNaN(quality) ? 0 : quality;
    portStats.lastSatellites = isNaN(satellites) ? 0 : satellites;
    portStats.lastHdop = isNaN(hdop) ? null : hdop;
    portStats.lastCorrectionAge = isNaN(correctionAge) ? null : correctionAge;
    portStats.lastBaseStationId = baseStationId || null;

    // Quality categories:
    // 0 = Invalid
    // 1 = SPP (SPS)
    // 2 = DGPS
    // 3 = PPS
    // 4 = RTK Fix
    // 5 = RTK Float
    // 6 = Dead reckoning
    // 7 = Manual
    // 8 = Simulator
    if (quality === 1 || quality === 3) {
      portStats.sppCount++;
    } else if (quality === 2) {
      portStats.dgpsCount++;
    } else if (quality === 4) {
      portStats.rtkFixCount++;
    } else if (quality === 5) {
      portStats.rtkFloatCount++;
    } else {
      portStats.otherQualityCount++;
    }

    // Calculate RTK Fix Rate (percentage of valid GPS fixes that are RTK Fixed)
    const validFixesCount = portStats.sppCount + portStats.dgpsCount + portStats.rtkFloatCount + portStats.rtkFixCount;
    if (validFixesCount > 0) {
      portStats.fixRate = parseFloat(((portStats.rtkFixCount / validFixesCount) * 100).toFixed(1));
    } else {
      portStats.fixRate = 0;
    }

    // Add to rover trajectory trail
    const timestamp = Date.now();
    portStats.trajectory.push({
      latitude,
      longitude,
      altitude: portStats.lastAltitude,
      quality: portStats.lastQuality,
      timestamp
    });

    // Limit trajectory trail length to 100 entries to prevent memory swelling
    if (portStats.trajectory.length > 100) {
      portStats.trajectory.shift();
    }

    return {
      portName,
      latitude,
      longitude,
      altitude: portStats.lastAltitude,
      quality: portStats.lastQuality,
      satellites: portStats.lastSatellites,
      hdop: portStats.lastHdop,
      correctionAge: portStats.lastCorrectionAge,
      baseStationId: portStats.lastBaseStationId,
      timestamp
    };
  }

  // Get current stats for a specific port
  getPortStats(portName) {
    return this.stats[portName] || this.initPortStats(portName);
  }

  // Get current stats for all ports
  getAllStats() {
    return this.stats;
  }

  // Clear stats for a port
  resetPortStats(portName) {
    delete this.stats[portName];
    return this.initPortStats(portName);
  }
  // Parse NMEA message router (GGA & GSV)
  parseNmea(portName, line) {
    if (!line || typeof line !== 'string') return null;
    const cleanLine = line.trim();
    if (!cleanLine.startsWith('$')) return null;

    if (cleanLine.includes('GGA')) {
      const parsed = this.parseGga(portName, cleanLine);
      if (parsed) parsed.sentenceType = 'GGA';
      return parsed;
    } else if (cleanLine.includes('GSV')) {
      return this.parseGsv(portName, cleanLine);
    }
    return null;
  }

  // Parse a GSV satellites in view message
  parseGsv(portName, line) {
    const portStats = this.initPortStats(portName);
    if (!line || typeof line !== 'string') return null;
    const cleanLine = line.trim();

    // Checksum Validation
    const starIndex = cleanLine.lastIndexOf('*');
    if (starIndex !== -1) {
      const sentenceWithoutChecksum = cleanLine.substring(1, starIndex);
      const hexChecksum = cleanLine.substring(starIndex + 1);
      let calculatedChecksum = 0;
      for (let i = 0; i < sentenceWithoutChecksum.length; i++) {
        calculatedChecksum ^= sentenceWithoutChecksum.charCodeAt(i);
      }
      const calculatedHex = calculatedChecksum.toString(16).toUpperCase().padStart(2, '0');
      if (calculatedHex !== hexChecksum.toUpperCase()) {
        console.warn(`[NMEA] GSV Checksum failed for ${portName}`);
      }
    }

    const fields = cleanLine.split(',');
    if (fields.length < 4) return null;

    const totalMsgs = parseInt(fields[1], 10);
    const msgNum = parseInt(fields[2], 10);
    const totalSats = parseInt(fields[3], 10);

    // Determine constellation from talker ID
    const talker = cleanLine.substring(1, 3);
    let constellation = 'GPS';
    if (talker === 'GL') constellation = 'GLONASS';
    else if (talker === 'GA') constellation = 'Galileo';
    else if (talker === 'GB' || talker === 'BD') constellation = 'BeiDou';
    else if (talker === 'GQ' || talker === 'QZ') constellation = 'QZSS';

    if (!portStats.satellitesMap) {
      portStats.satellitesMap = {};
    }

    // Parse up to 4 satellite blocks starting at field index 4
    const satFieldStart = 4;
    for (let i = 0; i < 4; i++) {
      const idx = satFieldStart + i * 4;
      if (idx >= fields.length) break;

      const prnVal = fields[idx];
      if (!prnVal) continue;

      const elevation = parseFloat(fields[idx + 1]);
      const azimuth = parseFloat(fields[idx + 2]);
      
      let snr = null;
      const rawSnr = fields[idx + 3];
      if (rawSnr) {
        snr = parseFloat(rawSnr.split('*')[0]);
      }

      if (isNaN(elevation) || isNaN(azimuth)) continue;

      const prnStr = prnVal.padStart(2, '0');
      const satKey = `${constellation}_${prnStr}`;

      portStats.satellitesMap[satKey] = {
        prn: prnStr,
        constellation,
        elevation,
        azimuth,
        snr: isNaN(snr) ? null : snr,
        lastUpdate: Date.now()
      };
    }

    // Clean up stale satellites (not updated in last 15 seconds)
    const now = Date.now();
    Object.keys(portStats.satellitesMap).forEach(key => {
      if (now - portStats.satellitesMap[key].lastUpdate > 15000) {
        delete portStats.satellitesMap[key];
      }
    });

    // Compile active satellites list sorted by Constellation then PRN
    portStats.satellitesList = Object.values(portStats.satellitesMap).sort((a, b) => {
      if (a.constellation !== b.constellation) {
        return a.constellation.localeCompare(b.constellation);
      }
      return a.prn.localeCompare(b.prn);
    });

    return {
      sentenceType: 'GSV',
      totalMsgs,
      msgNum,
      totalSats,
      satellitesList: portStats.satellitesList
    };
  }
}

module.exports = new NmeaParser();

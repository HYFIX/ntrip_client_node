/**
 * Custom BitReader for bit-level payload parsing (supporting BigInt for 38-bit ECEF)
 */
class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bitOffset = 0;
  }

  readBits(numBits) {
    let value = 0n;
    for (let i = 0; i < numBits; i++) {
      const byteIdx = Math.floor(this.bitOffset / 8);
      const bitIdx = 7 - (this.bitOffset % 8);
      if (byteIdx >= this.buffer.length) {
        throw new Error('Out of bounds reading bits');
      }
      const bit = (this.buffer[byteIdx] >> bitIdx) & 1;
      value = (value << 1n) | BigInt(bit);
      this.bitOffset++;
    }
    return value;
  }

  readSignedBits(numBits) {
    const value = this.readBits(numBits);
    const signBit = 1n << BigInt(numBits - 1);
    if ((value & signBit) !== 0n) {
      // Two's complement for negative values
      const mask = (1n << BigInt(numBits)) - 1n;
      return -((~value & mask) + 1n);
    }
    return value;
  }
}

class RtcmParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.stats = {
      totalBytes: 0,
      totalPackets: 0,
      baseStationId: null,
      baseCoordinates: null, // { latitude, longitude, altitude }
      baseEcef: null, // { x, y, z } in meters
      packetTypes: {} // messageType -> count
    };
  }

  // Bowring's Method to convert ECEF (X, Y, Z) in meters to WGS84 Geodetic Latitude, Longitude, Altitude
  ecefToLla(x, y, z) {
    const a = 6378137.0; // semi-major axis
    const f = 1.0 / 298.257223563; // flattening
    const b = a * (1.0 - f); // semi-minor axis
    const e2 = (a * a - b * b) / (a * a); // first eccentricity squared
    const ePrime2 = (a * a - b * b) / (b * b); // second eccentricity squared

    const p = Math.sqrt(x * x + y * y);
    if (p < 1e-6) {
      // Special case for poles
      const lat = z > 0 ? Math.PI / 2 : -Math.PI / 2;
      const lon = 0;
      const alt = Math.abs(z) - b;
      return {
        latitude: parseFloat((lat * 180.0 / Math.PI).toFixed(8)),
        longitude: parseFloat((lon * 180.0 / Math.PI).toFixed(8)),
        altitude: parseFloat(alt.toFixed(3))
      };
    }

    const theta = Math.atan2(z * a, p * b);

    const lat = Math.atan2(
      z + ePrime2 * b * Math.pow(Math.sin(theta), 3),
      p - e2 * a * Math.pow(Math.cos(theta), 3)
    );

    const lon = Math.atan2(y, x);

    const N = a / Math.sqrt(1.0 - e2 * Math.sin(lat) * Math.sin(lat));
    const alt = p / Math.cos(lat) - N;

    return {
      latitude: parseFloat((lat * 180.0 / Math.PI).toFixed(8)),
      longitude: parseFloat((lon * 180.0 / Math.PI).toFixed(8)),
      altitude: parseFloat(alt.toFixed(3))
    };
  }

  // Calculate Geodesic distance using Haversine formula in km
  calculateBaseline(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
    const R = 6371.0; // Radius of Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180.0;
    const dLon = (lon2 - lon1) * Math.PI / 180.0;
    
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180.0) *
        Math.cos(lat2 * Math.PI / 180.0) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c; // in km
    
    return parseFloat(distance.toFixed(3));
  }

  // Feeds incoming binary data chunk and parses complete RTCM v3 frames
  feed(chunk, onPacketCallback) {
    if (!chunk || chunk.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.stats.totalBytes += chunk.length;

    let searchIdx = 0;
    while (this.buffer.length - searchIdx >= 3) {
      // Find RTCM v3 Preamble: 0xD3
      if (this.buffer[searchIdx] !== 0xD3) {
        searchIdx++;
        continue;
      }

      // If we skipped bytes, shift buffer
      if (searchIdx > 0) {
        this.buffer = this.buffer.slice(searchIdx);
        searchIdx = 0;
      }

      // Read 10-bit payload length
      const length = ((this.buffer[1] & 0x03) << 8) | this.buffer[2];
      const totalSize = length + 6; // 1 preamble + 2 length + length payload + 3 CRC24

      // Wait if full packet hasn't arrived
      if (this.buffer.length < totalSize) {
        break;
      }

      // Extract full frame
      const frame = this.buffer.slice(0, totalSize);
      this.buffer = this.buffer.slice(totalSize);

      this.parseFrame(frame, onPacketCallback);
    }
  }

  // Parse extracted RTCM frame
  parseFrame(frame, onPacketCallback) {
    this.stats.totalPackets++;
    const payload = frame.slice(3, frame.length - 3);

    try {
      const reader = new BitReader(payload);
      const msgType = Number(reader.readBits(12));

      // Log packet type frequency
      this.stats.packetTypes[msgType] = (this.stats.packetTypes[msgType] || 0) + 1;

      let baseStationId = null;
      let ecefX = null;
      let ecefY = null;
      let ecefZ = null;
      let baseLla = null;

      // Handle Reference Antenna Station Coordinates: Type 1005 (ARP) or 1006 (ARP with antenna height)
      if (msgType === 1005 || msgType === 1006) {
        baseStationId = Number(reader.readBits(12));
        this.stats.baseStationId = baseStationId;

        // Skip ITRF epoch (6 bits), GPS indicator (1 bit), GLONASS indicator (1 bit), Galileo (1 bit), Ref indicator (1 bit)
        reader.readBits(10); 

        // ECEF-X is a 38-bit signed integer (units of 0.0001m)
        ecefX = Number(reader.readSignedBits(38)) / 10000.0;

        // Skip single receiver oscillator (1 bit), reserved (1 bit)
        reader.readBits(2);

        // ECEF-Y is a 38-bit signed integer
        ecefY = Number(reader.readSignedBits(38)) / 10000.0;

        // Skip quarter cycle indicator (2 bits)
        reader.readBits(2);

        // ECEF-Z is a 38-bit signed integer
        ecefZ = Number(reader.readSignedBits(38)) / 10000.0;

        // Convert ECEF X, Y, Z to Latitude, Longitude, Altitude
        baseLla = this.ecefToLla(ecefX, ecefY, ecefZ);
        this.stats.baseCoordinates = baseLla;
        this.stats.baseEcef = { x: ecefX, y: ecefY, z: ecefZ };

        console.log(`[RTCM] Decoded Type ${msgType} Base Station ID: ${baseStationId}. Coordinates:`, baseLla);
      }

      if (onPacketCallback) {
        onPacketCallback({
          messageType: msgType,
          stationId: baseStationId || this.stats.baseStationId,
          ecef: ecefX !== null ? { x: ecefX, y: ecefY, z: ecefZ } : null,
          coordinates: baseLla,
          length: payload.length
        });
      }

    } catch (err) {
      console.error('[RTCM] Parsing error on frame:', err.message);
    }
  }

  getStats() {
    return this.stats;
  }

  resetStats() {
    this.stats = {
      totalBytes: 0,
      totalPackets: 0,
      baseStationId: null,
      baseCoordinates: null,
      baseEcef: null,
      packetTypes: {}
    };
  }
}

module.exports = new RtcmParser();

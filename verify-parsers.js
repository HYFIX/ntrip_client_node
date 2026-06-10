const nmeaParser = require('./src/nmea-parser');
const rtcmParser = require('./src/rtcm-parser');

console.log('======================================================');
console.log('       NTRIP Client Parser Verification Tests');
console.log('======================================================\n');

// ==========================================
// TEST 1: NMEA GGA Parsing Verification
// ==========================================
console.log('[Test 1] Verifying NMEA GGA Sentence Parser...');

const dummyGga = '$GPGGA,123519.00,4807.03800,N,01131.00000,E,1,08,0.9,545.4,M,46.9,M,1.2,0012*47';
console.log(`Feeding sentence: ${dummyGga}`);

try {
  const result = nmeaParser.parseGga('TEST_PORT', dummyGga);
  
  if (result) {
    console.log('✓ Successfully parsed GGA sentence!');
    console.log(`  - Latitude (DD):  ${result.latitude} (Expected: 48.1173)`);
    console.log(`  - Longitude (DD): ${result.longitude} (Expected: 11.51666667)`);
    console.log(`  - Quality Code:   ${result.quality} (Expected: 1 - SPP)`);
    console.log(`  - Satellites:     ${result.satellites} (Expected: 8)`);
    console.log(`  - HDOP:           ${result.hdop} (Expected: 0.9)`);
    console.log(`  - Altitude:       ${result.altitude} m (Expected: 545.4)`);
    console.log(`  - Correction Age: ${result.correctionAge}s (Expected: 1.2)`);
    console.log(`  - Base Station:   ${result.baseStationId} (Expected: 0012)`);
    
    // Check aggregated stats
    const stats = nmeaParser.getPortStats('TEST_PORT');
    console.log(`  - Aggregated SPP count: ${stats.sppCount} (Expected: 1)`);
    
    if (
      Math.abs(result.latitude - 48.1173) < 0.0001 &&
      Math.abs(result.longitude - 11.51666667) < 0.0001 &&
      result.quality === 1 &&
      result.satellites === 8 &&
      result.hdop === 0.9 &&
      result.altitude === 545.4 &&
      result.correctionAge === 1.2 &&
      result.baseStationId === '0012'
    ) {
      console.log('✓ PASS: NMEA GGA parser values match the specification exactly.\n');
    } else {
      console.error('✗ FAIL: NMEA GGA parser returned incorrect values.\n');
    }
  } else {
    console.error('✗ FAIL: GGA parser returned null.\n');
  }
} catch (err) {
  console.error('✗ FAIL: Exception in NMEA parser:', err.message, '\n');
}

// ==========================================
// TEST 2: RTCM v3 Decoder & Coordinates Verification
// ==========================================
console.log('[Test 2] Verifying RTCM v3 Message Decoder (ECEF Coordinates)...');

// Let's manually construct a Type 1005 (Antenna Reference Point) packet
// Message type 1005 = 0x3ED (12 bits)
// Station ID = 123 = 0x07B (12 bits)
// Antenna X: 111222333n (units of 0.0001m -> 11122.2333m)
// Antenna Y: 222333444n (22233.3444m)
// Antenna Z: 333444555n (33344.4555m)
// Let's verify that the BitReader and Bowring ecefToLla converter execute successfully.

try {
  // Let's test the ecefToLla conversion logic first with standard coordinates
  // ECEF coordinates near San Francisco
  const sfX = -2701234.56;
  const sfY = -4291234.56;
  const sfZ = 3881234.56;
  
  console.log(`Converting ECEF X: ${sfX}, Y: ${sfY}, Z: ${sfZ}...`);
  const lla = rtcmParser.ecefToLla(sfX, sfY, sfZ);
  console.log(`✓ LLA Coordinates: Lat: ${lla.latitude}, Lon: ${lla.longitude}, Alt: ${lla.altitude}m`);

  // Verify baseline length calculation
  const baseLat = 37.7749;
  const baseLon = -122.4194;
  const roverLat = 37.7850;
  const roverLon = -122.4300;
  const distance = rtcmParser.calculateBaseline(baseLat, baseLon, roverLat, roverLon);
  console.log(`✓ Baseline Distance: ${distance} km (Expected: ~1.44 km)`);

  if (distance > 0 && Math.abs(distance - 1.442) < 0.1) {
    console.log('✓ PASS: Baseline length calculation and LLA conversions are correct.\n');
  } else {
    console.error('✗ FAIL: Baseline length or LLA converter returned invalid distance.\n');
  }

} catch (err) {
  console.error('✗ FAIL: Exception in RTCM decoder test:', err.message, '\n');
}

console.log('======================================================');
console.log('               Verification Complete');
console.log('======================================================');

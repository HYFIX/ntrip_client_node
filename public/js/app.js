// ==========================================================================
   // GLOBAL STATES & LEAFLET INITIALIZATION
   // ==========================================================================

let socket = null;
let currentConfig = null;
let map = null;
let mapMarkers = {}; // portName -> Leaflet Marker
let mapTrails = {}; // portName -> Leaflet Polyline
let baseMarker = null;
let baselineLines = {}; // portName -> Leaflet Polyline (dashed connection)
let activeViewingLog = null;

// Common RTCM v3 message descriptions mapping
const RTCM_DESCRIPTIONS = {
  1004: 'GPS Extended L1/L2 Observables',
  1005: 'Stationary ARP (Base Location)',
  1006: 'Stationary ARP with Ant Height',
  1007: 'Antenna Descriptor',
  1008: 'Antenna Serial Number',
  1012: 'GLONASS Ext L1/L2 Observables',
  1019: 'GPS Ephemeris',
  1020: 'GLONASS Ephemeris',
  1033: 'Receiver/Antenna Descriptor',
  1042: 'BeiDou Ephemeris',
  1045: 'Galileo FNAV Ephemeris',
  1046: 'Galileo INAV Ephemeris',
  1074: 'GPS MSM4 Observables',
  1077: 'GPS MSM7 (High-Precision)',
  1084: 'GLONASS MSM4 Observables',
  1087: 'GLONASS MSM7 (High-Precision)',
  1094: 'Galileo MSM4 Observables',
  1097: 'Galileo MSM7 (High-Precision)',
  1124: 'BeiDou MSM4 Observables',
  1127: 'BeiDou MSM7 (High-Precision)',
  1230: 'GLONASS Phase Biases'
};

// Initialize Leaflet Map centered in default San Francisco
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    minZoom: 2,
    maxZoom: 18
  }).setView([37.7749, -122.4194], 13);

  // Load OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  console.log('[Map] Leaflet map initialized.');

  // Register follow select change listener
  const followSelect = document.getElementById('map-follow-select');
  if (followSelect) {
    followSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val !== 'none' && mapMarkers[val]) {
        const latLng = mapMarkers[val].getLatLng();
        map.setView(latLng, 15); // Zoom to followed primary rover
        appendConsole(`Map view centered and zoomed on primary rover: ${val}`);
      }
    });
  }
}

// Format seconds as 0h3m0s
function formatSeconds(totalSecs) {
  const s = totalSecs % 60;
  const m = Math.floor((totalSecs % 3600) / 60);
  const h = Math.floor(totalSecs / 3600);
  return `${h}h${m}m${s}s`;
}

// Format bytes size to human-readable string
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format coordinates neatly
function formatLatLng(lat, lon, alt) {
  if (lat === null || lon === null) return '-';
  const latStr = Math.abs(lat).toFixed(6) + '° ' + (lat >= 0 ? 'N' : 'S');
  const lonStr = Math.abs(lon).toFixed(6) + '° ' + (lon >= 0 ? 'E' : 'W');
  const altStr = alt !== null ? ` (Alt: ${alt.toFixed(2)}m)` : '';
  return `${latStr}, ${lonStr}${altStr}`;
}

// Append live records to console
function appendConsole(message) {
  const consoleBox = document.getElementById('console-box');
  const timestamp = new Date().toLocaleTimeString();
  consoleBox.innerHTML += `[${timestamp}] ${message}\n`;
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

// Clear scrolling console
const btnClearConsole = document.getElementById('btn-clear-console');
if (btnClearConsole) {
  btnClearConsole.addEventListener('click', () => {
    const consoleBox = document.getElementById('console-box');
    if (consoleBox) consoleBox.innerHTML = '';
    appendConsole('Console cleared.');
  });
}

// ==========================================================================
// WEBSOCKET TELEMETRY BROKER
// ==========================================================================

function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    appendConsole('WebSocket connection established.');
    const dot = document.getElementById('global-status-dot');
    const text = document.getElementById('global-status-text');
    if (dot) dot.className = 'status-dot connected';
    if (text) text.innerText = 'Connected';
  };

  socket.onclose = () => {
    appendConsole('WebSocket disconnected. Reconnecting in 5 seconds...');
    const dot = document.getElementById('global-status-dot');
    const text = document.getElementById('global-status-text');
    if (dot) dot.className = 'status-dot disconnected';
    if (text) text.innerText = 'Disconnected';
    
    // Cleanup active map overlays on disconnection
    clearMapOverlays();
    
    setTimeout(connectWebSocket, 5000);
  };

  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
    const dot = document.getElementById('global-status-dot');
    if (dot) dot.className = 'status-dot disconnected';
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'config') {
        currentConfig = data.config;
        populateConfigForm(currentConfig);
      } else if (data.type === 'telemetry') {
        updateTelemetryDashboard(data);
      } else if (data.type === 'logs_list') {
        renderLogsList(data.logs);
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  };
}

// Clear map elements
function clearMapOverlays() {
  if (typeof L === 'undefined' || !map) return;
  Object.keys(mapMarkers).forEach(key => {
    map.removeLayer(mapMarkers[key]);
    delete mapMarkers[key];
  });
  Object.keys(mapTrails).forEach(key => {
    map.removeLayer(mapTrails[key]);
    delete mapTrails[key];
  });
  Object.keys(baselineLines).forEach(key => {
    map.removeLayer(baselineLines[key]);
    delete baselineLines[key];
  });
  if (baseMarker) {
    map.removeLayer(baseMarker);
    baseMarker = null;
  }
}

// ==========================================================================
// DASHBOARD VIEW UPDATES
// ==========================================================================

let lastActiveRovers = [];

function updateFollowDropdown(activeRovers) {
  const select = document.getElementById('map-follow-select');
  if (!select) return;

  const changed = lastActiveRovers.length !== activeRovers.length || 
                  activeRovers.some((r, i) => r !== lastActiveRovers[i]);

  if (!changed) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="none">None (Manual)</option>';
  
  activeRovers.forEach(portName => {
    const opt = document.createElement('option');
    opt.value = portName;
    opt.innerText = portName;
    select.appendChild(opt);
  });

  if (activeRovers.includes(currentValue)) {
    select.value = currentValue;
  } else {
    select.value = 'none';
  }

  lastActiveRovers = [...activeRovers];
}

function updateTelemetryDashboard(payload) {
  const { ntrip, serialPorts, rovers } = payload;

  // Sync Follow primary rover dropdown list
  const activeRovers = Object.keys(rovers).filter(portName => {
    const r = rovers[portName];
    const serialInfo = Object.values(serialPorts).find(p => p.portName === portName);
    return serialInfo && serialInfo.enabled;
  });
  updateFollowDropdown(activeRovers);

  // 1. Update NTRIP Caster Card
  const casterStatusBadge = document.getElementById('ntrip-status-badge');
  if (ntrip.connected) {
    casterStatusBadge.innerText = 'ACTIVE';
    casterStatusBadge.className = 'badge badge-connected';
  } else if (ntrip.connecting) {
    casterStatusBadge.innerText = 'CONNECTING';
    casterStatusBadge.className = 'badge badge-connecting';
  } else {
    casterStatusBadge.innerText = 'OFFLINE';
    casterStatusBadge.className = 'badge badge-disconnected';
  }

  const endpointText = ntrip.host ? `${ntrip.host}:${ntrip.port}` : '-';
  document.getElementById('telemetry-caster-endpoint').innerText = endpointText;
  document.getElementById('telemetry-mountpoint').innerText = ntrip.mountpoint || '-';
  document.getElementById('telemetry-bytes-received').innerText = formatBytes(ntrip.bytesReceived);

  // Gap simulation status row
  const gapSimRow = document.getElementById('gap-sim-status-row');
  const gapSimEl = document.getElementById('telemetry-gap-sim-status');
  const gs = payload.gapSim;
  if (gs && gs.enabled) {
    gapSimRow.style.display = 'flex';
    const countdown = formatSeconds(gs.secondsUntilSwitch);
    if (gs.isForwarding) {
      gapSimEl.innerHTML = `<span class="highlight-green">FORWARDING</span> &rarr; gap in ${countdown}`;
    } else {
      gapSimEl.innerHTML = `<span class="highlight-rose">GAP ACTIVE</span> &rarr; resume in ${countdown}`;
    }
  } else {
    gapSimRow.style.display = 'none';
  }

  const baseStats = ntrip.rtcmParserStats;
  document.getElementById('telemetry-station-id').innerText = baseStats.baseStationId !== null ? baseStats.baseStationId : '-';

  if (baseStats.baseCoordinates) {
    const coords = baseStats.baseCoordinates;
    document.getElementById('telemetry-base-coords').innerText = `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`;
    
    // Update base marker on map
    updateBaseStationMarker(coords.latitude, coords.longitude, baseStats.baseStationId);
  } else {
    document.getElementById('telemetry-base-coords').innerText = '-';
  }

  // Populate Base ECEF Coordinates if parsed
  if (baseStats.baseEcef) {
    const ecef = baseStats.baseEcef;
    document.getElementById('telemetry-base-ecef').innerText = `X:${ecef.x.toFixed(3)}, Y:${ecef.y.toFixed(3)}, Z:${ecef.z.toFixed(3)} m`;
  } else {
    document.getElementById('telemetry-base-ecef').innerText = '-';
  }

  // Update RTCM Message statistics dynamically
  const rtcmTotalBadge = document.getElementById('rtcm-total-packets');
  if (rtcmTotalBadge) {
    rtcmTotalBadge.innerText = `${baseStats.totalPackets || 0} Packets`;
  }

  const rtcmStatsContainer = document.getElementById('rtcm-stats-simple');
  if (rtcmStatsContainer) {
    const packetTypes = baseStats.packetTypes || {};
    const msgTypes = Object.keys(packetTypes).map(Number).sort((a, b) => a - b);
    if (msgTypes.length === 0) {
      rtcmStatsContainer.innerText = 'Waiting for RTCM stream...';
    } else {
      rtcmStatsContainer.innerHTML = msgTypes.map(t => `${t}(${packetTypes[t]})`).join(', ');
    }
  }

  // Update forwarded-to-rovers stats
  const fwdStats = payload.rtcmFwdStats || { packetTypes: {}, totalPackets: 0 };
  const fwdTotalBadge = document.getElementById('rtcm-fwd-total-packets');
  if (fwdTotalBadge) {
    fwdTotalBadge.innerText = `${fwdStats.totalPackets || 0} Packets`;
  }
  const fwdStatsContainer = document.getElementById('rtcm-fwd-stats');
  if (fwdStatsContainer) {
    const fwdTypes = Object.keys(fwdStats.packetTypes || {}).map(Number).sort((a, b) => a - b);
    fwdStatsContainer.innerText = fwdTypes.length === 0
      ? '-'
      : fwdTypes.map(t => `${t}(${fwdStats.packetTypes[t]})`).join(', ');
  }

  // 2. Update Serial Ports Connections Table
  syncCmdPortSelector(serialPorts);
  const serialTableBody = document.querySelector('#table-serial-ports tbody');
  serialTableBody.innerHTML = '';
  
  Object.keys(serialPorts).forEach(portId => {
    const port = serialPorts[portId];
    
    const tr = document.createElement('tr');
    
    const settingsStr = `
      <div class="toggle-flag">
        <span class="badge ${port.sendGgaToCaster ? 'badge-connected' : 'badge-disconnected'}">GGA</span>
        <span class="badge ${port.receiveRtcm ? 'badge-connected' : 'badge-disconnected'}">RTCM</span>
      </div>
    `;

    const statusBadge = port.connected 
      ? `<span class="highlight-green">● Connected</span>` 
      : (port.error ? `<span class="highlight-rose" title="${port.error}">● Error</span>` : `<span class="text-muted">○ Disabled</span>`);

    tr.innerHTML = `
      <td><strong>${port.portName}</strong> ${port.isSimulated ? '<span class="badge badge-connecting" style="font-size: 0.6rem">SIM</span>' : ''}</td>
      <td>${port.baudRate}</td>
      <td>${settingsStr}</td>
      <td>
        <span class="highlight-cyan">${formatBytes(port.bytesRx)}</span> /
        <span class="highlight-orange">${formatBytes(port.bytesTx)}</span>
        ${port.cmdBytesTx > 0 ? `<span style="font-size:0.7rem; color:var(--text-muted)"> +${formatBytes(port.cmdBytesTx)} cmd</span>` : ''}
      </td>
      <td>${statusBadge}</td>
    `;
    
    serialTableBody.appendChild(tr);
  });

  // 3. Update Rovers RTK Position Matrix Cards
  const roversGrid = document.getElementById('rovers-position-grid');

  if (activeRovers.length === 0) {
    roversGrid.innerHTML = `<div class="no-rovers-prompt">No active serial ports configured. Check "Configure Systems".</div>`;
  } else {
    // Keep or recreate cards dynamically
    roversGrid.innerHTML = '';
    
    activeRovers.forEach(portName => {
      const rover = rovers[portName];
      const serialInfo = Object.values(serialPorts).find(p => p.portName === portName);

      // RTK status badge class mapping
      let qualityText = 'NO FIX';
      let qualityClass = 'rtk-invalid';
      switch(rover.lastQuality) {
        case 1: qualityText = 'SPP'; qualityClass = 'rtk-spp'; break;
        case 2: qualityText = 'DGPS'; qualityClass = 'rtk-dgps'; break;
        case 3: qualityText = 'PPS'; qualityClass = 'rtk-spp'; break;
        case 4: qualityText = 'RTK FIX'; qualityClass = 'rtk-fix'; break;
        case 5: qualityText = 'RTK FLOAT'; qualityClass = 'rtk-float'; break;
        case 8: qualityText = 'SIM'; qualityClass = 'rtk-spp'; break;
      }

      const card = document.createElement('div');
      card.className = 'rover-rtk-card';
      
      const coordsText = formatLatLng(rover.lastLatitude, rover.lastLongitude, rover.lastAltitude);
      const correctionAgeStr = rover.lastCorrectionAge !== null ? `${rover.lastCorrectionAge.toFixed(1)}s` : '-';
      const baseStationIdStr = rover.lastBaseStationId !== null ? rover.lastBaseStationId : '-';
      
      let baselineStr = '-';
      if (rover.baselineLength !== null) {
        baselineStr = `<span class="highlight-rose" style="font-weight:700">${rover.baselineLength.toFixed(3)} km</span>`;
      }

      let plotsHtml = '';
      if (rover.satellitesList && rover.satellitesList.length > 0) {
        const cleanName = portName.replace(/[^a-zA-Z0-9_]/g, '_');
        plotsHtml = `
          <div class="rover-satellite-plots">
            <canvas id="skyplot-${cleanName}" width="130" height="130" title="Skyplot (Satellites in View)"></canvas>
            <canvas id="snr-${cleanName}" width="210" height="130" title="SNR (Signal to Noise Ratio)"></canvas>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="rover-card-left">
          <div class="rover-title">
            <span class="rover-name">${portName}</span>
            <span class="rtk-badge ${qualityClass}">${qualityText}</span>
          </div>
          <div class="rover-coords-box">
            <div class="coord-line">
              <span class="coord-lbl">Latitude</span>
              <span class="coord-val">${rover.lastLatitude !== null ? rover.lastLatitude.toFixed(7) : '-'}</span>
            </div>
            <div class="coord-line">
              <span class="coord-lbl">Longitude</span>
              <span class="coord-val">${rover.lastLongitude !== null ? rover.lastLongitude.toFixed(7) : '-'}</span>
            </div>
            <div class="coord-line">
              <span class="coord-lbl">Altitude</span>
              <span class="coord-val">${rover.lastAltitude !== null ? rover.lastAltitude.toFixed(2) + ' m' : '-'}</span>
            </div>
          </div>
          <div class="rover-stat-row">
            <span class="telemetry-label">Baseline Length</span>
            <span class="telemetry-val">${baselineStr}</span>
          </div>
          <div class="rover-stat-row">
            <span class="telemetry-label">Correction Age</span>
            <span class="telemetry-val">${correctionAgeStr}</span>
          </div>
          <div class="rover-stat-row">
            <span class="telemetry-label">Differential Base ID</span>
            <span class="telemetry-val highlight-green">${baseStationIdStr}</span>
          </div>
        </div>
        <div class="rover-card-right">
          <div class="fix-rate-container">
            <div class="fix-rate-lbl-row">
              <span class="telemetry-label">RTK Fix Rate</span>
              <span class="telemetry-val highlight-green">${rover.fixRate}%</span>
            </div>
            <div class="fix-rate-bar-bg">
              <div class="fix-rate-bar-fill" style="width: ${rover.fixRate}%"></div>
            </div>
          </div>
          <div class="rover-stat-row" style="margin-top:0.4rem">
            <span class="telemetry-label">HDOP / Satellites</span>
            <span class="telemetry-val">${rover.lastHdop !== null ? rover.lastHdop.toFixed(1) : '-'} / <span class="highlight-cyan">${rover.lastSatellites} sats</span></span>
          </div>
          
          <div class="rtk-counts-grid">
            <div class="rtk-count-box" title="Single Point Positioning">
              <span class="rtk-count-val highlight-yellow">${rover.sppCount}</span>
              <span class="rtk-count-lbl">SPP</span>
            </div>
            <div class="rtk-count-box" title="Differential GPS">
              <span class="rtk-count-val highlight-cyan">${rover.dgpsCount}</span>
              <span class="rtk-count-lbl">DGPS</span>
            </div>
            <div class="rtk-count-box" title="RTK Float">
              <span class="rtk-count-val highlight-orange">${rover.rtkFloatCount}</span>
              <span class="rtk-count-lbl">Float</span>
            </div>
            <div class="rtk-count-box" title="RTK Fix">
              <span class="rtk-count-val highlight-green">${rover.rtkFixCount}</span>
              <span class="rtk-count-lbl">Fix</span>
            </div>
          </div>
        </div>
        ${plotsHtml}
      `;
      
      roversGrid.appendChild(card);

      // Draw canvas skyplot and SNR plots dynamically
      if (rover.satellitesList && rover.satellitesList.length > 0) {
        const cleanName = portName.replace(/[^a-zA-Z0-9_]/g, '_');
        setTimeout(() => {
          const skyCanvas = document.getElementById(`skyplot-${cleanName}`);
          const snrCanvas = document.getElementById(`snr-${cleanName}`);
          if (skyCanvas && snrCanvas) {
            drawSkyplot(skyCanvas, rover.satellitesList);
            drawSnrPlot(snrCanvas, rover.satellitesList);
          }
        }, 10);
      }

      // 4. Update Map markers and trails for this rover
      if (rover.lastLatitude !== null && rover.lastLongitude !== null) {
        updateRoverMapElements(portName, rover.lastLatitude, rover.lastLongitude, rover.lastQuality, rover.trajectory, baseStats.baseCoordinates, rover.baselineLength);
        
        // Auto-center map to followed primary rover
        const followSelect = document.getElementById('map-follow-select');
        if (followSelect && followSelect.value === portName) {
          map.panTo([rover.lastLatitude, rover.lastLongitude]);
        }
      }
    }
    );
  }
}

// ==========================================================================
// INTERACTIVE MAP MARKERS AND TRAILS
// ==========================================================================

// Base station marker drawing
function updateBaseStationMarker(lat, lon, stationId) {
  if (typeof L === 'undefined' || !map) return;
  const popupContent = `
    <div style="font-family: 'Outfit', sans-serif; font-size: 0.85rem">
      <strong style="color: #10b981">NTRIP Base Station</strong><br/>
      ID: <strong>${stationId}</strong><br/>
      Latitude: ${lat.toFixed(6)}<br/>
      Longitude: ${lon.toFixed(6)}
    </div>
  `;

  const customIcon = L.divIcon({
    className: 'pulsing-base-marker',
    iconSize: [18, 16],
    iconAnchor: [9, 8]
  });

  if (!baseMarker) {
    baseMarker = L.marker([lat, lon], { icon: customIcon }).addTo(map);
    baseMarker.bindPopup(popupContent);
    appendConsole(`Plotted Base Station ID ${stationId} on map.`);
    
    // Pan to base station
    map.panTo([lat, lon]);
  } else {
    baseMarker.setLatLng([lat, lon]);
    baseMarker.getPopup().setContent(popupContent);
  }
}

// Rover markers drawing with trails and baselines
function updateRoverMapElements(portName, lat, lon, quality, trajectory, baseCoords, baselineLength) {
  if (typeof L === 'undefined' || !map) return;
  // Determine pulsing active marker class based on solution type
  let markerClass = 'pulsing-rover-marker-invalid';
  let qualityText = 'NO FIX';
  
  switch(quality) {
    case 1:
    case 3:
    case 8:
      qualityText = 'SPP';
      markerClass = 'pulsing-rover-marker-spp';
      break;
    case 2:
      qualityText = 'DGPS';
      markerClass = 'pulsing-rover-marker-dgps';
      break;
    case 4:
      qualityText = 'RTK FIX';
      markerClass = 'pulsing-rover-marker-fix';
      break;
    case 5:
      qualityText = 'RTK FLOAT';
      markerClass = 'pulsing-rover-marker-float';
      break;
  }

  const customIcon = L.divIcon({
    className: `pulsing-rover-marker ${markerClass}`,
    iconSize: [12, 12]
  });

  const popupContent = `
    <div style="font-family: 'Outfit', sans-serif; font-size: 0.85rem">
      <strong>Rover: ${portName}</strong><br/>
      Quality: <strong class="highlight-cyan">${qualityText}</strong><br/>
      Lat: ${lat.toFixed(6)}<br/>
      Lon: ${lon.toFixed(6)}<br/>
      ${baselineLength !== null ? `Baseline: <strong style="color: #ef4444">${baselineLength.toFixed(3)} km</strong>` : ''}
    </div>
  `;

  // 1. Update Rover Marker
  if (!mapMarkers[portName]) {
    mapMarkers[portName] = L.marker([lat, lon], { icon: customIcon }).addTo(map);
    mapMarkers[portName].bindPopup(popupContent);
    appendConsole(`Rover ${portName} parsed coordinate. Drawn on map.`);
  } else {
    mapMarkers[portName].setLatLng([lat, lon]);
    mapMarkers[portName].setIcon(customIcon); // Update pulsing icon color dynamically
    mapMarkers[portName].getPopup().setContent(popupContent);
  }

  // 2. Update Trajectory Trail with Color-Coded Solution Type Dots
  if (mapTrails[portName]) {
    map.removeLayer(mapTrails[portName]);
  }

  const trailGroup = L.layerGroup();
  
  trajectory.forEach(pt => {
    let ptColor = '#ef4444'; // default invalid (rose)
    let ptType = 'Invalid';
    
    switch(pt.quality) {
      case 1:
      case 3:
      case 8:
        ptColor = '#eab308'; // yellow (spp)
        ptType = 'SPP';
        break;
      case 2:
        ptColor = '#06b6d4'; // cyan (dgps)
        ptType = 'DGPS';
        break;
      case 4:
        ptColor = '#10b981'; // green (fix)
        ptType = 'RTK FIX';
        break;
      case 5:
        ptColor = '#f59e0b'; // orange (float)
        ptType = 'RTK FLOAT';
        break;
    }

    const circle = L.circleMarker([pt.latitude, pt.longitude], {
      radius: 4,
      fillColor: ptColor,
      fillOpacity: 0.9,
      color: '#ffffff',
      weight: 1,
      opacity: 0.8
    });

    circle.bindTooltip(`Rover: ${portName}<br/>Type: ${ptType}<br/>Time: ${new Date(pt.timestamp).toLocaleTimeString()}`, { sticky: true });
    circle.addTo(trailGroup);
  });

  trailGroup.addTo(map);
  mapTrails[portName] = trailGroup;

  // 3. Update Baseline Line
  if (baseCoords) {
    const baseLatLng = [baseCoords.latitude, baseCoords.longitude];
    const roverLatLng = [lat, lon];
    
    if (!baselineLines[portName]) {
      baselineLines[portName] = L.polyline([baseLatLng, roverLatLng], {
        color: '#ef4444',
        weight: 2,
        dashArray: '5, 8',
        opacity: 0.7
      }).addTo(map);
      
      const baselineTooltip = `${portName} Baseline: ${baselineLength ? baselineLength.toFixed(3) : '-'} km`;
      baselineLines[portName].bindTooltip(baselineTooltip, { sticky: true });
    } else {
      baselineLines[portName].setLatLngs([baseLatLng, roverLatLng]);
      baselineLines[portName].getTooltip().setContent(`${portName} Baseline: ${baselineLength ? baselineLength.toFixed(3) : '-'} km`);
    }
  } else if (baselineLines[portName]) {
    map.removeLayer(baselineLines[portName]);
    delete baselineLines[portName];
  }
}

// ==========================================================================
// SYSTEM CONFIGURATION MANAGEMENT
// ==========================================================================

const configDrawer = document.getElementById('config-drawer');
const configDrawerOverlay = document.getElementById('config-drawer-overlay');
const btnConfig = document.getElementById('btn-config');
const btnCloseConfig = document.getElementById('btn-close-config');

function closeConfigDrawer() {
  if (configDrawer) configDrawer.classList.remove('open');
  if (configDrawerOverlay) {
    configDrawerOverlay.style.opacity = '0';
    setTimeout(() => configDrawerOverlay.style.display = 'none', 300);
  }
}

// Fetch available serial ports and populate the datalist
function refreshAvailablePorts() {
  fetch('/api/ports/available')
    .then(res => res.json())
    .then(ports => {
      const datalist = document.getElementById('available-ports-datalist');
      if (!datalist) return;
      datalist.innerHTML = '';
      ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        if (p.manufacturer) opt.label = `${p.path} — ${p.manufacturer}`;
        datalist.appendChild(opt);
      });
      appendConsole(`Detected ${ports.length} serial port${ports.length !== 1 ? 's' : ''} on this system.`);
    })
    .catch(err => console.error('[Ports] Failed to fetch available ports:', err));
}

// Open / Close Configurations Panel
if (btnConfig && configDrawer && configDrawerOverlay) {
  btnConfig.addEventListener('click', () => {
    configDrawer.classList.add('open');
    configDrawerOverlay.style.display = 'block';
    setTimeout(() => configDrawerOverlay.style.opacity = '1', 50);
    refreshAvailablePorts();
  });
}

document.getElementById('btn-refresh-ports').addEventListener('click', refreshAvailablePorts);

if (btnCloseConfig) {
  btnCloseConfig.addEventListener('click', closeConfigDrawer);
}

if (configDrawerOverlay) {
  configDrawerOverlay.addEventListener('click', closeConfigDrawer);
}

// Populate forms with loaded configs
function populateConfigForm(config) {
  if (!config) config = {};
  if (!config.ntrip) config.ntrip = {};
  if (!config.serialPorts) config.serialPorts = [];

  document.getElementById('ntrip-host').value = config.ntrip.host || '';
  document.getElementById('ntrip-port').value = config.ntrip.port || '';
  document.getElementById('ntrip-mountpoint').value = config.ntrip.mountpoint || '';
  document.getElementById('ntrip-username').value = config.ntrip.username || '';
  document.getElementById('ntrip-password').value = config.ntrip.password || '';
  document.getElementById('ntrip-sendGga').checked = !!config.ntrip.sendGga;
  document.getElementById('ntrip-ggaInterval').value = config.ntrip.ggaInterval || 5000;
  document.getElementById('ntrip-filterEphemeris').checked = !!config.ntrip.filterEphemeris;
  document.getElementById('ntrip-convertToMsm4').checked = !!config.ntrip.convertToMsm4;

  const gapSimEnabled = !!config.ntrip.gapSimEnabled;
  document.getElementById('ntrip-gapSimEnabled').checked = gapSimEnabled;
  document.getElementById('ntrip-gapSimForwardDuration').value = config.ntrip.gapSimForwardDuration || 180;
  document.getElementById('ntrip-gapSimGapDuration').value = config.ntrip.gapSimGapDuration || 180;
  document.getElementById('gap-sim-fields').style.display = gapSimEnabled ? 'block' : 'none';

  // Clear serial rows list
  const listContainer = document.getElementById('serial-ports-config-list');
  listContainer.innerHTML = '';

  config.serialPorts.forEach(port => {
    addSerialConfigRow(port);
  });
}

// Add interactive input row for serial configurations
function addSerialConfigRow(portData = null) {
  const listContainer = document.getElementById('serial-ports-config-list');
  const id = portData ? portData.id : `port_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  
  const row = document.createElement('div');
  row.className = 'config-port-row';
  row.dataset.id = id;

  const portName = portData ? portData.portName : 'COM1';
  const baudRate = portData ? portData.baudRate : 115200;
  const enabled = portData ? !!portData.enabled : true;
  const sendGga = portData ? !!portData.sendGgaToCaster : false;
  const receiveRtcm = portData ? !!portData.receiveRtcm : true;
  const isSimulated = portData ? !!portData.isSimulated : false;
  const simulatedSpeed = portData ? portData.simulatedSpeed : 5.0;
  const startLat = portData ? portData.startLat : 37.7749;
  const startLon = portData ? portData.startLon : -122.4194;

  row.innerHTML = `
    <div class="config-port-row-header">
      <span class="config-port-row-title">Serial Interface</span>
      <button type="button" class="btn-remove-row" onclick="removeSerialConfigRow('${id}')" title="Delete Interface">×</button>
    </div>
    
    <div class="form-group-row">
      <div class="form-group flex-1">
        <label>Port / COM Name</label>
        <input type="text" class="port-name-val" required value="${portName}" placeholder="COM3 or /dev/ttyUSB0" list="available-ports-datalist">
      </div>
      <div class="form-group flex-1">
        <label>Baud Rate</label>
        <select class="port-baud-val">
          <option value="4800" ${baudRate == 4800 ? 'selected' : ''}>4800</option>
          <option value="9600" ${baudRate == 9600 ? 'selected' : ''}>9600</option>
          <option value="19200" ${baudRate == 19200 ? 'selected' : ''}>19200</option>
          <option value="38400" ${baudRate == 38400 ? 'selected' : ''}>38400</option>
          <option value="57600" ${baudRate == 57600 ? 'selected' : ''}>57600</option>
          <option value="115200" ${baudRate == 115200 ? 'selected' : ''}>115200</option>
          <option value="230400" ${baudRate == 230400 ? 'selected' : ''}>230400</option>
        </select>
      </div>
    </div>

    <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top: 5px;">
      <div class="form-group-checkbox" style="margin:0">
        <input type="checkbox" class="port-enabled-val" id="chk-en-${id}" ${enabled ? 'checked' : ''}>
        <label for="chk-en-${id}">Enabled</label>
      </div>
      <div class="form-group-checkbox" style="margin:0">
        <input type="checkbox" class="port-sendgga-val" id="chk-sg-${id}" ${sendGga ? 'checked' : ''}>
        <label for="chk-sg-${id}">GGA Provider</label>
      </div>
      <div class="form-group-checkbox" style="margin:0">
        <input type="checkbox" class="port-recvrtcm-val" id="chk-rr-${id}" ${receiveRtcm ? 'checked' : ''}>
        <label for="chk-rr-${id}">Forward RTCM</label>
      </div>
      <div class="form-group-checkbox" style="margin:0">
        <input type="checkbox" class="port-simulated-val" id="chk-si-${id}" onchange="toggleSimulatedFields('${id}')" ${isSimulated ? 'checked' : ''}>
        <label for="chk-si-${id}">Simulated Rover</label>
      </div>
    </div>

    <!-- Hidden Simulation parameters, toggle on checking -->
    <div class="sim-fields" id="sim-fields-${id}" style="display: ${isSimulated ? 'block' : 'none'}; border-top:1px dashed #20263d; margin-top:8px; padding-top:8px;">
      <div class="form-group-row">
        <div class="form-group flex-1">
          <label>Walk Speed (km/h)</label>
          <input type="number" step="0.1" class="port-simspeed-val" value="${simulatedSpeed}">
        </div>
        <div class="form-group flex-1">
          <label>Start Lat</label>
          <input type="number" step="0.0001" class="port-simlat-val" value="${startLat}">
        </div>
        <div class="form-group flex-1">
          <label>Start Lon</label>
          <input type="number" step="0.0001" class="port-simlon-val" value="${startLon}">
        </div>
      </div>
    </div>
  `;

  listContainer.appendChild(row);
}

// Globals exposed click listeners
window.removeSerialConfigRow = function(id) {
  const row = document.querySelector(`.config-port-row[data-id="${id}"]`);
  if (row) row.remove();
};

window.toggleSimulatedFields = function(id) {
  const checkbox = document.querySelector(`.config-port-row[data-id="${id}"] .port-simulated-val`);
  const fields = document.getElementById(`sim-fields-${id}`);
  if (checkbox && fields) {
    fields.style.display = checkbox.checked ? 'block' : 'none';
  }
};

document.getElementById('btn-add-serial-row').addEventListener('click', () => {
  addSerialConfigRow();
});

// Configuration Form submit sync
document.getElementById('form-config').addEventListener('submit', (event) => {
  event.preventDefault();

  // Assemble NTRIP
  const ntrip = {
    host: document.getElementById('ntrip-host').value.trim(),
    port: parseInt(document.getElementById('ntrip-port').value, 10),
    mountpoint: document.getElementById('ntrip-mountpoint').value.trim(),
    username: document.getElementById('ntrip-username').value.trim(),
    password: document.getElementById('ntrip-password').value,
    sendGga: document.getElementById('ntrip-sendGga').checked,
    ggaInterval: parseInt(document.getElementById('ntrip-ggaInterval').value, 10) || 5000,
    filterEphemeris: document.getElementById('ntrip-filterEphemeris').checked,
    convertToMsm4: document.getElementById('ntrip-convertToMsm4').checked,
    autoReconnect: true,
    reconnectDelay: 5000,
    gapSimEnabled: document.getElementById('ntrip-gapSimEnabled').checked,
    gapSimForwardDuration: parseInt(document.getElementById('ntrip-gapSimForwardDuration').value, 10) || 180,
    gapSimGapDuration: parseInt(document.getElementById('ntrip-gapSimGapDuration').value, 10) || 180
  };

  // Assemble Serial Ports array
  const serialPorts = [];
  const rows = document.querySelectorAll('.config-port-row');
  
  rows.forEach(row => {
    const id = row.dataset.id;
    const portName = row.querySelector('.port-name-val').value.trim();
    const baudRate = parseInt(row.querySelector('.port-baud-val').value, 10);
    const enabled = row.querySelector('.port-enabled-val').checked;
    const sendGgaToCaster = row.querySelector('.port-sendgga-val').checked;
    const receiveRtcm = row.querySelector('.port-recvrtcm-val').checked;
    const isSimulated = row.querySelector('.port-simulated-val').checked;
    
    const simulatedSpeed = parseFloat(row.querySelector('.port-simspeed-val').value) || 5.0;
    const startLat = parseFloat(row.querySelector('.port-simlat-val').value) || 37.7749;
    const startLon = parseFloat(row.querySelector('.port-simlon-val').value) || -122.4194;

    serialPorts.push({
      id,
      portName,
      baudRate,
      enabled,
      sendGgaToCaster,
      receiveRtcm,
      isSimulated,
      simulatedSpeed,
      startLat,
      startLon
    });
  });

  const assembledConfig = { ntrip, serialPorts };

  // POST config update
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assembledConfig)
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      appendConsole('Configuration successfully updated and applied.');
      closeConfigDrawer();
      // Reset markers as configurations have reloaded
      clearMapOverlays();
    } else {
      alert(`Error updating config: ${data.error}`);
    }
  })
  .catch(err => {
    console.error('Submit Config error:', err);
    alert('Failed to connect to backend server to save settings.');
  });
});

// Import Configuration file from Local drive
document.getElementById('btn-config-import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (imported.ntrip && Array.isArray(imported.serialPorts)) {
          populateConfigForm(imported);
          appendConsole('Imported configuration values. Click Save to apply.');
        } else {
          alert('Invalid NTRIP JSON format. Must contain ntrip and serialPorts elements.');
        }
      } catch (err) {
        alert(`Failed to parse file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };
  input.click();
});

// Export Current Config as a .json file download
document.getElementById('btn-config-export').addEventListener('click', () => {
  if (!currentConfig) return;
  const blob = new Blob([JSON.stringify(currentConfig, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ntrip_config_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  appendConsole('Exported configuration settings JSON file.');
});

// ==========================================================================
// SERIAL COMMAND TERMINAL
// ==========================================================================

const cmdHistory = [];
let cmdHistoryIdx = -1;

function syncCmdPortSelector(serialPorts) {
  const sel = document.getElementById('cmd-port-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Port —</option>';
  Object.entries(serialPorts).forEach(([portId, port]) => {
    if (!port.connected) return;
    const opt = document.createElement('option');
    opt.value = portId;
    opt.textContent = port.portName + (port.isSimulated ? ' [SIM]' : '');
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

function sendSerialCommand() {
  const portId = document.getElementById('cmd-port-select').value;
  const rawInput = document.getElementById('cmd-input').value.trim();
  const eolVal = document.getElementById('cmd-eol-select').value;
  const hexMode = document.getElementById('cmd-hex-mode').checked;

  if (!portId) { appendConsole('[CMD] No port selected.'); return; }
  if (!rawInput) return;

  // Resolve EOL escape sequences
  const eolMap = { '\\r\\n': '\r\n', '\\r': '\r', '\\n': '\n' };
  const eol = eolMap[eolVal] || '';
  const data = hexMode ? rawInput : rawInput + eol;

  // Save to history
  if (cmdHistory[0] !== rawInput) cmdHistory.unshift(rawInput);
  if (cmdHistory.length > 50) cmdHistory.pop();
  cmdHistoryIdx = -1;

  fetch(`/api/ports/${encodeURIComponent(portId)}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, hex: hexMode })
  })
  .then(res => res.json())
  .then(result => {
    if (result.success) {
      const display = hexMode ? `[HEX] ${rawInput}` : JSON.stringify(data);
      appendConsole(`[CMD → ${result.portName}] ${display}  (${result.bytes} bytes)`);
      document.getElementById('cmd-input').value = '';
    } else {
      appendConsole(`[CMD Error] ${result.error}`);
    }
  })
  .catch(err => appendConsole(`[CMD Error] ${err.message}`));
}

document.getElementById('btn-send-cmd').addEventListener('click', sendSerialCommand);

document.getElementById('cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendSerialCommand();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdHistory.length === 0) return;
    cmdHistoryIdx = Math.min(cmdHistoryIdx + 1, cmdHistory.length - 1);
    document.getElementById('cmd-input').value = cmdHistory[cmdHistoryIdx];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdHistoryIdx = Math.max(cmdHistoryIdx - 1, -1);
    document.getElementById('cmd-input').value = cmdHistoryIdx === -1 ? '' : cmdHistory[cmdHistoryIdx];
  }
});

// ==========================================================================
// LOCAL LOG FILE MANAGEMENT
// ==========================================================================

const logsDrawer = document.getElementById('logs-drawer');
const logsDrawerOverlay = document.getElementById('logs-drawer-overlay');
const btnLogsPanel = document.getElementById('btn-logs-panel');
const btnCloseLogs = document.getElementById('btn-close-logs');

function closeLogsDrawer() {
  if (logsDrawer) logsDrawer.classList.remove('open');
  if (logsDrawerOverlay) {
    logsDrawerOverlay.style.opacity = '0';
    setTimeout(() => logsDrawerOverlay.style.display = 'none', 300);
  }
}

// Open / Close Logs Viewer Panel
if (btnLogsPanel && logsDrawer && logsDrawerOverlay) {
  btnLogsPanel.addEventListener('click', () => {
    logsDrawer.classList.add('open');
    logsDrawerOverlay.style.display = 'block';
    setTimeout(() => logsDrawerOverlay.style.opacity = '1', 50);

    // Request list of files via socket or API
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'request_logs' }));
    }
  });
}

if (btnCloseLogs) {
  btnCloseLogs.addEventListener('click', closeLogsDrawer);
}

if (logsDrawerOverlay) {
  logsDrawerOverlay.addEventListener('click', closeLogsDrawer);
}

// Render Log list links
function renderLogsList(logs) {
  const container = document.getElementById('logs-list-container');
  container.innerHTML = '';

  if (logs.length === 0) {
    container.innerHTML = '<li><span class="text-muted">No log files found.</span></li>';
    return;
  }

  logs.forEach(log => {
    const li = document.createElement('li');
    
    const sizeStr = (log.size / 1024).toFixed(1) + ' KB';
    const dateStr = new Date(log.updatedAt).toLocaleTimeString();
    const isActive = activeViewingLog === log.name ? 'active' : '';

    li.innerHTML = `
      <button class="log-item-btn ${isActive}" onclick="viewLogFile('${log.name}')">
        <strong>${log.name}</strong>
        <div class="log-item-meta">${sizeStr} | Updated: ${dateStr}</div>
      </button>
    `;

    container.appendChild(li);
  });
}

// Fetch log file contents and display
window.viewLogFile = function(name) {
  activeViewingLog = name;
  
  // Highlight active button in sidebar
  document.querySelectorAll('.log-item-btn').forEach(btn => {
    if (btn.querySelector('strong').innerText === name) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  document.getElementById('current-viewing-log-title').innerText = `Viewing: ${name}`;
  document.getElementById('logs-viewing-actions').style.display = 'flex';
  
  // Clear file box
  document.getElementById('log-file-console').innerText = 'Loading log content...';

  // Request file content
  fetch(`/api/logs/read?name=${encodeURIComponent(name)}&maxLines=150`)
  .then(res => res.json())
  .then(data => {
    document.getElementById('log-file-console').innerText = data.content;
    document.getElementById('log-file-console').scrollTop = document.getElementById('log-file-console').scrollHeight;
  })
  .catch(err => {
    document.getElementById('log-file-console').innerText = `Error loading file: ${err.message}`;
  });
};

// Download Log
document.getElementById('btn-download-active-log').addEventListener('click', () => {
  if (!activeViewingLog) return;
  window.open(`/api/logs/download?name=${encodeURIComponent(activeViewingLog)}`);
});

// Refresh Log
document.getElementById('btn-refresh-active-log').addEventListener('click', () => {
  if (activeViewingLog) {
    viewLogFile(activeViewingLog);
  }
});

// ==========================================================================
// SYSTEM INITS ON PAGE LOAD
// ==========================================================================

window.onload = () => {
  try {
    initMap();
  } catch (mapErr) {
    console.error('[Map Error] Failed to initialize Leaflet Map. Check internet connection or unpkg.com CDN status:', mapErr.message);
    appendConsole('Failed to load map libraries. Live telemetry dashboard is still fully connected.');
  }
  connectWebSocket();
};

// ==========================================================================
// DYNAMIC CANVAS SIGNAL DRAWING OPERATIONS (SKYPLOT & SNR BAR PLOT)
// ==========================================================================

function drawSkyplot(canvas, sats) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const rMax = Math.min(w, h) / 2 - 8;

  // Clear canvas
  ctx.clearRect(0, 0, w, h);

  // Concentric elevation rings
  ctx.strokeStyle = '#20263d';
  ctx.lineWidth = 1;
  
  // 30 degree circle (r = rMax * 2/3)
  ctx.beginPath(); ctx.arc(cx, cy, rMax * (2/3), 0, Math.PI * 2); ctx.stroke();
  // 60 degree circle (r = rMax * 1/3)
  ctx.beginPath(); ctx.arc(cx, cy, rMax * (1/3), 0, Math.PI * 2); ctx.stroke();
  
  // Outer circle (0 degree)
  ctx.strokeStyle = '#323a56';
  ctx.beginPath(); ctx.arc(cx, cy, rMax, 0, Math.PI * 2); ctx.stroke();

  // Azimuth cross lines (N-S, E-W)
  ctx.beginPath();
  ctx.moveTo(cx, cy - rMax); ctx.lineTo(cx, cy + rMax);
  ctx.moveTo(cx - rMax, cy); ctx.lineTo(cx + rMax, cy);
  ctx.stroke();

  // Cardinal labels
  ctx.fillStyle = '#64748b';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - rMax + 5);
  ctx.fillText('S', cx, cy + rMax - 5);
  ctx.fillText('E', cx + rMax - 5, cy);
  ctx.fillText('W', cx - rMax + 5, cy);

  // Plot satellites in view
  sats.forEach(sat => {
    const elev = sat.elevation;
    const azim = sat.azimuth;
    
    // Convert LLA elevation (0-90) to polar radius
    const r = rMax * (1.0 - elev / 90.0);
    // Convert azimuth (0 N, clockwise) to polar angle (0 right, counterclockwise)
    const theta = (azim - 90.0) * Math.PI / 180.0;

    const sx = cx + r * Math.cos(theta);
    const sy = cy + r * Math.sin(theta);

    // Color based on constellation type
    let color = '#ef4444'; // default red
    switch (sat.constellation) {
      case 'GPS': color = '#06b6d4'; break;
      case 'GLONASS': color = '#10b981'; break;
      case 'Galileo': color = '#f59e0b'; break;
      case 'BeiDou': color = '#d946ef'; break;
      case 'QZSS': color = '#eab308'; break;
    }

    // Sat Dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();

    // High SNR glow border
    if (sat.snr && sat.snr >= 35) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Satellite label
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${sat.constellation[0]}${sat.prn}`, sx + 6, sy);
  });
}

function drawSnrPlot(canvas, sats) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const paddingLeft = 20;
  const paddingBottom = 15;
  const chartW = w - paddingLeft - 5;
  const chartH = h - paddingBottom - 5;

  ctx.clearRect(0, 0, w, h);

  // Grid Lines
  ctx.strokeStyle = '#20263d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  [15, 30, 45].forEach(db => {
    const y = chartH - (db / 50.0) * chartH + 5;
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(w, y);
  });
  ctx.stroke();

  // Y-Axis Labels
  ctx.fillStyle = '#64748b';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('45', paddingLeft - 3, chartH - (45/50)*chartH + 5);
  ctx.fillText('30', paddingLeft - 3, chartH - (30/50)*chartH + 5);
  ctx.fillText('15', paddingLeft - 3, chartH - (15/50)*chartH + 5);
  
  if (sats.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No signals tracked', w/2 + 10, h/2);
    return;
  }

  // Draw Signal Bars
  const numSats = sats.length;
  const barGap = 4;
  const barW = Math.max(5, Math.floor(chartW / numSats) - barGap);

  sats.forEach((sat, i) => {
    const snr = sat.snr || 0;
    const barH = (Math.min(50, snr) / 50.0) * chartH;
    const bx = paddingLeft + i * (barW + barGap) + barGap;
    const by = chartH - barH + 5;

    // Base color matching constellation type
    let color = '#ef4444';
    switch(sat.constellation) {
      case 'GPS': color = '#06b6d4'; break;
      case 'GLONASS': color = '#10b981'; break;
      case 'Galileo': color = '#f59e0b'; break;
      case 'BeiDou': color = '#d946ef'; break;
      case 'QZSS': color = '#eab308'; break;
    }

    ctx.fillStyle = color;
    ctx.fillRect(bx, by, barW, barH);

    // Write SNR value text inside bar if space permits
    if (barW > 12 && snr > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '7px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(snr).toString(), bx + barW/2, by - 3);
    }

    // Sat Label on X-Axis
    ctx.fillStyle = '#94a3b8';
    ctx.font = '6.5px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${sat.constellation[0]}${sat.prn}`, bx + barW/2, chartH + 13);
  });
}

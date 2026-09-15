let running = false;
let calibrated = false;
let baselinePitch = 0;
let currentPitch = null;

// Filtered GPS state
let currentSpeedMps = 0;
let lastAcceptedGpsPoint = null;
let speedSamples = [];
let lastGpsStatus = 'Waiting for GPS';

let wheelieActive = false;
let wheelieCandidateSince = null;
let landingCandidateSince = null;
let wheelieStart = 0;
let wheelieDistance = 0;
let wheelieMaxAngle = 0;
let lastTick = performance.now();

let stats = JSON.parse(localStorage.getItem('wheelieStatsV3') ||
  '{"count":0,"totalDistance":0,"bestTime":0,"bestDistance":0,"bestAngle":0}');
if (typeof stats.bestAngle !== 'number') stats.bestAngle = 0;

let wakeLock = null;
let watchId = null;

const $ = id => document.getElementById(id);

function saveStats() {
  localStorage.setItem('wheelieStatsV3', JSON.stringify(stats));
}

function updateStatsUI() {
  $('count').textContent = stats.count;
  $('totalDistance').textContent = stats.totalDistance.toFixed(1) + ' m';
  $('bestTime').textContent = stats.bestTime.toFixed(1) + ' s';
  $('bestDistance').textContent = stats.bestDistance.toFixed(1) + ' m';
  $('bestAngle').textContent = stats.bestAngle.toFixed(1) + '°';
}

function getSettings() {
  return {
    startAngle: Number($('startAngle').value),
    endAngle: Number($('endAngle').value),
    minDuration: Number($('minDuration').value),
    minSpeedKmh: Number($('minSpeed').value)
  };
}

function wheelieAngle() {
  if (!calibrated || currentPitch == null) return null;
  return Math.max(0, currentPitch - baselinePitch);
}

async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== 'granted') throw new Error('Motion permission not granted');
  }
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const r = await DeviceOrientationEvent.requestPermission();
    if (r !== 'granted') throw new Error('Orientation permission not granted');
  }
}

function onOrientation(e) {
  if (e.beta != null) currentPitch = e.beta;

  $('pitch').textContent = currentPitch == null
    ? 'Phone pitch: --°'
    : `Phone pitch: ${currentPitch.toFixed(1)}°`;

  const a = wheelieAngle();
  $('wheelieAngle').textContent = a == null ? '--°' : `${a.toFixed(1)}°`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

function filteredSpeedFromSamples() {
  if (!speedSamples.length) return 0;

  // Median suppresses single-sample GPS spikes.
  const med = median(speedSamples);

  // Blend median with recent accepted speed for a smoother display.
  return currentSpeedMps === 0 ? med : (0.65 * currentSpeedMps + 0.35 * med);
}

function onLocation(pos) {
  const c = pos.coords;
  const point = {
    lat: c.latitude,
    lon: c.longitude,
    time: pos.timestamp,
    accuracy: c.accuracy
  };

  // Reject very poor fixes. Accuracy is radius in metres.
  if (typeof c.accuracy === 'number' && c.accuracy > 35) {
    lastGpsStatus = `GPS weak (${Math.round(c.accuracy)} m)`;
    $('speed').textContent = `Filtered speed: ${(currentSpeedMps * 3.6).toFixed(1)} km/h`;
    return;
  }

  if (lastAcceptedGpsPoint) {
    const dt = (point.time - lastAcceptedGpsPoint.time) / 1000;

    if (dt >= 0.25 && dt <= 5) {
      const d = haversineMeters(lastAcceptedGpsPoint, point);
      const derivedSpeed = d / dt;
      const derivedKmh = derivedSpeed * 3.6;

      // Reject implausible jumps for this use case.
      // 80 km/h is intentionally generous so normal riding is never clipped.
      const plausible = derivedKmh <= 80 && d <= 60;

      // Ignore tiny movements that are smaller than the GPS uncertainty floor.
      const noiseFloor = Math.max(0.8, Math.min(3.0, (c.accuracy || 5) * 0.18));
      const meaningfulMove = d >= noiseFloor;

      if (plausible) {
        const sample = meaningfulMove ? derivedSpeed : 0;

        speedSamples.push(sample);
        if (speedSamples.length > 5) speedSamples.shift();
        currentSpeedMps = filteredSpeedFromSamples();

        // Wheelie distance is accumulated from accepted GPS path segments,
        // not from raw iPhone coords.speed.
        if (wheelieActive && meaningfulMove) {
          wheelieDistance += d;
        }

        lastAcceptedGpsPoint = point;
        lastGpsStatus = `GPS ±${Math.round(c.accuracy || 0)} m`;
      } else {
        // Do not advance the accepted point on a clear spike.
        lastGpsStatus = 'GPS spike rejected';
      }
    } else if (dt > 5) {
      // Long gap: reset without using the gap for distance.
      lastAcceptedGpsPoint = point;
      speedSamples = [];
      currentSpeedMps = 0;
      lastGpsStatus = 'GPS reacquired';
    }
  } else {
    lastAcceptedGpsPoint = point;
    lastGpsStatus = `GPS ±${Math.round(c.accuracy || 0)} m`;
  }

  $('speed').textContent = `Filtered speed: ${(currentSpeedMps * 3.6).toFixed(1)} km/h`;
}

function startGps() {
  if (!navigator.geolocation) throw new Error('GPS not supported');

  lastAcceptedGpsPoint = null;
  speedSamples = [];
  currentSpeedMps = 0;

  watchId = navigator.geolocation.watchPosition(
    onLocation,
    err => {
      $('status').textContent = 'GPS ERROR';
      $('status').className = 'state warn';
      console.warn(err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

async function enableWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    console.warn('Wake lock unavailable', e);
  }
}

function startWheelie(now) {
  wheelieActive = true;
  wheelieCandidateSince = null;
  landingCandidateSince = null;
  wheelieStart = now;
  wheelieDistance = 0;
  wheelieMaxAngle = wheelieAngle() || 0;
  $('currentMaxAngle').textContent = wheelieMaxAngle.toFixed(1) + '°';
  $('status').textContent = 'WHEELIE';
  $('status').className = 'state good';
}

function endWheelie(now) {
  const duration = (now - wheelieStart) / 1000;
  const s = getSettings();

  wheelieActive = false;
  landingCandidateSince = null;
  $('status').textContent = 'RIDING';
  $('status').className = 'state';

  if (duration >= s.minDuration) {
    stats.count += 1;
    stats.totalDistance += wheelieDistance;
    stats.bestTime = Math.max(stats.bestTime, duration);
    stats.bestDistance = Math.max(stats.bestDistance, wheelieDistance);
    stats.bestAngle = Math.max(stats.bestAngle, wheelieMaxAngle);
    saveStats();
    updateStatsUI();

    $('lastWheelie').textContent =
      `${duration.toFixed(1)} s · ${wheelieDistance.toFixed(1)} m · max ${wheelieMaxAngle.toFixed(1)}°`;
  }

  $('timer').textContent = '0.0';
  $('distance').textContent = '0.0 m';
  $('currentMaxAngle').textContent = '0.0°';
  wheelieMaxAngle = 0;
}

function tick(now) {
  lastTick = now;

  if (running && calibrated && currentPitch != null) {
    const s = getSettings();
    const relAngle = wheelieAngle();
    const speedKmh = currentSpeedMps * 3.6;

    $('wheelieAngle').textContent = `${relAngle.toFixed(1)}°`;

    if (!wheelieActive) {
      if (relAngle >= s.startAngle && speedKmh >= s.minSpeedKmh) {
        if (wheelieCandidateSince == null) wheelieCandidateSince = now;
        if ((now - wheelieCandidateSince) >= 350) startWheelie(now);
      } else {
        wheelieCandidateSince = null;
      }
    } else {
      const duration = (now - wheelieStart) / 1000;

      if (relAngle > wheelieMaxAngle) {
        wheelieMaxAngle = relAngle;
        $('currentMaxAngle').textContent = wheelieMaxAngle.toFixed(1) + '°';
      }

      $('timer').textContent = duration.toFixed(1);
      $('distance').textContent = wheelieDistance.toFixed(1) + ' m';

      if (relAngle <= s.endAngle) {
        if (landingCandidateSince == null) landingCandidateSince = now;
        if ((now - landingCandidateSince) >= 300) endWheelie(now);
      } else {
        landingCandidateSince = null;
      }
    }
  }

  requestAnimationFrame(tick);
}

$('startBtn').addEventListener('click', async () => {
  try {
    await requestMotionPermission();
    window.addEventListener('deviceorientation', onOrientation, true);
    startGps();
    await enableWakeLock();
    running = true;
    $('status').textContent = calibrated ? 'RIDING' : 'CALIBRATE FIRST';
    $('status').className = calibrated ? 'state' : 'state warn';
  } catch (e) {
    alert(e.message);
  }
});

$('calibrateBtn').addEventListener('click', () => {
  if (currentPitch == null) {
    alert('Start the ride first so motion data is available.');
    return;
  }
  baselinePitch = currentPitch;
  calibrated = true;
  $('calibrationText').textContent = `Calibration baseline: ${baselinePitch.toFixed(1)}°`;
  $('wheelieAngle').textContent = '0.0°';
  if (running) {
    $('status').textContent = 'RIDING';
    $('status').className = 'state';
  }
});

$('stopBtn').addEventListener('click', async () => {
  running = false;
  wheelieActive = false;
  wheelieCandidateSince = null;
  landingCandidateSince = null;

  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;

  lastAcceptedGpsPoint = null;
  speedSamples = [];
  currentSpeedMps = 0;

  try { if (wakeLock) await wakeLock.release(); } catch {}
  wakeLock = null;

  $('status').textContent = 'STOPPED';
  $('status').className = 'state warn';
  $('timer').textContent = '0.0';
  $('distance').textContent = '0.0 m';
  $('currentMaxAngle').textContent = '0.0°';
  $('speed').textContent = 'Filtered speed: -- km/h';
});

$('resetBtn').addEventListener('click', () => {
  stats = {count:0,totalDistance:0,bestTime:0,bestDistance:0,bestAngle:0};
  saveStats();
  updateStatsUI();
  $('lastWheelie').textContent = 'None yet';
  $('currentMaxAngle').textContent = '0.0°';
});

for (const id of ['startAngle','endAngle','minDuration','minSpeed']) {
  $(id).addEventListener('input', () => {
    $('startAngleLabel').textContent = $('startAngle').value;
    $('endAngleLabel').textContent = $('endAngle').value;
    $('minDurationLabel').textContent = $('minDuration').value;
    $('minSpeedLabel').textContent = $('minSpeed').value;
  });
}

updateStatsUI();
requestAnimationFrame(tick);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.warn);
}

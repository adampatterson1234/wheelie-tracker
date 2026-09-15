let running = false;
let calibrated = false;
let baselinePitch = 0;
let currentPitch = null;
let currentSpeedMps = 0;

let wheelieActive = false;
let wheelieCandidateSince = null;
let landingCandidateSince = null;
let wheelieStart = 0;
let wheelieDistance = 0;
let wheelieMaxAngle = 0;
let lastTick = performance.now();

let stats = JSON.parse(localStorage.getItem('wheelieStatsV2') || '{"count":0,"totalDistance":0,"bestTime":0,"bestDistance":0,"bestAngle":0}');
if (typeof stats.bestAngle !== 'number') stats.bestAngle = 0;

let wakeLock = null;
let watchId = null;

const $ = id => document.getElementById(id);

function saveStats() {
  localStorage.setItem('wheelieStatsV2', JSON.stringify(stats));
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
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== 'granted') throw new Error('Motion permission not granted');
  }
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
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

function onLocation(pos) {
  const c = pos.coords;
  if (typeof c.speed === 'number' && c.speed >= 0) {
    currentSpeedMps = c.speed;
  }
  $('speed').textContent = `Speed: ${(currentSpeedMps * 3.6).toFixed(1)} km/h`;
}

function startGps() {
  if (!navigator.geolocation) throw new Error('GPS not supported');
  watchId = navigator.geolocation.watchPosition(
    onLocation,
    err => {
      $('status').textContent = 'GPS ERROR';
      $('status').className = 'state warn';
      console.warn(err);
    },
    { enableHighAccuracy: true, maximumAge: 250, timeout: 10000 }
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
  const dt = Math.min((now - lastTick) / 1000, 0.25);
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
      wheelieDistance += currentSpeedMps * dt;
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

  try { if (wakeLock) await wakeLock.release(); } catch {}
  wakeLock = null;

  $('status').textContent = 'STOPPED';
  $('status').className = 'state warn';
  $('timer').textContent = '0.0';
  $('distance').textContent = '0.0 m';
  $('currentMaxAngle').textContent = '0.0°';
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

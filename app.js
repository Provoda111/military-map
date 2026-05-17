/* ============================================================
   TACTICAL OPS — Military Map Application
   Production-grade JS: pan/zoom, markers, drawing, import/export
   ============================================================ */

'use strict';

// ── STATE ────────────────────────────────────────────────────
const State = {
  // map transform
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  mapW: 2048,
  mapH: 2048,

  // tool state
  tool: 'select',
  markerType: 'friendly-infantry',
  markerCategory: 'friendly',

  // drag/pan
  isPanning: false,
  lastPanX: 0,
  lastPanY: 0,

  // markers
  markers: [],
  selectedMarkerId: null,
  undoStack: [],

  // drawing (line/zone)
  isDrawing: false,
  drawPoints: [],
  drawType: null,       // 'line' | 'zone'
  lines: [],
  zones: [],
  pendingLineColor: '#2196f3',

  // measuring
  measurePoints: [],

  // layers visibility
  layers: { friendly: true, enemy: true, neutral: true, lines: true, zones: true },

  // ui state
  showGrid: false,
  showCoords: false,
  currentMap: 'satellite',

  // pending placement
  pendingX: 0,
  pendingY: 0,

  // context menu target
  ctxTargetId: null,

  // filter
  filterCategory: 'all',
  searchQuery: '',
};

// ── MARKER DEFINITIONS ───────────────────────────────────────
const MARKER_DEFS = {
  'friendly-infantry': { icon: '🔵', label: 'Infantry',  category: 'friendly' },
  'friendly-vehicle':  { icon: '🚙', label: 'Vehicle',   category: 'friendly' },
  'friendly-armor':    { icon: '🛡',  label: 'Armor',     category: 'friendly' },
  'friendly-air':      { icon: '✈',  label: 'Air',       category: 'friendly' },
  'friendly-hq':       { icon: '⭐', label: 'HQ',        category: 'friendly' },
  'friendly-medic':    { icon: '➕', label: 'Medic',     category: 'friendly' },
  'friendly-sniper':   { icon: '🎯', label: 'Sniper',    category: 'friendly' },
  'friendly-supply':   { icon: '📦', label: 'Supply',    category: 'friendly' },
  'enemy-infantry':    { icon: '🔴', label: 'Infantry',  category: 'enemy' },
  'enemy-vehicle':     { icon: '🚗', label: 'Vehicle',   category: 'enemy' },
  'enemy-armor':       { icon: '⚠',  label: 'Armor',     category: 'enemy' },
  'enemy-air':         { icon: '🔺', label: 'Air',       category: 'enemy' },
  'enemy-sniper':      { icon: '💢', label: 'Sniper',    category: 'enemy' },
  'enemy-hq':          { icon: '☠',  label: 'HQ',        category: 'enemy' },
  'objective':         { icon: '🏁', label: 'Objective', category: 'neutral' },
  'waypoint':          { icon: '⬦',  label: 'Waypoint',  category: 'neutral' },
  'danger':            { icon: '⚡', label: 'Danger',    category: 'neutral' },
  'cache':             { icon: '💰', label: 'Cache',     category: 'neutral' },
  'observation':       { icon: '👁',  label: 'Obs.Post', category: 'neutral' },
  'ambush':            { icon: '⚔',  label: 'Ambush',   category: 'neutral' },
  'extract':           { icon: '🚁', label: 'Extract',   category: 'neutral' },
  'custom':            { icon: '✏',  label: 'Custom',    category: 'neutral' },
};

// ── DOM REFS ─────────────────────────────────────────────────
const DOM = {
  mapWrapper:     () => document.getElementById('map-wrapper'),
  mapContainer:   () => document.getElementById('map-container'),
  mapImage:       () => document.getElementById('map-image'),
  markersLayer:   () => document.getElementById('markers-layer'),
  canvas:         () => document.getElementById('overlay-canvas'),
  minimapCanvas:  () => document.getElementById('minimap-canvas'),
  minimapVp:      () => document.getElementById('minimap-viewport'),
  zoomLevel:      () => document.getElementById('zoom-level'),
  statusText:     () => document.getElementById('status-text'),
  markerCount:    () => document.getElementById('marker-count'),
  coordDisplay:   () => document.getElementById('coord-display'),
  markersList:    () => document.getElementById('markers-list'),
  markerEditor:   () => document.getElementById('marker-editor'),
  contextMenu:    () => document.getElementById('context-menu'),
  modalPlace:     () => document.getElementById('modal-place'),
  toast:          () => document.getElementById('toast'),
};

// ── UTILS ─────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, duration = 2000) {
  const t = DOM.toast();
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('visible'), duration);
}

function genId() {
  return 'mk_' + Math.random().toString(36).slice(2, 9);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Convert screen coords to map image coords
function screenToMap(sx, sy) {
  const rect = DOM.mapWrapper().getBoundingClientRect();
  const mx = (sx - rect.left - State.offsetX) / State.scale;
  const my = (sy - rect.top  - State.offsetY) / State.scale;
  return { x: mx, y: my };
}

// Convert map coords to screen coords (relative to map-wrapper)
function mapToScreen(mx, my) {
  return {
    x: mx * State.scale + State.offsetX,
    y: my * State.scale + State.offsetY,
  };
}

// ── ZOOM & PAN ────────────────────────────────────────────────
function applyTransform(animate = false) {
  const c = DOM.mapContainer();
  if (animate) c.style.transition = 'transform 0.2s ease';
  else         c.style.transition = 'none';
  c.style.transform = `translate(${State.offsetX}px, ${State.offsetY}px) scale(${State.scale})`;
  DOM.zoomLevel().textContent = Math.round(State.scale * 100) + '%';
  updateCanvas();
  updateMinimap();
}

function zoomAt(cx, cy, delta) {
  const rect = DOM.mapWrapper().getBoundingClientRect();
  const px = cx - rect.left;
  const py = cy - rect.top;

  const prevScale = State.scale;
  State.scale = clamp(State.scale * (1 + delta), 0.15, 6);
  const ratio = State.scale / prevScale;

  State.offsetX = px - (px - State.offsetX) * ratio;
  State.offsetY = py - (py - State.offsetY) * ratio;

  constrainPan();
  applyTransform();
}

function constrainPan() {
  const rect = DOM.mapWrapper().getBoundingClientRect();
  const maxX =  rect.width  * 0.9;
  const maxY =  rect.height * 0.9;
  const minX = -(State.mapW * State.scale) + rect.width  * 0.1;
  const minY = -(State.mapH * State.scale) + rect.height * 0.1;
  State.offsetX = clamp(State.offsetX, minX, maxX);
  State.offsetY = clamp(State.offsetY, minY, maxY);
}

function fitMap() {
  const rect = DOM.mapWrapper().getBoundingClientRect();
  const sw = rect.width  / State.mapW;
  const sh = rect.height / State.mapH;
  State.scale = Math.min(sw, sh) * 0.95;
  State.offsetX = (rect.width  - State.mapW * State.scale) / 2;
  State.offsetY = (rect.height - State.mapH * State.scale) / 2;
  applyTransform(true);
}

// ── CANVAS (lines, zones, grid) ───────────────────────────────
function resizeCanvas() {
  const c = DOM.canvas();
  c.width  = State.mapW;
  c.height = State.mapH;
  updateCanvas();
}

function updateCanvas() {
  const c = DOM.canvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  // GRID
  if (State.showGrid) drawGrid(ctx);

  // ZONES
  if (State.layers.zones) {
    State.zones.forEach(z => drawZone(ctx, z));
  }

  // LINES
  if (State.layers.lines) {
    State.lines.forEach(l => drawLine(ctx, l));
  }

  // DRAWING IN PROGRESS
  if (State.isDrawing && State.drawPoints.length > 1) {
    ctx.beginPath();
    ctx.moveTo(State.drawPoints[0].x, State.drawPoints[0].y);
    State.drawPoints.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = State.pendingLineColor;
    ctx.lineWidth = 2 / State.scale;
    ctx.setLineDash([6 / State.scale, 3 / State.scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // MEASURE LINE
  if (State.tool === 'measure' && State.measurePoints.length >= 2) {
    const p1 = State.measurePoints[0], p2 = State.measurePoints[1];
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 1.5 / State.scale;
    ctx.setLineDash([4 / State.scale, 3 / State.scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawGrid(ctx) {
  const step = 128;
  ctx.strokeStyle = 'rgba(0,212,255,0.08)';
  ctx.lineWidth = 1 / State.scale;
  for (let x = 0; x <= State.mapW; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, State.mapH); ctx.stroke();
  }
  for (let y = 0; y <= State.mapH; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(State.mapW, y); ctx.stroke();
  }
  if (State.showCoords) {
    ctx.fillStyle = 'rgba(0,212,255,0.4)';
    ctx.font = `${10 / State.scale}px "Share Tech Mono"`;
    for (let x = step; x < State.mapW; x += step) {
      for (let y = step; y < State.mapH; y += step) {
        ctx.fillText(`${x},${y}`, x + 2 / State.scale, y - 2 / State.scale);
      }
    }
  }
}

function drawLine(ctx, line) {
  if (!line.points || line.points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(line.points[0].x, line.points[0].y);
  line.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = line.color || '#2196f3';
  ctx.lineWidth = (line.width || 2) / State.scale;
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawZone(ctx, zone) {
  if (!zone.points || zone.points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(zone.points[0].x, zone.points[0].y);
  zone.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = zone.fillColor || 'rgba(33,150,243,0.12)';
  ctx.strokeStyle = zone.color || '#2196f3';
  ctx.lineWidth = (zone.width || 1.5) / State.scale;
  ctx.fill();
  ctx.stroke();
}

// ── MINIMAP ───────────────────────────────────────────────────
function updateMinimap() {
  const mc = DOM.minimapCanvas();
  if (!mc) return;
  const mmW = mc.parentElement.offsetWidth;
  const mmH = mc.parentElement.offsetHeight;
  mc.width  = mmW;
  mc.height = mmH;

  const ctx = mc.getContext('2d');
  ctx.clearRect(0, 0, mmW, mmH);

  const img = DOM.mapImage();
  if (img.complete) ctx.drawImage(img, 0, 0, mmW, mmH);

  // Draw markers on minimap
  const sx = mmW / State.mapW;
  const sy = mmH / State.mapH;
  State.markers.forEach(m => {
    const cat = MARKER_DEFS[m.type]?.category || 'neutral';
    ctx.beginPath();
    ctx.arc(m.x * sx, m.y * sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = cat === 'friendly' ? '#2196f3' : cat === 'enemy' ? '#f44336' : '#ff9800';
    ctx.fill();
  });

  // Viewport rect
  const wrapRect = DOM.mapWrapper().getBoundingClientRect();
  const vpX = (-State.offsetX / State.scale) * sx;
  const vpY = (-State.offsetY / State.scale) * sy;
  const vpW = (wrapRect.width  / State.scale) * sx;
  const vpH = (wrapRect.height / State.scale) * sy;

  const vp = DOM.minimapVp();
  vp.style.left   = clamp(vpX, 0, mmW) + 'px';
  vp.style.top    = clamp(vpY, 0, mmH) + 'px';
  vp.style.width  = Math.min(vpW, mmW) + 'px';
  vp.style.height = Math.min(vpH, mmH) + 'px';
}

// ── MARKER RENDERING ──────────────────────────────────────────
function renderAllMarkers() {
  const layer = DOM.markersLayer();
  layer.innerHTML = '';
  State.markers.forEach(m => {
    if (!State.layers[MARKER_DEFS[m.type]?.category]) return;
    layer.appendChild(createMarkerEl(m));
  });
  updateMarkersList();
  DOM.markerCount().textContent = State.markers.length + ' MARKERS';
  updateMinimap();
}

function createMarkerEl(m) {
  const def = MARKER_DEFS[m.type] || MARKER_DEFS['custom'];
  const cat = def.category;

  const el = document.createElement('div');
  el.className = 'marker';
  el.dataset.id = m.id;
  el.dataset.category = cat;
  el.style.left = m.x + 'px';
  el.style.top  = m.y + 'px';
  if (m.id === State.selectedMarkerId) el.classList.add('selected');

  const pin = document.createElement('div');
  pin.className = 'marker-pin';
  if (m.customColor) pin.style.background = m.customColor;

  const inner = document.createElement('div');
  inner.className = 'marker-pin-inner';
  inner.textContent = def.icon;
  pin.appendChild(inner);
  el.appendChild(pin);

  if (m.label) {
    const lbl = document.createElement('div');
    lbl.className = 'marker-label';
    lbl.textContent = m.label;
    el.appendChild(lbl);
  }

  el.addEventListener('click', e => { e.stopPropagation(); handleMarkerClick(m.id, e); });
  el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); openContextMenu(m.id, e.clientX, e.clientY); });

  // Drag to move
  let dragStartX, dragStartY, origX, origY, dragging = false;
  el.addEventListener('mousedown', e => {
    if (State.tool !== 'select') return;
    e.stopPropagation();
    dragStartX = e.clientX; dragStartY = e.clientY;
    origX = m.x; origY = m.y;
    dragging = false;

    const onMove = ev => {
      const dx = (ev.clientX - dragStartX) / State.scale;
      const dy = (ev.clientY - dragStartY) / State.scale;
      if (!dragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragging = true;
      if (!dragging) return;
      m.x = clamp(origX + dx, 0, State.mapW);
      m.y = clamp(origY + dy, 0, State.mapH);
      el.style.left = m.x + 'px';
      el.style.top  = m.y + 'px';
      updateCanvas();
      updateMinimap();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging) updateMarkersList();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return el;
}

function handleMarkerClick(id, e) {
  if (State.tool === 'delete') {
    pushUndo();
    State.markers = State.markers.filter(m => m.id !== id);
    renderAllMarkers();
    if (State.selectedMarkerId === id) deselectMarker();
    showToast('Marker deleted');
    return;
  }
  selectMarker(id);
}

function selectMarker(id) {
  State.selectedMarkerId = id;
  renderAllMarkers();
  openEditor(id);
  highlightListItem(id);
}

function deselectMarker() {
  State.selectedMarkerId = null;
  DOM.markerEditor().style.display = 'none';
  document.querySelectorAll('.marker-list-item').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll('.marker').forEach(el => el.classList.remove('selected'));
}

function openEditor(id) {
  const m = State.markers.find(x => x.id === id);
  if (!m) return;
  const editor = DOM.markerEditor();
  editor.style.display = 'block';
  document.getElementById('edit-label').value = m.label || '';
  document.getElementById('edit-notes').value = m.notes || '';
  document.getElementById('edit-color').value  = m.customColor || '#ffffff';
  document.getElementById('edit-coord-display').textContent =
    `X: ${Math.round(m.x)}  Y: ${Math.round(m.y)}`;
}

// ── MARKERS LIST ──────────────────────────────────────────────
function updateMarkersList() {
  const list = DOM.markersList();
  let filtered = State.markers;

  if (State.filterCategory !== 'all') {
    filtered = filtered.filter(m => MARKER_DEFS[m.type]?.category === State.filterCategory);
  }
  if (State.searchQuery) {
    const q = State.searchQuery.toLowerCase();
    filtered = filtered.filter(m =>
      (m.label || '').toLowerCase().includes(q) ||
      (m.notes || '').toLowerCase().includes(q) ||
      m.type.includes(q)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <span class="empty-icon">📍</span>
      <span>${State.markers.length === 0 ? 'No markers yet.<br/>Select PLACE tool and click on map.' : 'No markers match your filter.'}</span>
    </div>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(m => {
    const def = MARKER_DEFS[m.type] || {};
    const cat = def.category || 'neutral';
    const item = document.createElement('div');
    item.className = 'marker-list-item' + (m.id === State.selectedMarkerId ? ' selected' : '');
    item.dataset.id = m.id;

    item.innerHTML = `
      <div class="mli-dot ${cat}"></div>
      <div class="mli-info">
        <div class="mli-name">${m.label || def.label || 'Unnamed'}</div>
        <div class="mli-type">${m.type.toUpperCase().replace(/-/g,' ')}</div>
      </div>
      <button class="mli-delete" data-id="${m.id}" title="Delete">✕</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.classList.contains('mli-delete')) {
        e.stopPropagation();
        pushUndo();
        State.markers = State.markers.filter(x => x.id !== m.id);
        renderAllMarkers();
        if (State.selectedMarkerId === m.id) deselectMarker();
        return;
      }
      panToMarker(m);
      selectMarker(m.id);
    });
    list.appendChild(item);
  });
}

function highlightListItem(id) {
  document.querySelectorAll('.marker-list-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
}

function panToMarker(m) {
  const rect = DOM.mapWrapper().getBoundingClientRect();
  State.offsetX = rect.width  / 2 - m.x * State.scale;
  State.offsetY = rect.height / 2 - m.y * State.scale;
  constrainPan();
  applyTransform(true);
}

// ── PLACE MARKER ──────────────────────────────────────────────
function placeMarker(mx, my) {
  State.pendingX = mx;
  State.pendingY = my;
  document.getElementById('place-label').value = '';
  document.getElementById('place-notes').value = '';
  DOM.modalPlace().style.display = 'flex';
  setTimeout(() => document.getElementById('place-label').focus(), 50);
}

function confirmPlace() {
  const label = document.getElementById('place-label').value.trim();
  const notes = document.getElementById('place-notes').value.trim();
  pushUndo();
  const m = {
    id: genId(),
    type: State.markerType,
    category: State.markerCategory,
    x: State.pendingX,
    y: State.pendingY,
    label,
    notes,
    customColor: null,
    createdAt: Date.now(),
  };
  State.markers.push(m);
  DOM.modalPlace().style.display = 'none';
  renderAllMarkers();
  selectMarker(m.id);
  showToast(`Marker placed: ${label || MARKER_DEFS[m.type]?.label}`);
}

// ── CONTEXT MENU ──────────────────────────────────────────────
function openContextMenu(id, cx, cy) {
  State.ctxTargetId = id;
  const cm = DOM.contextMenu();
  cm.style.display = 'block';
  cm.style.left = cx + 'px';
  cm.style.top  = cy + 'px';
  // keep in viewport
  const rect = cm.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  cm.style.left = (cx - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) cm.style.top  = (cy - rect.height) + 'px';
  selectMarker(id);
}

function closeContextMenu() {
  DOM.contextMenu().style.display = 'none';
  State.ctxTargetId = null;
}

// ── UNDO ──────────────────────────────────────────────────────
function pushUndo() {
  State.undoStack.push({
    markers: JSON.parse(JSON.stringify(State.markers)),
    lines:   JSON.parse(JSON.stringify(State.lines)),
    zones:   JSON.parse(JSON.stringify(State.zones)),
  });
  if (State.undoStack.length > 50) State.undoStack.shift();
}

function undo() {
  if (!State.undoStack.length) { showToast('Nothing to undo'); return; }
  const prev = State.undoStack.pop();
  State.markers = prev.markers;
  State.lines   = prev.lines;
  State.zones   = prev.zones;
  renderAllMarkers();
  updateCanvas();
  showToast('Undone');
}

// ── IMPORT / EXPORT ───────────────────────────────────────────
function exportData() {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    mapType: State.currentMap,
    markers: State.markers,
    lines:   State.lines,
    zones:   State.zones,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'tactical-map-' + Date.now() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Map exported!');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      pushUndo();
      State.markers = data.markers || [];
      State.lines   = data.lines   || [];
      State.zones   = data.zones   || [];
      renderAllMarkers();
      updateCanvas();
      showToast(`Imported: ${State.markers.length} markers`);
    } catch {
      showToast('Invalid file format');
    }
  };
  reader.readAsText(file);
}

// ── TOOL SWITCHING ────────────────────────────────────────────
function setTool(tool) {
  State.tool = tool;
  State.isDrawing = false;
  State.drawPoints = [];
  State.measurePoints = [];
  updateCanvas();

  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });

  const wrapper = DOM.mapWrapper();
  wrapper.className = 'map-wrapper mode-' + tool;
  DOM.statusText().textContent = tool.toUpperCase().replace('-',' ');

  if (tool === 'draw-line') {
    State.drawType = 'line';
    State.pendingLineColor = '#2196f3';
    showToast('Click to add points • Double-click to finish line');
  } else if (tool === 'draw-zone') {
    State.drawType = 'zone';
    State.pendingLineColor = '#4caf50';
    showToast('Click to add points • Double-click to close zone');
  } else if (tool === 'measure') {
    showToast('Click two points to measure distance');
  }
}

// ── DRAWING (lines & zones) ───────────────────────────────────
function handleDrawClick(mapX, mapY) {
  State.isDrawing = true;
  State.drawPoints.push({ x: mapX, y: mapY });
  updateCanvas();
}

function finishDrawing() {
  if (State.drawPoints.length < 2) {
    State.isDrawing = false;
    State.drawPoints = [];
    updateCanvas();
    return;
  }
  pushUndo();
  if (State.drawType === 'line') {
    State.lines.push({
      id: genId(),
      points: [...State.drawPoints],
      color: State.pendingLineColor,
      width: 2,
    });
    showToast('Line placed');
  } else if (State.drawType === 'zone') {
    State.zones.push({
      id: genId(),
      points: [...State.drawPoints],
      color: State.pendingLineColor,
      fillColor: State.pendingLineColor.replace('rgb', 'rgba').replace(')', ',0.12)'),
      width: 1.5,
    });
    showToast('Zone placed');
  }
  State.isDrawing = false;
  State.drawPoints = [];
  updateCanvas();
}

// ── MEASURE ───────────────────────────────────────────────────
let measureTooltipEl = null;
function handleMeasureClick(mapX, mapY) {
  State.measurePoints.push({ x: mapX, y: mapY });
  if (State.measurePoints.length === 2) {
    const p1 = State.measurePoints[0], p2 = State.measurePoints[1];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    showToast(`Distance: ${Math.round(dist)} px`);
    updateCanvas();
    State.measurePoints = [];
  } else {
    updateCanvas();
  }
}

// ── MAP SWITCHING ─────────────────────────────────────────────
function switchMap(mapType) {
  State.currentMap = mapType;
  const img = DOM.mapImage();
  if (mapType === 'satellite') {
    img.src = 'GTAV-HD-MAP-satellite__3_.jpg';
  } else {
    img.src = 'GTAV_ATLUS_8192x8192__1_.png';
  }
  document.querySelectorAll('.map-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.map === mapType);
  });
  img.onload = () => {
    State.mapW = img.naturalWidth  > 4000 ? 2048 : img.naturalWidth  || 2048;
    State.mapH = img.naturalHeight > 4000 ? 2048 : img.naturalHeight || 2048;
    img.style.width = State.mapW + 'px';
    resizeCanvas();
    updateMinimap();
  };
  showToast(`Map: ${mapType.toUpperCase()}`);
}

// ── EVENT BINDING ──────────────────────────────────────────────
function bindEvents() {
  const wrapper = DOM.mapWrapper();

  // ── MOUSE WHEEL (zoom)
  wrapper.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    zoomAt(e.clientX, e.clientY, delta);
  }, { passive: false });

  // ── MOUSE DOWN
  wrapper.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && State.tool === 'select')) {
      // pan
      State.isPanning = true;
      State.lastPanX = e.clientX;
      State.lastPanY = e.clientY;
      wrapper.style.cursor = 'grabbing';
    }
  });

  // ── MOUSE MOVE
  window.addEventListener('mousemove', e => {
    const { x, y } = screenToMap(e.clientX, e.clientY);
    DOM.coordDisplay().textContent = `X: ${Math.round(x)}  Y: ${Math.round(y)}`;

    if (State.isPanning) {
      State.offsetX += e.clientX - State.lastPanX;
      State.offsetY += e.clientY - State.lastPanY;
      State.lastPanX = e.clientX;
      State.lastPanY = e.clientY;
      constrainPan();
      applyTransform();
    }
  });

  // ── MOUSE UP
  window.addEventListener('mouseup', e => {
    if (State.isPanning) {
      State.isPanning = false;
      DOM.mapWrapper().style.cursor = '';
    }
  });

  // ── CLICK ON MAP
  wrapper.addEventListener('click', e => {
    closeContextMenu();
    if (State.isPanning) return;

    const { x, y } = screenToMap(e.clientX, e.clientY);

    if (State.tool === 'place') {
      placeMarker(x, y);
    } else if (State.tool === 'draw-line' || State.tool === 'draw-zone') {
      handleDrawClick(x, y);
    } else if (State.tool === 'measure') {
      handleMeasureClick(x, y);
    } else if (State.tool === 'select') {
      deselectMarker();
    }
  });

  // ── DOUBLE CLICK: finish drawing
  wrapper.addEventListener('dblclick', e => {
    if (State.tool === 'draw-line' || State.tool === 'draw-zone') {
      e.preventDefault();
      finishDrawing();
    }
  });

  // ── CONTEXT MENU: prevent default on map
  wrapper.addEventListener('contextmenu', e => {
    e.preventDefault();
    closeContextMenu();
  });

  // ── KEYBOARD
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      closeContextMenu();
      DOM.modalPlace().style.display = 'none';
      if (State.isDrawing) { State.isDrawing = false; State.drawPoints = []; updateCanvas(); }
      deselectMarker();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth/2, window.innerHeight/2,  0.15);
    if (e.key === '-')                  zoomAt(window.innerWidth/2, window.innerHeight/2, -0.15);
    if (e.key === 'f' || e.key === 'F') fitMap();
    if (e.key === 'Delete' && State.selectedMarkerId) {
      pushUndo();
      State.markers = State.markers.filter(m => m.id !== State.selectedMarkerId);
      deselectMarker();
      renderAllMarkers();
    }
    // Tool shortcuts
    const shortcuts = { s:'select', p:'place', l:'draw-line', z:'draw-zone', m:'measure', d:'delete' };
    if (shortcuts[e.key]) setTool(shortcuts[e.key]);
  });

  // ── TOOL BUTTONS
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // ── MARKER TYPE BUTTONS
  document.querySelectorAll('.marker-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.marker-select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.markerType     = btn.dataset.type;
      State.markerCategory = btn.dataset.category;
      if (State.tool !== 'place') setTool('place');
      showToast(`Type: ${MARKER_DEFS[btn.dataset.type]?.label || 'Custom'}`);
    });
  });

  // ── MAP BUTTONS
  document.querySelectorAll('.map-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMap(btn.dataset.map));
  });

  // ── ZOOM CONTROLS
  document.getElementById('zoom-in').addEventListener('click',  () => zoomAt(window.innerWidth/2, window.innerHeight/2,  0.2));
  document.getElementById('zoom-out').addEventListener('click', () => zoomAt(window.innerWidth/2, window.innerHeight/2, -0.2));
  document.getElementById('zoom-fit').addEventListener('click', fitMap);

  // ── TOOLBAR
  document.getElementById('btn-undo').addEventListener('click',       undo);
  document.getElementById('btn-export').addEventListener('click',     exportData);
  document.getElementById('btn-clear-all').addEventListener('click',  () => {
    if (!confirm('Clear ALL markers, lines and zones?')) return;
    pushUndo();
    State.markers = []; State.lines = []; State.zones = [];
    deselectMarker();
    renderAllMarkers();
    updateCanvas();
    showToast('Map cleared');
  });
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot);

  // ── GRID / COORDS
  document.getElementById('btn-grid').addEventListener('click', e => {
    State.showGrid = !State.showGrid;
    e.currentTarget.classList.toggle('active', State.showGrid);
    updateCanvas();
  });
  document.getElementById('btn-coords').addEventListener('click', e => {
    State.showCoords = !State.showCoords;
    e.currentTarget.classList.toggle('active', State.showCoords);
    updateCanvas();
  });

  // ── LAYER TOGGLES
  document.querySelectorAll('[data-layer]').forEach(cb => {
    cb.addEventListener('change', () => {
      State.layers[cb.dataset.layer] = cb.checked;
      renderAllMarkers();
      updateCanvas();
    });
  });

  // ── SEARCH
  document.getElementById('marker-search').addEventListener('input', e => {
    State.searchQuery = e.target.value.trim();
    updateMarkersList();
  });

  // ── FILTER BUTTONS
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.filterCategory = btn.dataset.filter;
      updateMarkersList();
    });
  });

  // ── EDITOR SAVE
  document.getElementById('edit-save').addEventListener('click', () => {
    const m = State.markers.find(x => x.id === State.selectedMarkerId);
    if (!m) return;
    m.label       = document.getElementById('edit-label').value.trim();
    m.notes       = document.getElementById('edit-notes').value.trim();
    m.customColor = document.getElementById('edit-color').value;
    renderAllMarkers();
    selectMarker(m.id);
    showToast('Marker updated');
  });

  document.getElementById('edit-delete').addEventListener('click', () => {
    if (!State.selectedMarkerId) return;
    pushUndo();
    State.markers = State.markers.filter(x => x.id !== State.selectedMarkerId);
    deselectMarker();
    renderAllMarkers();
    showToast('Marker deleted');
  });

  // ── MODAL
  document.getElementById('place-confirm').addEventListener('click', confirmPlace);
  document.getElementById('place-cancel').addEventListener('click',  () => DOM.modalPlace().style.display = 'none');
  document.getElementById('place-label').addEventListener('keydown', e => { if (e.key === 'Enter') confirmPlace(); });

  // ── CONTEXT MENU
  document.getElementById('cm-edit').addEventListener('click', () => {
    openEditor(State.ctxTargetId);
    closeContextMenu();
  });
  document.getElementById('cm-duplicate').addEventListener('click', () => {
    const m = State.markers.find(x => x.id === State.ctxTargetId);
    if (!m) return;
    pushUndo();
    const copy = { ...m, id: genId(), x: m.x + 20, y: m.y + 20 };
    State.markers.push(copy);
    renderAllMarkers();
    selectMarker(copy.id);
    closeContextMenu();
    showToast('Marker duplicated');
  });
  document.getElementById('cm-delete').addEventListener('click', () => {
    pushUndo();
    State.markers = State.markers.filter(x => x.id !== State.ctxTargetId);
    if (State.selectedMarkerId === State.ctxTargetId) deselectMarker();
    renderAllMarkers();
    closeContextMenu();
    showToast('Marker deleted');
  });

  window.addEventListener('click', e => {
    if (!DOM.contextMenu().contains(e.target)) closeContextMenu();
  });

  // ── PANEL TOGGLES
  document.getElementById('toggle-left').addEventListener('click', () => {
    document.getElementById('panel-tools').classList.toggle('collapsed');
  });
  document.getElementById('toggle-right').addEventListener('click', () => {
    document.getElementById('panel-markers').classList.toggle('collapsed');
  });

  // ── MINIMAP CLICK
  document.getElementById('minimap').addEventListener('click', e => {
    const mc = DOM.minimapCanvas();
    const rect = mc.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / rect.width;
    const ry = (e.clientY - rect.top) / rect.height;
    const wrapRect = DOM.mapWrapper().getBoundingClientRect();
    State.offsetX = -(rx * State.mapW * State.scale) + wrapRect.width  / 2;
    State.offsetY = -(ry * State.mapH * State.scale) + wrapRect.height / 2;
    constrainPan();
    applyTransform(true);
  });

  // ── RESIZE
  window.addEventListener('resize', () => { fitMap(); updateMinimap(); });
}

// ── SCREENSHOT ────────────────────────────────────────────────
function takeScreenshot() {
  showToast('Use browser screenshot (Print Screen or browser extension) for best results');
}

// ── INIT ──────────────────────────────────────────────────────
function init() {
  // Set image size display
  const img = DOM.mapImage();
  img.style.width = State.mapW + 'px';
  img.onload = () => {
    resizeCanvas();
    updateMinimap();
  };
  if (img.complete) {
    resizeCanvas();
    updateMinimap();
  }

  bindEvents();
  setTool('select');
  fitMap();

  showToast('Welcome to Tactical Ops — GTA V Military Map', 3000);
}

document.addEventListener('DOMContentLoaded', init);

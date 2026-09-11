import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { AircraftModels } from './aircraft-models.js';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

// AirNav planes30-x@2x atlas: three 80px columns (normal, selected, shadow).
const familySpriteIndex = { A320: 0, B738: 7, B789: 10, HELI: 24 };
const familyToModel = {
  // a320-ready is the downloaded A320, decoded once at build time from
  // EXT_meshopt_compression so browser rendering does not depend on WASM.
  A320: { file: 'a320-ready.glb', rotateY: 0 }, B738: { file: 'a320-ready.glb', rotateY: 0 },
  B789: { file: 'b789.glb', rotateY: -Math.PI / 2 }, HELI: { file: 'heli.glb', rotateY: -Math.PI / 2 }
};

const featuredAircraft = [
  { id: 'ACA142', callsign: 'ACA142', family: 'A320', lng: 121.455, lat: 31.220, heading: 62, altitude: 1200, color: '#ffbd4a', length: 38 },
  { id: 'ANA962', callsign: 'ANA962', family: 'B789', lng: 121.498, lat: 31.202, heading: 290, altitude: 1800, color: '#73b7ff', length: 63 },
  { id: 'B-70HX', callsign: 'B-70HX', family: 'HELI', lng: 121.435, lat: 31.190, heading: 355, altitude: 300, color: '#6fe1c1', length: 14 }
];

const familyVariants = [
  { family: 'A320', color: '#ffbd4a', length: 38 },
  { family: 'B738', color: '#ffbd4a', length: 40 },
  { family: 'B789', color: '#73b7ff', length: 63 },
  { family: 'HELI', color: '#6fe1c1', length: 14 }
];

// Deterministic sample traffic: enough density to judge decluttering and model scale.
const backgroundAircraft = Array.from({ length: 36 }, (_, index) => {
  const variant = familyVariants[index % familyVariants.length];
  const ring = 0.012 + Math.floor(index / 8) * 0.009;
  const angle = index * 2.3999632297;
  return {
    id: `DEMO${String(index + 1).padStart(3, '0')}`,
    callsign: `DEMO${String(index + 1).padStart(3, '0')}`,
    ...variant,
    lng: 121.47 + Math.cos(angle) * ring * 1.32,
    lat: 31.21 + Math.sin(angle) * ring,
    heading: (index * 47 + 18) % 360,
    altitude: 500 + (index % 7) * 350
  };
});

const aircraft = [...featuredAircraft, ...backgroundAircraft];

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' }
    },
    layers: [{ id: 'base', type: 'raster', source: 'osm', paint: { 'raster-brightness-min': 0.22, 'raster-brightness-max': 0.7 } }]
  },
  center: [121.47, 31.21], zoom: 11.3, pitch: 0, bearing: -18,
  antialias: true
});

const pitchInput = document.querySelector('#pitch');
const pitchValue = document.querySelector('#pitch-value');
const modeCopy = document.querySelector('#mode-copy');
const dropLines = document.querySelector('#drop-lines');
const glbModels = document.querySelector('#glb-models');
// AirNav enables its 3D custom layers whenever the map is tilted at all.
const is3d = () => map.getPitch() > 0;

async function addAirNavSprites() {
  const atlas = await new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = '/planes30-x@2x.png';
  });
  const families = [...new Set(aircraft.map(({ family }) => family))];
  await Promise.all(families.flatMap(async family => {
    const row = familySpriteIndex[family];
    const normal = await createImageBitmap(atlas, 0, row * 80, 80, 80);
    const selected = await createImageBitmap(atlas, 80, row * 80, 80, 80);
    const shadow = await createImageBitmap(atlas, 160, row * 80, 80, 80);
    map.addImage(`aircraft-${family}-normal`, normal, { pixelRatio: 1 });
    map.addImage(`aircraft-${family}-selected`, selected, { pixelRatio: 1 });
    map.addImage(`aircraft-${family}-shadow`, shadow, { pixelRatio: 1 });
  }));
}

function flatFeatureCollection() {
  return { type: 'FeatureCollection', features: aircraft.map(a => ({
    type: 'Feature', id: a.id, geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
    properties: { ...a, icon: `aircraft-${a.family}-normal`, shadow: `aircraft-${a.family}-shadow`, rotation: a.heading }
  }))};
}

function updateMode() {
  const threeMode = is3d();
  ['aircraft-2d', 'aircraft-2d-shadow'].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', threeMode ? 'none' : 'visible'));
  // AirNav's globe/city overview uses elevated sprites.  True meshes are a
  // close-inspection feature: enabling them at overview zoom causes the
  // overlapping, faceted look visible in the earlier prototype.
  const modelMode = threeMode && glbModels.checked && map.getZoom() >= 6;
  threeLayer?.setVisible(threeMode, !modelMode);
  modelLayer?.setVisible(modelMode);
  modeCopy.textContent = modelMode ? '地图仰起：AirNav GLB 模型 + 高度层' : threeMode && glbModels.checked ? 'GLB 仅在缩放 ≥ 6 使用；当前为 AirNav 2.5D sprite' : threeMode ? '地图仰起：AirNav 2.5D sprite + shadow' : '平视地图：AirNav 2D sprite';
  document.querySelector('#status-copy').textContent = modelLayer?.errors?.length
    ? `GLB load error · ${modelLayer.errors.join(' | ')}`
    : modelMode && modelLayer?.groups?.length
      ? `GLB loaded · ${modelLayer.groups.length} meshes`
      : `${aircraft.length} targets · ${modelMode ? 'GLB model mode' : threeMode ? '2.5D sprite mode' : 'sprite mode'}`;
}

class Aircraft3DLayer {
  id = 'aircraft-3d'; type = 'custom'; renderingMode = '3d';
  constructor(items) { this.items = items; this.visible = false; this.scene = new THREE.Scene(); this.camera = new THREE.Camera(); this.groups = []; }
  async onAdd(mapRef, gl) {
    this.map = mapRef;
    this.renderer = new THREE.WebGLRenderer({ canvas: mapRef.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    const atlas = await this.loadAtlas();
    for (const item of this.items) this.addAircraft(item, atlas);
    this.map.triggerRepaint();
  }
  async loadAtlas() {
    const image = await new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = '/planes30-x@2x.png';
    });
    const crop = (column, row) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 80;
      canvas.getContext('2d').drawImage(image, column * 80, row * 80, 80, 80, 0, 0, 80, 80);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      return texture;
    };
    return new Map([...new Set(this.items.map(({ family }) => family))].map(family => [family, { normal: crop(0, familySpriteIndex[family]), shadow: crop(2, familySpriteIndex[family]) }]));
  }
  addAircraft(item, atlas) {
    const root = new THREE.Group(); root.visible = false; this.scene.add(root); this.groups.push({ item, root });
    const elevated = maplibregl.MercatorCoordinate.fromLngLat([item.lng, item.lat], item.altitude);
    const ground = maplibregl.MercatorCoordinate.fromLngLat([item.lng, item.lat], 0);
    root.position.set(elevated.x, elevated.y, elevated.z);
    const dropLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -(elevated.z - ground.z))]),
      new THREE.LineBasicMaterial({ color: 0xc8d0d6, transparent: true, opacity: .36, depthWrite: false })
    );
    root.add(dropLine);
    const heading = -THREE.MathUtils.degToRad(item.heading);
    const sprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: atlas.get(item.family).normal, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    sprite.rotation.z = heading; sprite.renderOrder = 3; sprite.userData.icon = true; root.add(sprite);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: atlas.get(item.family).shadow, transparent: true, opacity: .72, depthWrite: false, side: THREE.DoubleSide }));
    shadow.position.z = -(elevated.z - ground.z) + 0.00000001;
    shadow.rotation.z = heading; shadow.renderOrder = 2; shadow.userData.icon = true; shadow.userData.shadow = true; root.add(shadow);
  }
  render(gl, args) {
    if (!this.visible) return;
    for (const { root } of this.groups) root.visible = true;
    // GLB meshes share this proven MapLibre/Three render pass. Their custom
    // layer is retained for lifecycle/loading only; a second pass on the
    // shared canvas was not submitted reliably by MapLibre.
    this.groups.forEach(({ root, item }) => {
      root.children[0].visible = dropLines.checked;
      const iconSize = 30 / this.map.transform.worldSize;
      root.children.filter(child => child.userData.icon).forEach(icon => { icon.visible = !modelLayer?.hasModel(item.id) || icon.userData.shadow; icon.scale.setScalar(iconSize); });
    });
    const matrix = args.defaultProjectionData?.mainMatrix ?? args;
    this.camera.projectionMatrix.fromArray(matrix);
    this.renderer.resetState(); this.renderer.render(this.scene, this.camera);
    modelLayer?.render(this.renderer, gl, args);
  }
  setVisible(value, showAirIcons = true) { this.visible = value; this.showAirIcons = showAirIcons; this.groups.forEach(({ root }) => root.visible = value); this.map?.triggerRepaint(); }
}


let threeLayer, modelLayer;
if (import.meta.env.DEV) window.aircraftDebug = { map, get modelLayer() { return modelLayer; }, get threeLayer() { return threeLayer; } };
map.on('load', () => {
  addAirNavSprites().then(() => {
    map.addSource('aircraft', { type: 'geojson', data: flatFeatureCollection() });
    map.addLayer({ id: 'aircraft-2d-shadow', type: 'symbol', source: 'aircraft', layout: { 'icon-image': ['get', 'shadow'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, .30, 14, .58], 'icon-rotate': ['get', 'rotation'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true }, paint: { 'icon-translate': [2, 2], 'icon-opacity': .55 } });
    map.addLayer({ id: 'aircraft-2d', type: 'symbol', source: 'aircraft', layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, .22, 14, .48], 'icon-rotate': ['get', 'rotation'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true } });
    updateMode();
  }).catch(error => console.error('AirNav sprite atlas failed to load', error));
  threeLayer = new Aircraft3DLayer(aircraft); map.addLayer(threeLayer);
  // Models deliberately share aircraft-3d's custom-layer render pass.  Do
  // not register a second MapLibre custom layer: in this demo style its
  // lifecycle callback was skipped, leaving all GLBs outside the scene.
  modelLayer = new AircraftModels(aircraft, updateMode);
  modelLayer.load(map);
});

pitchInput.addEventListener('input', () => map.easeTo({ pitch: Number(pitchInput.value), duration: 0 }));
map.on('pitch', () => { pitchInput.value = String(Math.round(map.getPitch())); pitchValue.value = `${Math.round(map.getPitch())}°`; updateMode(); });
map.on('zoom', updateMode);
dropLines.addEventListener('change', () => map.triggerRepaint());
glbModels.addEventListener('change', () => {
  if (glbModels.checked && map.getPitch() === 0) map.easeTo({ pitch: 60, duration: 500 });
  updateMode();
});

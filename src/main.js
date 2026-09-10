import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
    modelLayer?.updateInSharedScene();
    this.groups.forEach(({ root }) => {
      root.children[0].visible = dropLines.checked;
      const iconSize = 30 / this.map.transform.worldSize;
      root.children.filter(child => child.userData.icon).forEach(icon => { icon.visible = this.showAirIcons || icon.userData.shadow; icon.scale.setScalar(iconSize); });
    });
    const matrix = args.defaultProjectionData?.mainMatrix ?? args;
    this.camera.projectionMatrix.fromArray(matrix);
    this.renderer.resetState(); this.renderer.render(this.scene, this.camera); this.map.triggerRepaint();
  }
  setVisible(value, showAirIcons = true) { this.visible = value; this.showAirIcons = showAirIcons; this.groups.forEach(({ root }) => root.visible = value); this.map?.triggerRepaint(); }
}

class AircraftModelLayer {
  id = 'aircraft-model-3d'; type = 'custom'; renderingMode = '3d';
  constructor(items) { this.items = items; this.visible = false; this.scene = new THREE.Scene(); this.camera = new THREE.Camera(); this.cache = new Map(); this.groups = []; this.errors = []; }
  onAdd(mapRef, gl) {
    this.map = mapRef;
    document.querySelector('#status-copy').textContent = 'GLB: attaching shared scene…';
    // MapLibre exposes one WebGL context for all custom layers. Reuse the
    // renderer already attached by the altitude layer; constructing a second
    // WebGLRenderer on that canvas was the reason this layer never submitted
    // any geometry (including the diagnostic cube) to the map pass.
    this.scene = threeLayer.scene;
    this.camera = threeLayer.camera;
    this.renderer = threeLayer.renderer;
    this.renderer.autoClear = false;
    // A high, cool key light makes the fuselage and wing thickness readable
    // against a tilted map; the old almost-flat ambient illumination made a
    // GLB indistinguishable from the atlas sprite.
    this.scene.add(new THREE.HemisphereLight(0xf7fbff, 0x17202a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.35); key.position.set(-18, -24, 72); this.scene.add(key);
    this.loader = new GLTFLoader(); this.loader.setMeshoptDecoder(MeshoptDecoder);
    [...new Set(this.items.map(({ family }) => family))].forEach(family => this.loadFamily(family));
  }
  async loadFamily(family) {
    const config = familyToModel[family];
    try {
      if (!this.cache.has(config.file)) this.cache.set(config.file, this.loader.loadAsync(`/${config.file}`));
      const geometry = this.prepareGeometry((await this.cache.get(config.file)).scene, config.rotateY);
      const length = this.modelLength(geometry);
      // GLB meshes use the same rooted-coordinate pattern as the working
      // altitude-sprite layer. This avoids the failed instanced world-matrix
      // projection and keeps each downloaded model genuinely drawable.
      this.items.filter(item => item.family === family).forEach(item => {
        const root = new THREE.Group();
        const outlineGeometry = geometry.clone(); outlineGeometry.scale(1.026, 1.026, 1.026);
        // MapLibre's raster base map has already populated the shared depth
        // buffer. Aircraft are an overlay (as in AirNav's altitude layer),
        // so they must not be depth-rejected by the map surface.
        const outline = new THREE.Mesh(outlineGeometry, new THREE.MeshBasicMaterial({ color: 0x17212b, side: THREE.BackSide, transparent: true, opacity: .42, depthTest: false, depthWrite: false }));
        const surface = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color: item.color, shininess: 42, specular: 0x334455, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        outline.renderOrder = 4; surface.renderOrder = 5;
        root.add(outline, surface); root.visible = this.visible;
        this.scene.add(root); this.groups.push({ item, root, length });
      });
      if (glbModels.checked) document.querySelector('#status-copy').textContent = `GLB loaded · ${this.groups.length} aircraft meshes`;
      this.map.triggerRepaint();
    } catch (error) {
      this.errors.push(`${family}: ${error.message || error}`);
      console.warn('GLB batch unavailable', family, error);
      document.querySelector('#status-copy').textContent = `GLB load error · ${this.errors.join(' | ')}`;
    }
  }
  prepareGeometry(scene, rotateY) {
    scene.updateMatrixWorld(true);
    const transforms = [new THREE.Matrix4().makeRotationY(rotateY), new THREE.Matrix4().makeRotationX(Math.PI / 2)];
    const parts = [];
    scene.traverse(mesh => { if (mesh.isMesh) { const geometry = mesh.geometry.clone(); geometry.applyMatrix4(mesh.matrixWorld); transforms.forEach(transform => geometry.applyMatrix4(transform)); geometry.computeVertexNormals(); parts.push(geometry); } });
    const geometry = mergeGeometries(parts, false);
    parts.forEach(part => part.dispose());
    geometry.computeBoundingBox();
    const box = geometry.boundingBox; const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -box.min.z);
    // GLB exporters do not agree on authoring units. Normalize every decoded
    // airframe to a one-unit bounding length before placing it in Mercator
    // space; otherwise a model authored in millimetres is effectively
    // microscopic beside the fixed-size altitude sprites.
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    geometry.scale(1 / longest, 1 / longest, 1 / longest);
    return geometry;
  }
  modelLength(geometry) { geometry.computeBoundingBox(); const size = geometry.boundingBox.getSize(new THREE.Vector3()); return Math.max(size.x, size.y, size.z); }
  render(gl, args) {
    this.updateInSharedScene();
  }
  updateInSharedScene() {
    if (!this.visible) return;
    // This is an explicit *near* model mode, not the overview sprite layer.
    // At the earlier 56px floor a 38m A320 was projected to roughly 20px at
    // pitch 60°, so its GLB surface could not be told apart from a sprite.
    const minWorldSize = (this.map.getZoom() >= 13 ? 156 : 72) / this.map.transform.worldSize;
    this.groups.forEach(({ item, root, length }) => {
      const merc = maplibregl.MercatorCoordinate.fromLngLat([item.lng, item.lat], item.altitude);
      const selectedBoost = item.id === featuredAircraft[0].id ? 1.3 : 1;
      const size = selectedBoost * Math.max(item.length * merc.meterInMercatorCoordinateUnits(), minWorldSize) / length;
      root.visible = true;
      root.position.set(merc.x, merc.y, merc.z);
      root.rotation.set(0, 0, -THREE.MathUtils.degToRad(item.heading));
      root.scale.setScalar(size);
    });
  }
  setVisible(value) { this.visible = value; this.groups.forEach(({ root }) => { root.visible = value; }); this.map?.triggerRepaint(); }
}

let threeLayer, modelLayer;
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
  modelLayer = new AircraftModelLayer(aircraft);
  const attachModels = () => {
    if (!threeLayer.renderer) return requestAnimationFrame(attachModels);
    modelLayer.onAdd(map, null);
  };
  requestAnimationFrame(attachModels);
});

pitchInput.addEventListener('input', () => map.easeTo({ pitch: Number(pitchInput.value), duration: 0 }));
map.on('pitch', () => { pitchInput.value = String(Math.round(map.getPitch())); pitchValue.value = `${Math.round(map.getPitch())}°`; updateMode(); });
map.on('zoom', updateMode);
dropLines.addEventListener('change', () => map.triggerRepaint());
glbModels.addEventListener('change', () => {
  if (glbModels.checked && (map.getZoom() < 15 || map.getPitch() < 55)) {
    const focus = featuredAircraft[0];
    map.easeTo({ center: [focus.lng, focus.lat], zoom: 15.2, pitch: 60, duration: 650 });
  }
  updateMode();
});

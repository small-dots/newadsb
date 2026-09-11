import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Parameters verified in AirNav's model-3d-mesh and altitude-3d HAR assets.
const configs = {
  A320: { file: 'a320.glb', rotateY: 0, px: .72 },
  B738: { file: 'a320.glb', rotateY: 0, px: .72 },
  B789: { file: 'b789.glb', rotateY: -Math.PI / 2, px: 1.01 },
  HELI: { file: 'heli.glb', rotateY: -Math.PI / 2, px: .59 },
};

function prepareGeometry(scene, config) {
  scene.updateMatrixWorld(true);
  const parts = [];
  scene.traverse(mesh => {
    const source = mesh.geometry;
    if (!mesh.isMesh || !source?.attributes.position || mesh.material?.transparent) return;
    if ((source.index?.count ?? source.attributes.position.count) / 3 <= 2) return;
    const geometry = new THREE.BufferGeometry();
    // Transforming normalized integer GLB attributes in-place truncates and
    // wraps vertices. AirNav explicitly expands these attributes to floats.
    for (const name of ['position', 'normal']) {
      const attribute = source.attributes[name];
      if (!attribute) continue;
      const values = new Float32Array(attribute.count * 3);
      for (let i = 0; i < attribute.count; i++) {
        values.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i)], i * 3);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
    }
    geometry.setIndex(source.index ? source.index.clone() : Array.from({ length: source.attributes.position.count }, (_, i) => i));
    geometry.applyMatrix4(mesh.matrixWorld);
    parts.push(geometry);
  });
  if (!parts.length) throw new Error('No opaque airframe geometry');
  if (!parts.every(g => g.attributes.normal)) parts.forEach(g => g.computeVertexNormals());
  const geometry = mergeGeometries(parts);
  parts.forEach(g => g.dispose());
  geometry.rotateY(config.rotateY);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const length = box.max.z - box.min.z;
  if (!Number.isFinite(length) || length <= 0) throw new Error('Invalid airframe length');
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const outline = geometry.clone();
  const p = outline.attributes.position, n = outline.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + n.getX(i) * length * .03,
      Math.max(0, p.getY(i) + n.getY(i) * length * .03), p.getZ(i) + n.getZ(i) * length * .03);
  }
  p.needsUpdate = true;
  return { geometry, outline, length };
}

export class AircraftModels {
  constructor(items, onChange) {
    this.items = items;
    this.onChange = onChange;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.groups = [];
    this.errors = [];
    this.visible = false;
  }
  async load(map) {
    this.map = map;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const cache = new Map();
    await Promise.all(Object.entries(configs).map(async ([family, config]) => {
      try {
        if (!cache.has(config.file)) cache.set(config.file, loader.loadAsync(`/${config.file}`));
        const gltf = await cache.get(config.file);
        const { geometry, outline, length } = prepareGeometry(gltf.scene, config);
        const bodyMaterial = new THREE.MeshBasicMaterial({
          color: '#ffc803', side: THREE.DoubleSide, depthTest: true, depthWrite: true,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -32,
          stencilWrite: true, stencilRef: 128, stencilFunc: THREE.AlwaysStencilFunc,
          stencilZPass: THREE.ReplaceStencilOp,
        });
        const outlineMaterial = new THREE.MeshBasicMaterial({
          color: '#3b4442', side: THREE.BackSide, depthTest: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -32,
          stencilWrite: true, stencilRef: 128, stencilFunc: THREE.NotEqualStencilFunc,
        });
        for (const item of this.items.filter(a => a.family === family)) {
          const root = new THREE.Group();
          root.matrixAutoUpdate = false;
          const body = new THREE.Mesh(geometry, bodyMaterial);
          const edge = new THREE.Mesh(outline, outlineMaterial);
          body.frustumCulled = edge.frustumCulled = false;
          edge.renderOrder = 1;
          root.add(body, edge);
          this.scene.add(root);
          this.groups.push({ item, root, length, config });
        }
      } catch (error) { this.errors.push(`${family}: ${error.message}`); }
      this.onChange();
      map.triggerRepaint();
    }));
  }
  hasModel(id) { return this.visible && this.groups.some(g => g.item.id === id); }
  setVisible(value) { this.visible = value; }
  render(renderer, gl, args) {
    if (!this.visible || !this.groups.length) return;
    const map = this.map, zoom = map.getZoom();
    const metersPerPixel = 156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** zoom;
    const zoomFactor = 16 / 24 + (1 - 16 / 24) * Math.min(1, Math.max(0, (zoom - 6) / (10.5 - 6)));
    const origin = new THREE.Matrix4().fromArray(map.transform.getMatrixForModel(map.getCenter(), 0));
    const anchor = new THREE.Vector3().setFromMatrixPosition(origin);
    for (const { item, root, length, config } of this.groups) {
      root.matrix.fromArray(map.transform.getMatrixForModel([item.lng, item.lat], item.altitude));
      root.matrix.elements[12] -= anchor.x;
      root.matrix.elements[13] -= anchor.y;
      root.matrix.elements[14] -= anchor.z;
      // marker-lNfsWV9x overrides the layer's default 48 with $o = 24.
      const scale = zoom >= 16 ? 1 : Math.max(1, zoomFactor * 24 * config.px * metersPerPixel / length);
      root.matrix.multiply(new THREE.Matrix4().makeRotationY(-item.heading * Math.PI / 180));
      root.matrix.scale(new THREE.Vector3(scale, scale, scale));
      root.matrixWorldNeedsUpdate = true;
    }
    // Subtract the camera anchor in float64 before sending matrices to the
    // GPU, as AirNav does, to avoid Mercator-coordinate precision noise.
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix)
      .multiply(new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z));
    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.clear(false, false, true);
    renderer.render(this.scene, this.camera);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
  }
}

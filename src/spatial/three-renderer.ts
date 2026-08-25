import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SpatialLayer, SpatialSceneModel, SpatialSceneNode } from "./model";
import type { SpatialSelectionController } from "./selection";

export interface ThreeSpatialOptions {
  host: HTMLElement;
  root: HTMLElement;
  model: SpatialSceneModel;
  selection: SpatialSelectionController;
  onContextLost: () => void;
}

export interface ThreeSpatialRenderer {
  update(model: SpatialSceneModel): void;
  reset(): void;
  dispose(): void;
}

const COLORS: Record<string, number> = {
  shell: 0x91a4b7, interior: 0x6b7d90, chassis: 0x8391a1, deck: 0x667482,
  board: 0x2d9f74, cpu: 0xf0b34c, ram: 0x36a172, m2: 0x9b7be8, psu: 0x5197d5,
  cooler: 0x5ec3c9, radiator: 0x47a3aa, gpu: 0xbd6fe7, hba: 0xd474c6, drive: 0x4e8fcc,
  empty: 0x46515f, boot: 0x8b70dc, fan: 0x55c8b1, pcb: 0x3c9c69, connector: 0xe79055,
  reserve: 0xc6a94a, clearance: 0xe1a83e, conflict: 0xef4c5b, usb: 0x9b7be8,
};
const LAYERS: SpatialLayer[] = ["shell", "structure", "components", "storage", "airflow", "clearance", "conflicts"];

interface PickRecord { object: THREE.Object3D; nodes: SpatialSceneNode[]; }

function materialFor(node: SpatialSceneNode): THREE.MeshStandardMaterial {
  const transparent = node.layer === "shell" || node.layer === "clearance" || node.kind === "empty";
  return new THREE.MeshStandardMaterial({
    color: COLORS[node.kind] ?? 0x8796a5,
    transparent,
    opacity: node.kind === "shell" ? 0.12 : node.kind === "interior" ? 0.025 : node.kind === "empty" ? 0.08 : node.layer === "clearance" ? 0.14 : 0.82,
    depthWrite: !transparent,
    roughness: 0.72,
    metalness: ["chassis", "shell", "psu", "drive"].includes(node.kind) ? 0.35 : 0.08,
    wireframe: node.kind === "interior" || node.kind === "clearance" || node.kind === "reserve",
    side: node.kind === "shell" ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function setTransform(object: THREE.Object3D, node: SpatialSceneNode, explode: boolean): void {
  const distance = explode && node.layer !== "shell" ? 38 : 0;
  object.position.set(
    node.box.c[0] + node.explodedOffset[0] * distance,
    node.box.c[1] + node.explodedOffset[1] * distance,
    node.box.c[2] + node.explodedOffset[2] * distance,
  );
  object.rotation.set(node.rotation[0], node.rotation[1], node.rotation[2]);
  object.scale.set(node.box.w, node.box.h, node.box.d);
}

function groupKey(node: SpatialSceneNode): string {
  return node.repeatGroup ? `${node.repeatGroup}:${node.box.w}:${node.box.h}:${node.box.d}:${node.layer}` : node.id;
}

export function createThreeSpatialRenderer(options: ThreeSpatialOptions): ThreeSpatialRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "可交互 N6 3D 场景；拖动旋转，右键平移，滚轮缩放，点击选择部件");
  options.host.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  const ambient = new THREE.HemisphereLight(0xcde3ff, 0x1b2430, 2.2);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(-260, 400, -300); scene.add(key);
  const fill = new THREE.DirectionalLight(0x7ab4ff, 1.1); fill.position.set(280, 120, 260); scene.add(fill);
  const rootGroup = new THREE.Group(); scene.add(rootGroup);
  const grid = new THREE.GridHelper(620, 20, 0x607080, 0x344252); grid.position.y = -164; scene.add(grid);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickRecords = new Map<string, PickRecord>();
  const visibleLayers = new Set<SpatialLayer>(LAYERS);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let model = options.model;
  let cameraMode: "perspective" | "orthographic" = "perspective";
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  let controls: OrbitControls;
  let explode = false;
  let hovered: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let selected: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let disposed = false;

  const aspect = () => Math.max(1, options.host.clientWidth) / Math.max(1, options.host.clientHeight);
  const makeCamera = () => cameraMode === "perspective"
    ? new THREE.PerspectiveCamera(36, aspect(), 1, 2400)
    : new THREE.OrthographicCamera(-260 * aspect(), 260 * aspect(), 260, -260, 1, 2400);
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  const installControls = () => {
    controls?.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 160;
    controls.maxDistance = 1500;
    controls.addEventListener("change", render);
  };
  camera = makeCamera();
  controls = undefined as unknown as OrbitControls;
  installControls();

  const setView = (view: "iso" | "front" | "side" | "top") => {
    const positions = { iso: [480, 360, -520], front: [0, 0, -720], side: [720, 0, 0], top: [0, 760, 0.001] } as const;
    const position = positions[view];
    camera.position.set(position[0], position[1], position[2]);
    camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
    controls.target.set(0, 0, 0);
    controls.update(); render();
  };

  const updateInstanceMatrices = (mesh: THREE.InstancedMesh, nodes: SpatialSceneNode[]) => {
    const dummy = new THREE.Object3D();
    nodes.forEach((node, index) => {
      setTransform(dummy, node, explode); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  const rebuild = () => {
    pickRecords.clear(); hovered = null; selected = null;
    while (rootGroup.children.length) {
      const object = rootGroup.children.pop()!;
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material?.dispose();
      });
    }
    const groups = new Map<string, SpatialSceneNode[]>();
    model.nodes.filter((node) => visibleLayers.has(node.layer)).forEach((node) => {
      const key = groupKey(node); const current = groups.get(key) ?? []; current.push(node); groups.set(key, current);
    });
    for (const nodes of groups.values()) {
      const first = nodes[0]!;
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      if (first.repeatGroup && nodes.length > 1) {
        const mesh = new THREE.InstancedMesh(geometry, materialFor(first), nodes.length);
        updateInstanceMatrices(mesh, nodes); mesh.name = `instances:${first.repeatGroup}`;
        rootGroup.add(mesh); pickRecords.set(mesh.uuid, { object: mesh, nodes });
      } else {
        const mesh = new THREE.Mesh(geometry, materialFor(first)); setTransform(mesh, first, explode); mesh.name = first.partId;
        rootGroup.add(mesh); pickRecords.set(mesh.uuid, { object: mesh, nodes });
      }
    }
    render();
  };

  const nodeAt = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(rootGroup.children, false).find((candidate) => {
      const record = pickRecords.get(candidate.object.uuid);
      const node = record?.nodes[candidate.instanceId ?? 0];
      return node?.selectable;
    });
    if (!hit) return null;
    const record = pickRecords.get(hit.object.uuid)!;
    return { node: record.nodes[hit.instanceId ?? 0]!, object: hit.object, instanceId: hit.instanceId ?? null };
  };

  const recolor = () => {
    for (const record of pickRecords.values()) {
      const mesh = record.object as THREE.Mesh | THREE.InstancedMesh;
      if (mesh instanceof THREE.InstancedMesh) {
        record.nodes.forEach((node, index) => {
          const active = (selected?.object === mesh && selected.instanceId === index) || (hovered?.object === mesh && hovered.instanceId === index);
          mesh.setColorAt(index, new THREE.Color(active ? 0xffd166 : COLORS[node.kind] ?? 0x8796a5));
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      } else {
        const material = mesh.material as THREE.MeshStandardMaterial;
        const node = record.nodes[0]!;
        material.emissive.set((selected?.object === mesh || hovered?.object === mesh) ? 0x5f4200 : 0x000000);
        material.color.set(COLORS[node.kind] ?? 0x8796a5);
      }
    }
    render();
  };

  const onMove = (event: PointerEvent) => {
    const hit = nodeAt(event);
    hovered = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.hover(hit?.node.partId ?? null);
    renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    recolor();
  };
  const onClick = (event: PointerEvent) => {
    const hit = nodeAt(event);
    selected = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.select(hit?.node.partId ?? null); recolor();
  };
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("click", onClick);
  renderer.domElement.addEventListener("webglcontextlost", (event) => { event.preventDefault(); options.onContextLost(); }, { once: true });

  const resize = () => {
    const width = Math.max(1, options.host.clientWidth); const height = Math.max(1, options.host.clientHeight);
    renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height;
    else { camera.left = -260 * width / height; camera.right = 260 * width / height; }
    camera.updateProjectionMatrix(); render();
  };
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(options.host);

  options.root.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => button.addEventListener("click", () => {
    cameraMode = button.dataset.camera as typeof cameraMode;
    const position = camera.position.clone(); camera = makeCamera(); camera.position.copy(position);
    installControls(); options.root.querySelectorAll("[data-camera]").forEach((item) => item.setAttribute("aria-pressed", String(item === button))); resize();
  }));
  options.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as "iso" | "front" | "side" | "top")));
  options.root.querySelector<HTMLButtonElement>("[data-reset]")?.addEventListener("click", () => setView("iso"));
  options.root.querySelector<HTMLInputElement>("[data-explode]")?.addEventListener("change", (event) => { explode = (event.target as HTMLInputElement).checked; rebuild(); });
  const layerControls = options.root.querySelector<HTMLElement>("[data-layer-controls]")!;
  for (const layer of LAYERS) {
    const label = document.createElement("label"); const input = document.createElement("input");
    input.type = "checkbox"; input.checked = true; input.dataset.layer = layer;
    input.addEventListener("change", () => { if (input.checked) visibleLayers.add(layer); else visibleLayers.delete(layer); rebuild(); });
    label.append(input, ` ${layer}`); layerControls.append(label);
  }
  resize(); rebuild(); setView("iso");

  return {
    update(nextModel) { model = nextModel; options.selection.setModel(model); rebuild(); },
    reset() { setView("iso"); },
    dispose() {
      disposed = true; resizeObserver.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener("pointermove", onMove); renderer.domElement.removeEventListener("click", onClick);
      while (rootGroup.children.length) {
        const object = rootGroup.children.pop()! as THREE.Mesh; object.geometry?.dispose();
        const material = object.material; if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material?.dispose();
      }
      renderer.dispose(); options.host.replaceChildren();
    },
  };
}

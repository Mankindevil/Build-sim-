import type { SpatialSceneModel, SpatialSceneNode } from "./model";
import { sceneNode } from "./model";

export interface SpatialSelectionState {
  hoveredPartId: string | null;
  selectedPartId: string | null;
}

export class SpatialSelectionController {
  private state: SpatialSelectionState = { hoveredPartId: null, selectedPartId: null };

  constructor(private model: SpatialSceneModel, private readonly onSelect?: (node: SpatialSceneNode | null) => void) {}

  getState(): SpatialSelectionState { return { ...this.state }; }

  setModel(model: SpatialSceneModel): void {
    this.model = model;
    if (this.state.hoveredPartId && !sceneNode(model, this.state.hoveredPartId)) this.state.hoveredPartId = null;
    if (this.state.selectedPartId && !sceneNode(model, this.state.selectedPartId)) this.select(null);
  }

  hover(partId: string | null): SpatialSceneNode | null {
    const node = partId ? sceneNode(this.model, partId) : null;
    this.state.hoveredPartId = node?.selectable ? node.partId : null;
    return node?.selectable ? node : null;
  }

  select(partId: string | null, notify = true): SpatialSceneNode | null {
    const node = partId ? sceneNode(this.model, partId) : null;
    const selected = node?.selectable ? node : null;
    this.state.selectedPartId = selected?.partId ?? null;
    if (notify) this.onSelect?.(selected);
    return selected;
  }
}

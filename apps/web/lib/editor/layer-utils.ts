import type { AnyLayer, GroupLayer } from "@/lib/ca/types";

export const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function findById(layers: AnyLayer[], id: string | null | undefined): AnyLayer | undefined {
  if (!id) return undefined;
  for (const l of layers) {
    if (l.id === id) return l;
    if ((l as any).type === 'group') {
      const g = l as GroupLayer;
      const found = findById(g.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function insertIntoGroupInTree(
  layers: AnyLayer[],
  groupId: string,
  node: AnyLayer,
  index?: number
): { inserted: boolean; layers: AnyLayer[] } {
  let inserted = false;
  const next: AnyLayer[] = [];
  for (const l of layers) {
    if (l.id === groupId && l.type === 'group') {
      const g = l as GroupLayer;
      const kids = [...g.children];
      const i = typeof index === 'number' && index >= 0 && index <= kids.length ? index : kids.length;
      kids.splice(i, 0, node);
      next.push({ ...g, children: kids } as AnyLayer);
      inserted = true;
    } else if (l.type === 'group') {
      const g = l as GroupLayer;
      const res = insertIntoGroupInTree(g.children, groupId, node, index);
      if (res.inserted) {
        inserted = true;
        next.push({ ...g, children: res.layers } as AnyLayer);
      } else {
        next.push(l);
      }
    } else {
      next.push(l);
    }
  }
  return { inserted, layers: next };
}

export function cloneLayerDeep(layer: AnyLayer): AnyLayer {
  const newId = genId();
  if (layer.type === 'group') {
    const g = layer as GroupLayer;
    return {
      ...JSON.parse(JSON.stringify({ ...g, id: newId })) as GroupLayer,
      id: newId,
      children: g.children.map(cloneLayerDeep),
      position: { x: (g.position?.x ?? 0) + 10, y: (g.position?.y ?? 0) + 10 },
      name: `${g.name} copy`,
    } as AnyLayer;
  }
  const base = JSON.parse(JSON.stringify({ ...layer })) as AnyLayer;
  (base as any).id = newId;
  (base as any).name = `${layer.name} copy`;
  (base as any).position = { x: (layer as any).position?.x + 10, y: (layer as any).position?.y + 10 };
  return base;
}

export function updateInTree(layers: AnyLayer[], id: string, patch: Partial<AnyLayer>): AnyLayer[] {
  return layers.map((l) => {
    if (l.id === id) return { ...l, ...patch } as AnyLayer;
    if (l.type === "group") {
      const g = l as GroupLayer;
      return { ...g, children: updateInTree(g.children, id, patch) } as AnyLayer;
    }
    return l;
  });
}

export function removeFromTree(layers: AnyLayer[], id: string): { removed: AnyLayer | null; layers: AnyLayer[] } {
  let removed: AnyLayer | null = null;
  const next: AnyLayer[] = [];
  for (const l of layers) {
    if (l.id === id) {
      removed = l;
      continue;
    }
    if (l.type === 'group') {
      const g = l as GroupLayer;
      const res = removeFromTree(g.children, id);
      if (res.removed) removed = res.removed;
      next.push({ ...g, children: res.layers } as AnyLayer);
    } else {
      next.push(l);
    }
  }
  return { removed, layers: next };
}

export function insertBeforeInTree(layers: AnyLayer[], targetId: string, node: AnyLayer): { inserted: boolean; layers: AnyLayer[] } {
  let inserted = false;
  const next: AnyLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!inserted && l.id === targetId) {
      next.push(node);
      next.push(l);
      inserted = true;
    } else if (l.type === 'group') {
      const g = l as GroupLayer;
      const res = insertBeforeInTree(g.children, targetId, node);
      if (res.inserted) {
        inserted = true;
        next.push({ ...g, children: res.layers } as AnyLayer);
      } else {
        next.push(l);
      }
    } else {
      next.push(l);
    }
  }
  return { inserted, layers: next };
}

export function insertAfterInTree(layers: AnyLayer[], targetId: string, node: AnyLayer): { inserted: boolean; layers: AnyLayer[] } {
  let inserted = false;
  const next: AnyLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!inserted && l.id === targetId) {
      next.push(l);
      next.push(node);
      inserted = true;
    } else if (l.type === 'group') {
      const g = l as GroupLayer;
      const res = insertAfterInTree(g.children, targetId, node);
      if (res.inserted) {
        inserted = true;
        next.push({ ...g, children: res.layers } as AnyLayer);
      } else {
        next.push(l);
      }
    } else {
      next.push(l);
    }
  }
  return { inserted, layers: next };
}

export function deleteInTree(layers: AnyLayer[], id: string): AnyLayer[] {
  const next: AnyLayer[] = [];
  for (const l of layers) {
    if (l.id === id) continue;
    if (l.type === "group") {
      const g = l as GroupLayer;
      next.push({ ...g, children: deleteInTree(g.children, id) } as AnyLayer);
    } else {
      next.push(l);
    }
  }
  return next;
}

export function containsId(layers: AnyLayer[], id: string): boolean {
  for (const l of layers) {
    if (l.id === id) return true;
    if (l.type === "group" && containsId((l as GroupLayer).children, id)) return true;
  }
  return false;
}

export function wrapAsGroup(
  layers: AnyLayer[],
  targetId: string,
): { layers: AnyLayer[]; newGroupId: string | null } {
  let newGroupId: string | null = null;

  const wrapNode = (l: AnyLayer): AnyLayer => {
    if (l.id !== targetId) {
      if (l.type === 'group') {
        const g = l as GroupLayer;
        return { ...g, children: g.children.map(wrapNode) } as AnyLayer;
      }
      return l;
    }

    if (l.type === 'group') {
      return l;
    }

    const groupId = genId();
    newGroupId = groupId;

    const container: GroupLayer = {
      id: groupId,
      name: l.name,
      type: 'group',
      position: { ...l.position },
      size: { ...l.size },
      anchorPoint: (l as any).anchorPoint,
      opacity: (l as any).opacity,
      rotation: (l as any).rotation,
      rotationX: (l as any).rotationX,
      rotationY: (l as any).rotationY,
      geometryFlipped: (l as any).geometryFlipped,
      children: [],
    } as any;
    (container as any)._displayType = (l as any).type;

    const child = JSON.parse(JSON.stringify(l)) as AnyLayer;
    (child as any).rotation = 0;
    (child as any).rotationX = undefined;
    (child as any).rotationY = undefined;
    const a = (child as any).anchorPoint;
    if (!a || Math.abs(a.x - 0.5) > 1e-6 || Math.abs(a.y - 0.5) > 1e-6) {
      (child as any).anchorPoint = { x: 0.5, y: 0.5 };
    }
    (child as any).position = { x: container.size.w / 2, y: container.size.h / 2 };

    container.children = [child];
    return container as AnyLayer;
  };

  const next = layers.map(wrapNode);
  return { layers: next, newGroupId };
}

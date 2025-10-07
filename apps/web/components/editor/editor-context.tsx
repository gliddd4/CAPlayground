"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AnyLayer, CAProject, GroupLayer, ImageLayer, LayerBase, ShapeLayer, TextLayer, VideoLayer, GyroParallaxDictionary } from "@/lib/ca/types";
import { serializeCAML } from "@/lib/ca/caml";
import { getProject, listFiles, putBlobFile, putBlobFilesBatch, putTextFile } from "@/lib/storage";
import {
  genId,
  findById,
  cloneLayerDeep,
  updateInTree,
  removeFromTree,
  insertBeforeInTree,
  deleteInTree,
  containsId,
  insertIntoGroupInTree,
  wrapAsGroup,
} from "@/lib/editor/layer-utils";
import { sanitizeFilename, dataURLToBlob } from "@/lib/editor/file-utils";

type CADoc = {
  layers: AnyLayer[];
  selectedId?: string | null;
  assets?: Record<string, { filename: string; dataURL: string }>;
  states: string[];
  stateOverrides?: Record<string, Array<{ targetId: string; keyPath: string; value: string | number }>>;
  activeState?: 'Base State' | 'Locked' | 'Unlock' | 'Sleep';
  wallpaperParallaxGroups?: GyroParallaxDictionary[];
  camlHeaderComments?: string;
};

export type ProjectDocument = {
  meta: Pick<CAProject, "id" | "name" | "width" | "height" | "background" | "geometryFlipped"> & { gyroEnabled?: boolean };
  activeCA: 'background' | 'floating' | 'wallpaper';
  docs: {
    background: CADoc;
    floating: CADoc;
    wallpaper: CADoc;
  };
};

export type EditorContextValue = {
  doc: ProjectDocument | null;
  setDoc: React.Dispatch<React.SetStateAction<ProjectDocument | null>>;
  activeCA: 'background' | 'floating' | 'wallpaper';
  setActiveCA: (v: 'background' | 'floating' | 'wallpaper') => void;
  savingStatus: 'idle' | 'saving' | 'saved';
  lastSavedAt?: number;
  flushPersist: () => Promise<void>;
  addTextLayer: () => void;
  addImageLayer: (src?: string) => void;
  addImageLayerFromFile: (file: File) => Promise<void>;
  addImageLayerFromBlob: (blob: Blob, filename?: string) => Promise<void>;
  replaceImageForLayer: (layerId: string, file: File) => Promise<void>;
  addShapeLayer: (shape?: ShapeLayer["shape"]) => void;
  addGradientLayer: () => void;
  addVideoLayerFromFile: (file: File) => Promise<void>;
  updateLayer: (id: string, patch: Partial<AnyLayer>) => void;
  updateLayerTransient: (id: string, patch: Partial<AnyLayer>) => void;
  selectLayer: (id: string | null) => void;
  deleteLayer: (id: string) => void;
  copySelectedLayer: () => void;
  pasteFromClipboard: (payload?: any) => void;
  duplicateLayer: (id?: string) => void;
  moveLayer: (sourceId: string, beforeId: string | null) => void;
  moveLayerInto: (sourceId: string, targetGroupId: string) => void;
  persist: () => void;
  undo: () => void;
  redo: () => void;
  setActiveState: (state: 'Base State' | 'Locked' | 'Unlock' | 'Sleep') => void;
  updateStateOverride: (targetId: string, keyPath: 'position.x' | 'position.y' | 'opacity', value: number) => void;
  updateStateOverrideTransient: (targetId: string, keyPath: 'position.x' | 'position.y' | 'opacity', value: number) => void;
  isAnimationPlaying: boolean;
  setIsAnimationPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  animatedLayers: AnyLayer[];
  setAnimatedLayers: React.Dispatch<React.SetStateAction<AnyLayer[]>>;
};

const EditorContext = createContext<EditorContextValue | undefined>(undefined);

export function EditorProvider({
  projectId,
  initialMeta,
  children,
}: {
  projectId: string;
  initialMeta: Pick<CAProject, "id" | "name" | "width" | "height"> & { background?: string };
  children: React.ReactNode;
}) {
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [savingStatus, setSavingStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | undefined>(undefined);
  const docRef = useRef<ProjectDocument | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavePromiseRef = useRef<Promise<void> | null>(null);
  const pastRef = useRef<ProjectDocument[]>([]);
  const futureRef = useRef<ProjectDocument[]>([]);
  const skipPersistRef = useRef(false);
  const clipboardRef = useRef<{
    type: 'layers';
    data: AnyLayer[];
    assets?: Record<string, { filename: string; dataURL: string }>;
  } | null>(null);
  const lastAddRef = useRef<{ key: string; ts: number } | null>(null);
  
  const [isAnimationPlaying, setIsAnimationPlaying] = useState(false);
  const [animatedLayers, setAnimatedLayers] = useState<AnyLayer[]>([]);

  const currentKey = doc?.activeCA ?? 'floating';
  const currentDoc: CADoc | null = doc ? doc.docs[currentKey] : null;

  const pushHistory = useCallback((prev: ProjectDocument) => {
    pastRef.current.push(JSON.parse(JSON.stringify(prev)) as ProjectDocument);
    futureRef.current = [];
  }, []);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    if (doc !== null) return;
    const fixedStates = ["Locked", "Unlock", "Sleep"] as const;
    (async () => {
      try {
        const proj = await getProject(projectId);
        const isGyro = proj?.gyroEnabled ?? false;
        const meta = {
          id: initialMeta.id,
          name: proj?.name ?? initialMeta.name,
          width: proj?.width ?? initialMeta.width,
          height: proj?.height ?? initialMeta.height,
          background: initialMeta.background ?? "#e5e7eb",
          geometryFlipped: 0 as 0 | 1,
          gyroEnabled: isGyro,
        };

        let folder = `${(proj?.name || initialMeta.name)}.ca`;
        let floatingFiles: Awaited<ReturnType<typeof listFiles>> = [];
        let backgroundFiles: Awaited<ReturnType<typeof listFiles>> = [];
        let wallpaperFiles: Awaited<ReturnType<typeof listFiles>> = [];
        
        if (isGyro) {
          wallpaperFiles = await listFiles(projectId, `${folder}/Wallpaper.ca/`);
          if (wallpaperFiles.length === 0) {
            const all = await listFiles(projectId);
            const anyMain = all.find(f => /\.ca\/Wallpaper\.ca\/main\.caml$/i.test(f.path));
            if (anyMain) {
              wallpaperFiles = all.filter(f => f.path.startsWith(`${folder}/Wallpaper.ca/`));
            }
          }
        } else {
          [floatingFiles, backgroundFiles] = await Promise.all([
            listFiles(projectId, `${folder}/Floating.ca/`),
            listFiles(projectId, `${folder}/Background.ca/`),
          ]);
          if ((floatingFiles.length + backgroundFiles.length) === 0) {
            const all = await listFiles(projectId);
            const anyMain = all.find(f => /\.ca\/(Floating|Background)\.ca\/main\.caml$/i.test(f.path));
            if (anyMain) {
              [floatingFiles, backgroundFiles] = [
                all.filter(f => f.path.startsWith(`${folder}/Floating.ca/`)),
                all.filter(f => f.path.startsWith(`${folder}/Background.ca/`)),
              ];
            }
          }
        }
        const readDocFromFiles = async (files: Awaited<ReturnType<typeof listFiles>>, caType: 'floating' | 'background' | 'wallpaper'): Promise<CADoc> => {
          const byPath = new Map(files.map((f) => [f.path, f]));
          const caFolder = caType === 'floating' ? 'Floating.ca' : caType === 'wallpaper' ? 'Wallpaper.ca' : 'Background.ca';
          const main = byPath.get(`${folder}/${caFolder}/main.caml`);
          let layers: AnyLayer[] = [];
          let assets: Record<string, { filename: string; dataURL: string }> = {};
          let states: string[] = [...fixedStates];
          let stateOverrides: Record<string, Array<{ targetId: string; keyPath: string; value: string | number }>> = {};
          let wallpaperParallaxGroups: GyroParallaxDictionary[] = [];
          let camlHeaderComments: string | undefined = undefined;
          if (main && main.type === 'text' && typeof main.data === 'string') {
            try {
              const camlContent = main.data as string;
              const xmlDeclMatch = camlContent.match(/^<\?xml[^>]+\?>/);
              const xmlDecl = xmlDeclMatch ? xmlDeclMatch[0] : '';
              const afterXmlDecl = xmlDecl ? camlContent.substring(xmlDecl.length) : camlContent;
              const commentMatch = afterXmlDecl.match(/^\s*(<!--[\s\S]*?-->\s*)/);
              if (commentMatch) {
                camlHeaderComments = commentMatch[1].trim();
              }
              const { parseCAML, parseStates, parseStateOverrides, parseWallpaperParallaxGroups } = await import("@/lib/ca/caml");
              const root = parseCAML(camlContent);
              if (root) {
                const rootLayer = root as any;
                layers = rootLayer?.type === 'group' && Array.isArray(rootLayer.children) ? rootLayer.children : [rootLayer];
                states = parseStates(main.data);
                stateOverrides = parseStateOverrides(main.data) as any;
                if (caType === 'wallpaper') {
                  wallpaperParallaxGroups = parseWallpaperParallaxGroups(main.data);
                }
              }
            } catch {}
          }
          const findAssetBindings = (layers: AnyLayer[], filename: string): string[] => {
            const matches: string[] = [];
            const normalize = (s: string) => {
              try { s = decodeURIComponent(s); } catch {}
              return (s || '').trim().toLowerCase();
            };
            const fileNorm = normalize(filename);
            const walk = (arr: AnyLayer[]) => {
              for (const layer of arr) {
                if (layer.type === "image") {
                  const src = layer.src || "";
                  const name = src.split("/").pop() || "";
                  const nameNorm = normalize(name);
                  const srcNorm = normalize(src);
                  if (nameNorm === fileNorm || srcNorm.includes(fileNorm)) {
                    matches.push(layer.id);
                  }
                } else if (layer.type === "video") {
                  const video = layer as VideoLayer;
                  const prefix = video.framePrefix || `${layer.id}_frame_`;
                  let ext = video.frameExtension || ".jpg";
                  if (!ext.startsWith(".")) ext = `.${ext}`;
                  const pNorm = normalize(prefix);
                  const eNorm = normalize(ext);
                  if (fileNorm.startsWith(pNorm) && fileNorm.endsWith(eNorm)) {
                    const indexPart = filename.slice(prefix.length, filename.length - ext.length);
                    const frameIndex = Number(indexPart);
                    if (!Number.isNaN(frameIndex)) matches.push(`${layer.id}_frame_${frameIndex}`);
                  }
                } else if (layer.type === "group") {
                  walk((layer as GroupLayer).children);
                }
              }
            };
            walk(layers);
            return matches;
          };

          for (const f of files) {
            if (f.path.includes('/assets/')) {
              const filename = f.path.split('/assets/')[1];
              try {
                const buf = f.data as ArrayBuffer;
                const blob = new Blob([buf]);
                const dataURL = await new Promise<string>((resolve) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result));
                  r.readAsDataURL(blob);
                });
                const bindingKeys = findAssetBindings(layers, filename);
                if (bindingKeys.length) {
                  for (const k of bindingKeys) {
                    assets[k] = { filename, dataURL };
                  }
                }
              } catch {}
            }
          }

          // Replace image src with dataURL from assets so runtime <img> loads correctly
          const applyAssetSrc = (arr: AnyLayer[]): AnyLayer[] => arr.map((l) => {
            if (l.type === 'image') {
              const a = assets[l.id];
              if (a && a.dataURL) {
                return { ...l, src: a.dataURL } as AnyLayer;
              }
              return l;
            }
            if ((l as any).type === 'group') {
              const g = l as GroupLayer;
              return { ...g, children: applyAssetSrc(g.children) } as AnyLayer;
            }
            return l;
          });

          layers = applyAssetSrc(layers);
          return {
            layers,
            selectedId: null,
            assets,
            states: states.length ? states : [...fixedStates],
            activeState: 'Base State',
            stateOverrides,
            wallpaperParallaxGroups,
            camlHeaderComments,
          };
        };

        const emptyDoc: CADoc = { layers: [], selectedId: null, assets: {}, states: [...fixedStates], activeState: 'Base State', stateOverrides: {} };
        
        let floatingDoc: CADoc, backgroundDoc: CADoc, wallpaperDoc: CADoc;
        if (isGyro) {
          wallpaperDoc = await readDocFromFiles(wallpaperFiles, 'wallpaper');
          floatingDoc = emptyDoc;
          backgroundDoc = emptyDoc;
        } else {
          floatingDoc = await readDocFromFiles(floatingFiles, 'floating');
          backgroundDoc = await readDocFromFiles(backgroundFiles, 'background');
          wallpaperDoc = emptyDoc;
        }

        const initial: ProjectDocument = {
          meta,
          activeCA: isGyro ? 'wallpaper' : 'floating',
          docs: { background: backgroundDoc, floating: floatingDoc, wallpaper: wallpaperDoc },
        };
        skipPersistRef.current = true;
        setDoc(initial);
      } catch {
        skipPersistRef.current = true;
        const emptyDoc: CADoc = { layers: [], selectedId: null, assets: {}, states: ["Locked", "Unlock", "Sleep"], activeState: 'Base State', stateOverrides: {} };
        setDoc({
          meta: {
            id: initialMeta.id,
            name: initialMeta.name,
            width: initialMeta.width,
            height: initialMeta.height,
            background: initialMeta.background ?? "#e5e7eb",
            geometryFlipped: 0,
            gyroEnabled: false,
          },
          activeCA: 'floating',
          docs: {
            background: emptyDoc,
            floating: emptyDoc,
            wallpaper: emptyDoc,
          },
        });
      }
    })();
  }, [doc, projectId, initialMeta.id, initialMeta.name, initialMeta.width, initialMeta.height, initialMeta.background]);

  const doSave = useCallback((snapshot?: ProjectDocument): Promise<void> => {
    const snap = snapshot ?? docRef.current;
    if (!snap) return Promise.resolve();
    setSavingStatus('saving');
    const p = writeToIndexedDB(snap)
      .then(() => {
        setSavingStatus('saved');
        setLastSavedAt(Date.now());
      })
      .catch(() => {
      });
    lastSavePromiseRef.current = p;
    return p;
  }, [writeToIndexedDB]);

  const flushPersist = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  const persist = useCallback(() => {
    if (!docRef.current) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSavingStatus('saving');
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      doSave();
    }, 500);
  }, [doSave]);

  useEffect(() => {
    if (!doc) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    persist();
  }, [doc, persist]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        flushPersist();
      }
    };
    const onPageHide = () => {
      flushPersist();
    };
    window.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flushPersist]);

  const writeToIndexedDB = useCallback(async (snapshot: ProjectDocument) => {
    try {
      const folder = `${snapshot.meta.name}.ca`;
      const prefix = `${folder}/`;
      const isGyro = snapshot.meta.gyroEnabled ?? false;
      const caKeys: Array<'background' | 'floating' | 'wallpaper'> = isGyro ? ['wallpaper'] : ['background', 'floating'];
      for (const key of caKeys) {
        const caFolder = key === 'floating' ? 'Floating.ca' : key === 'wallpaper' ? 'Wallpaper.ca' : 'Background.ca';
        const caDoc = snapshot.docs[key];
        const toCamlLayers = (layers: AnyLayer[], assetsMap: CADoc["assets"] | undefined): AnyLayer[] => {
          const mapOne = (l: AnyLayer): AnyLayer => {
            if (l.type === 'image') {
              const asset = assetsMap ? assetsMap[l.id] : undefined;
              if (asset && asset.filename) {
                return { ...l, src: `assets/${asset.filename}` } as AnyLayer;
              }
              return l;
            }
            if (l.type === 'group') {
              const g = l as GroupLayer;
              return { ...g, children: g.children.map(mapOne) } as AnyLayer;
            }
            return l;
          };
          return layers.map(mapOne);
        };
        
        const rootBase = {
          id: snapshot.meta.id,
          name: 'Root Layer',
          type: 'group',
          position: { x: Math.round((snapshot.meta.width || 0) / 2), y: Math.round((snapshot.meta.height || 0) / 2) },
          size: { w: snapshot.meta.width || 0, h: snapshot.meta.height || 0 },
          geometryFlipped: (snapshot.meta as any).geometryFlipped ?? 0,
          children: toCamlLayers((caDoc.layers as AnyLayer[]) || [], caDoc.assets),
        };
        
        const root: GroupLayer = key === 'floating' 
          ? rootBase as GroupLayer
          : { ...rootBase, backgroundColor: snapshot.meta.background } as GroupLayer;

        let caml = serializeCAML(
          root,
          {
            id: snapshot.meta.id,
            name: snapshot.meta.name,
            width: snapshot.meta.width,
            height: snapshot.meta.height,
            background: snapshot.meta.background,
            geometryFlipped: (snapshot.meta as any).geometryFlipped ?? 0,
          } as any,
          (caDoc as any).states,
          (caDoc as any).stateOverrides,
          undefined,
          caDoc.wallpaperParallaxGroups,
        );
        if (caDoc.camlHeaderComments) {
          caml = caml.replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>\n${caDoc.camlHeaderComments}`);
        }
        await putTextFile(projectId, `${prefix}${caFolder}/main.caml`, caml);
        const indexXml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>rootDocument</key>\n  <string>main.caml</string>\n</dict>\n</plist>`;
        await putTextFile(projectId, `${prefix}${caFolder}/index.xml`, indexXml);
        const assetManifest = `<?xml version="1.0" encoding="UTF-8"?>\n\n<caml xmlns="http://www.apple.com/CoreAnimation/1.0">\n  <MicaAssetManifest>\n    <modules type="NSArray"/>\n  </MicaAssetManifest>\n</caml>`;
        await putTextFile(projectId, `${prefix}${caFolder}/assetManifest.caml`, assetManifest);

        const assets = caDoc.assets || {};
        const assetFiles: Array<{ path: string; data: Blob }> = [];
        
        for (const [assetId, info] of Object.entries(assets)) {
          try {
            const dataURL = info.dataURL;
            const blob = await dataURLToBlob(dataURL);
            const assetPath = `${prefix}${caFolder}/assets/${info.filename}`;
            assetFiles.push({ path: assetPath, data: blob });
          } catch (err) {
            console.error('Failed to prepare asset:', info.filename, err);
          }
        }
        
        if (assetFiles.length > 0) {
          try {
            await putBlobFilesBatch(projectId, assetFiles);
          } catch (err) {
            console.error('Failed to write assets batch:', err);
          }
        }
      }
    } catch (e) {
    }
  }, [projectId]);

  const selectLayer = useCallback((id: string | null) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const nextDocs = { ...prev.docs, [key]: { ...prev.docs[key], selectedId: id } };
      pushHistory(prev);
      return { ...prev, docs: nextDocs } as ProjectDocument;
    });
  }, [pushHistory]);

  const moveLayerInto = useCallback((sourceId: string, targetGroupId: string) => {
    if (!sourceId || !targetGroupId || sourceId === targetGroupId) return;
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const removedRes = removeFromTree(cur.layers, sourceId);
      const node = removedRes.removed;
      if (!node) return prev;
      const ins = insertIntoGroupInTree(removedRes.layers, targetGroupId, node);
      const nextLayers = ins.layers;
      pushHistory(prev);
      const nextCur = { ...cur, layers: nextLayers } as any;
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as any;
    });
  }, [pushHistory]);

  const addBase = useCallback((name: string): LayerBase => ({
    id: genId(),
    name,
    position: { x: 50, y: 50 },
    size: { w: 120, h: 40 },
    rotation: 0,
    visible: true,
  }), []);

  const addTextLayer = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const layer: TextLayer = {
        ...addBase("Text Layer"),
        type: "text",
        position: { x: canvasW / 2, y: canvasH / 2 },
        text: "Text Layer",
        color: "#111827",
        fontSize: 16,
        align: "left",
        fontFamily: "SFProText-Regular",
        wrapped: 1,
      };
      const key = prev.activeCA;
      const cur = prev.docs[key];
      let nextLayers: AnyLayer[] = cur.layers;
      const selId = cur.selectedId || null;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase]);

  const addImageLayerFromBlob = useCallback(async (blob: Blob, filename?: string) => {
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    
    const { width: imgW, height: imgH } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = reject;
      img.src = dataURL;
    });
    
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const aspectRatio = imgW / imgH;
      let w = imgW;
      let h = imgH;
      
      if (w > canvasW || h > canvasH) {
        const scaleW = canvasW / imgW;
        const scaleH = canvasH / imgH;
        const scale = Math.min(scaleW, scaleH);
        w = imgW * scale;
        h = imgH * scale;
      }
      
      const x = canvasW / 2;
      const y = canvasH / 2;
      
      const layer: ImageLayer = {
        ...addBase(filename || "Pasted Image"),
        type: "image",
        position: { x, y },
        size: { w, h },
        src: dataURL,
        fit: "fill",
      };
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const assets = { ...(cur.assets || {}) };
      assets[layer.id] = { filename: sanitizeFilename(filename || `pasted-${Date.now()}.png`), dataURL };
      let nextLayers: AnyLayer[] = cur.layers;
      const selId = cur.selectedId || null;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id, assets };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase]);

  const replaceImageForLayer = useCallback(async (layerId: string, file: File) => {
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    // Eagerly write asset to storage
    try {
      const caFolder = (currentKey === 'floating') ? 'Floating.ca' : (currentKey === 'wallpaper') ? 'Wallpaper.ca' : 'Background.ca';
      const projName = doc?.meta.name || initialMeta.name;
      const folder = `${projName}.ca`;
      const safe = sanitizeFilename(file.name) || `image-${Date.now()}.png`;
      await putBlobFile(projectId, `${folder}/${caFolder}/assets/${safe}`, file);
    } catch {}

    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      const filename = sanitizeFilename(file.name) || `image-${Date.now()}.png`;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const assets = { ...(cur.assets || {}) };
      assets[layerId] = { filename, dataURL };
      const updateRec = (layers: AnyLayer[]): AnyLayer[] =>
        layers.map((l) => {
          if (l.id === layerId && l.type === "image") {
            return { ...l, src: dataURL } as AnyLayer;
          }
          if (l.type === "group") {
            return { ...(l as GroupLayer), children: updateRec((l as GroupLayer).children) } as AnyLayer;
          }
          return l;
        });
      const next = { ...cur, assets, layers: updateRec(cur.layers) };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, []);

  const addImageLayer = useCallback((src?: string) => {
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      const layer: ImageLayer = {
        ...addBase("Image Layer"),
        type: "image",
        size: { w: 200, h: 120 },
        src: src ?? "https://placehold.co/200x120/png",
        fit: "fill",
      };
      const key = prev.activeCA;
      const cur = prev.docs[key];
      let nextLayers: AnyLayer[] = cur.layers;
      const selId = cur.selectedId || null;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase]);

  const addImageLayerFromFile = useCallback(async (file: File) => {
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    
    const { width: imgW, height: imgH } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = reject;
      img.src = dataURL;
    });
    
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const aspectRatio = imgW / imgH;
      let w = imgW;
      let h = imgH;
      
      if (w > canvasW || h > canvasH) {
        const scaleW = canvasW / imgW;
        const scaleH = canvasH / imgH;
        const scale = Math.min(scaleW, scaleH);
        w = imgW * scale;
        h = imgH * scale;
      }
      
      const x = canvasW / 2;
      const y = canvasH / 2;
      
      const layer: ImageLayer = {
        ...addBase(file.name || "Image Layer"),
        type: "image",
        position: { x, y },
        size: { w, h },
        src: dataURL,
        fit: "fill",
      };
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const assets = { ...(cur.assets || {}) };
      assets[layer.id] = { filename: sanitizeFilename(file.name) || `image-${Date.now()}.png`, dataURL };
      let nextLayers: AnyLayer[] = cur.layers;
      const selId = cur.selectedId || null;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id, assets };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase]);

  const addGradientLayer = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const selId = cur.selectedId || null;
      const sig = `gradient:${selId || '__root__'}`;
      const now = Date.now();
      if (lastAddRef.current && lastAddRef.current.key === sig && (now - lastAddRef.current.ts) < 400) {
        return prev;
      }
      lastAddRef.current = { key: sig, ts: now };
      pushHistory(prev);
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const layer: any = {
        ...addBase("Gradient Layer"),
        type: "gradient",
        position: { x: canvasW / 2, y: canvasH / 2 },
        size: { w: 200, h: 200 },
        gradientType: "axial",
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 1, y: 1 },
        colors: [
          { color: "#ffffff", opacity: 1 },
          { color: "#000000", opacity: 1 },
        ],
      };
      let nextLayers: AnyLayer[] = cur.layers;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const insertInto = (arr: AnyLayer[]): AnyLayer[] => arr.map((l) => {
          if (l.id === selId && (l as any).type === 'group') {
            return { ...l, children: [...(l as any).children, layer] } as AnyLayer;
          }
          if ((l as any).type === 'group') {
            return { ...l, children: insertInto((l as any).children) } as AnyLayer;
          }
          return l;
        });
        nextLayers = insertInto(cur.layers);
      }
      return {
        ...prev,
        docs: {
          ...prev.docs,
          [key]: { ...cur, layers: nextLayers, selectedId: layer.id },
        },
      };
    });
  }, [addBase]);

  const addShapeLayer = useCallback((shape: ShapeLayer["shape"] = "rect") => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const selId = cur.selectedId || null;
      const sig = `shape:${shape}:${selId || '__root__'}`;
      const now = Date.now();
      if (lastAddRef.current && lastAddRef.current.key === sig && (now - lastAddRef.current.ts) < 400) {
        return prev;
      }
      lastAddRef.current = { key: sig, ts: now };
      pushHistory(prev);
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const layer: ShapeLayer = {
        ...addBase("Shape Layer"),
        type: "shape",
        position: { x: canvasW / 2, y: canvasH / 2 },
        size: { w: 120, h: 120 },
        shape,
        fill: "#60a5fa",
        backgroundColor: "#60a5fa",
        backgroundOpacity: 1,
        radius: shape === "rounded-rect" ? 8 : undefined,
      };
      let nextLayers: AnyLayer[] = cur.layers;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase]);

  const addVideoLayerFromFile = useCallback(async (file: File) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    const videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = reject;
    });
    
    const duration = video.duration;
    const fps = 30;
    const maxDuration = 12;
    const actualDuration = Math.min(duration, maxDuration);
    const frameCount = Math.floor(actualDuration * fps);
    
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      URL.revokeObjectURL(videoURL);
      throw new Error('Failed to get canvas context');
    }
    
    const layerId = genId();
    const rawName = file.name && typeof file.name === 'string' ? file.name : 'Video Layer';
    const nameSansExt = rawName.replace(/\.[a-z0-9]+$/i, '');
    const safeName = sanitizeFilename(nameSansExt) || 'Video_Layer';
    const framePrefix = `${safeName}_`;
    const frameExtension = '.jpg';
    const frameAssets: Array<{ dataURL: string; filename: string }> = [];
    
    for (let i = 0; i < frameCount; i++) {
      const time = (i / fps);
      video.currentTime = time;
      
      await new Promise<void>((resolve) => {
        video.onseeked = () => {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataURL = canvas.toDataURL('image/jpeg', 0.7);
          const filename = `${framePrefix}${i}${frameExtension}`;
          frameAssets.push({ dataURL, filename });
          resolve();
        };
      });
    }
    
    URL.revokeObjectURL(videoURL);
    
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      
      const canvasW = prev.meta.width || 390;
      const canvasH = prev.meta.height || 844;
      const videoW = video.videoWidth;
      const videoH = video.videoHeight;
      
      let w = videoW;
      let h = videoH;
      
      if (w > canvasW || h > canvasH) {
        const scaleW = canvasW / videoW;
        const scaleH = canvasH / videoH;
        const scale = Math.min(scaleW, scaleH);
        w = videoW * scale;
        h = videoH * scale;
      }
      
      const x = canvasW / 2;
      const y = canvasH / 2;
      
      const layer: VideoLayer = {
        ...addBase(file.name || "Video Layer"),
        id: layerId,
        type: "video",
        position: { x, y },
        size: { w, h },
        frameCount,
        fps,
        duration: actualDuration,
        autoReverses: false,
        framePrefix,
        frameExtension,
      };
      
      const key = prev.activeCA;
      const cur = prev.docs[key];
      
      const assets = { ...(cur.assets || {}) };
      frameAssets.forEach((frame, idx) => {
        const frameId = `${layer.id}_frame_${idx}`;
        assets[frameId] = { 
          filename: `${framePrefix}${idx}${frameExtension}`, 
          dataURL: frame.dataURL 
        };
      });
      
      let nextLayers: AnyLayer[] = cur.layers;
      const selId = cur.selectedId || null;
      if (!selId || selId === '__root__') {
        nextLayers = [...cur.layers, layer];
      } else {
        const target = findById(cur.layers, selId);
        if (target && (target as any).type === 'group') {
          nextLayers = insertIntoGroupInTree(cur.layers, selId, layer).layers;
        } else if (target) {
          const wrapped = wrapAsGroup(cur.layers, selId);
          const groupId = wrapped.newGroupId || selId;
          nextLayers = insertIntoGroupInTree(wrapped.layers, groupId, layer).layers;
        } else {
          nextLayers = [...cur.layers, layer];
        }
      }
      const next = { ...cur, layers: nextLayers, selectedId: layer.id, assets };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [addBase, pushHistory]);

  const moveLayer = useCallback((sourceId: string, beforeId: string | null) => {
    if (!sourceId || sourceId === beforeId) return;
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const removedRes = removeFromTree(cur.layers, sourceId);
      const node = removedRes.removed;
      if (!node) return prev;
      let nextLayers: AnyLayer[] = removedRes.layers;
      if (beforeId) {
        const ins = insertBeforeInTree(nextLayers, beforeId, node);
        nextLayers = ins.layers;
        if (!ins.inserted) {
          nextLayers = [...nextLayers, node];
        }
      } else {
        nextLayers = [...nextLayers, node];
      }
      pushHistory(prev);
      const nextCur = { ...cur, layers: nextLayers } as CADoc;
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, [pushHistory]);

  const updateLayer = useCallback((id: string, patch: Partial<AnyLayer>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      if (cur.activeState && cur.activeState !== 'Base State') {
        const p: any = patch;
        const nextState = { ...(cur.stateOverrides || {}) } as Record<string, Array<{ targetId: string; keyPath: string; value: number | string }>>;
        const list = [...(nextState[cur.activeState] || [])];
        const upd = (keyPath: 'position.x' | 'position.y' | 'opacity' | 'bounds.size.width' | 'bounds.size.height' | 'transform.rotation.z', value: number) => {
          const idx = list.findIndex((o) => o.targetId === id && o.keyPath === keyPath);
          if (idx >= 0) list[idx] = { ...list[idx], value };
          else list.push({ targetId: id, keyPath, value });
        };
        if (p.position && typeof p.position.x === 'number') upd('position.x', p.position.x);
        if (p.position && typeof p.position.y === 'number') upd('position.y', p.position.y);
        if (p.size && typeof p.size.w === 'number') upd('bounds.size.width', p.size.w);
        if (p.size && typeof p.size.h === 'number') upd('bounds.size.height', p.size.h);
        if (typeof p.rotation === 'number') upd('transform.rotation.z', p.rotation as number);
        if (typeof p.opacity === 'number') upd('opacity', p.opacity as number);
        nextState[cur.activeState] = list;
        pushHistory(prev);
        const nextCur = { ...cur, stateOverrides: nextState } as CADoc;
        return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
      }
      pushHistory(prev);
      const nextLayers = updateInTree(cur.layers, id, patch);
      const nextCur = { ...cur, layers: nextLayers };
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, [pushHistory]);

  const updateLayerTransient = useCallback((id: string, patch: Partial<AnyLayer>) => {
    skipPersistRef.current = true;
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      if (cur.activeState && cur.activeState !== 'Base State') {
        const p: any = patch;
        const nextState = { ...(cur.stateOverrides || {}) } as Record<string, Array<{ targetId: string; keyPath: string; value: number | string }>>;
        const list = [...(nextState[cur.activeState] || [])];
        const upd = (keyPath: 'position.x' | 'position.y' | 'opacity' | 'bounds.size.width' | 'bounds.size.height' | 'transform.rotation.z', value: number) => {
          const idx = list.findIndex((o) => o.targetId === id && o.keyPath === keyPath);
          if (idx >= 0) list[idx] = { ...list[idx], value };
          else list.push({ targetId: id, keyPath, value });
        };
        if (p.position && typeof p.position.x === 'number') upd('position.x', p.position.x);
        if (p.position && typeof p.position.y === 'number') upd('position.y', p.position.y);
        if (p.size && typeof p.size.w === 'number') upd('bounds.size.width', p.size.w);
        if (p.size && typeof p.size.h === 'number') upd('bounds.size.height', p.size.h);
        if (typeof p.rotation === 'number') upd('transform.rotation.z', p.rotation as number);
        if (typeof p.opacity === 'number') upd('opacity', p.opacity as number);
        nextState[cur.activeState] = list;
        const nextCur = { ...cur, stateOverrides: nextState } as CADoc;
        return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
      }
      const nextLayers = updateInTree(cur.layers, id, patch);
      const nextCur = { ...cur, layers: nextLayers };
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, []);

  const deleteLayer = useCallback((id: string) => {
    setDoc((prev) => {
      if (!prev) return prev;
      pushHistory(prev);
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const nextLayers = deleteInTree(cur.layers, id);
      const nextSelected = cur.selectedId === id || (cur.selectedId ? !containsId(nextLayers, cur.selectedId) : false) ? null : cur.selectedId;
      const nextCur = { ...cur, layers: nextLayers, selectedId: nextSelected };
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, [pushHistory]);

  const copySelectedLayer = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      const cur = prev.docs[prev.activeCA];
      const sel = findById(cur.layers, cur.selectedId ?? null);
      if (!sel) return prev;
      const images: Record<string, { filename: string; dataURL: string }> = {};
      const walk = (l: AnyLayer) => {
        if (l.type === 'image') {
          const a = (cur.assets || {})[l.id];
          if (a) images[l.id] = { ...a };
        } else if (l.type === 'group') {
          (l as GroupLayer).children.forEach(walk);
        }
      };
      walk(sel);
      clipboardRef.current = { type: 'layers', data: [JSON.parse(JSON.stringify(sel)) as AnyLayer], assets: images };
      try {
        navigator.clipboard?.writeText?.(JSON.stringify({ __caplay__: true, type: 'layers', data: clipboardRef.current.data, assets: clipboardRef.current.assets }));
      } catch {}
      return prev;
    });
  }, []);

  const pasteFromClipboard = useCallback((payload?: any) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const src = payload && payload.__caplay__ ? payload : clipboardRef.current;
      if (!src || src.type !== 'layers') return prev;
      const cloned: AnyLayer[] = (src.data || []).map(cloneLayerDeep);
      const idMap = new Map<string, string>();
      const collectMap = (orig: AnyLayer[], copies: AnyLayer[]) => {
        for (let i = 0; i < orig.length; i++) {
          const o = orig[i];
          const c = copies[i];
          if (o && c) {
            idMap.set((o as any).id, (c as any).id);
            if (o.type === 'group' && c.type === 'group') {
              collectMap((o as GroupLayer).children, (c as GroupLayer).children);
            }
          }
        }
      };
      collectMap(src.data as AnyLayer[], cloned);
      const assets = { ...(cur.assets || {}) };
      const srcAssets = ((src as any).assets || {}) as Record<string, { filename: string; dataURL: string }>;
      for (const [oldId, asset] of Object.entries(srcAssets) as Array<[string, { filename: string; dataURL: string }]>) {
        const newId = idMap.get(oldId);
        if (newId) assets[newId] = { filename: asset.filename, dataURL: asset.dataURL };
      }
      pushHistory(prev);
      const next = { ...cur, layers: [...cur.layers, ...cloned], selectedId: cloned[cloned.length - 1]?.id ?? cur.selectedId, assets };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [pushHistory]);

  const duplicateLayer = useCallback((id?: string) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const targetId = id || cur.selectedId || null;
      if (!targetId) return prev;
      const sel = findById(cur.layers, targetId);
      if (!sel) return prev;
      const images: Record<string, { filename: string; dataURL: string }> = {};
      const walk = (l: AnyLayer) => {
        if (l.type === 'image') {
          const a = (cur.assets || {})[l.id];
          if (a) images[l.id] = { ...a };
        } else if (l.type === 'group') {
          (l as GroupLayer).children.forEach(walk);
        }
      };
      walk(sel);
      const cloned = cloneLayerDeep(sel);
      const assets = { ...(cur.assets || {}) };
      const idMap = new Map<string, string>();
      const buildMap = (o: AnyLayer, c: AnyLayer) => {
        idMap.set((o as any).id, (c as any).id);
        if (o.type === 'group' && c.type === 'group') {
          const oc = (o as GroupLayer).children;
          const cc = (c as GroupLayer).children;
          for (let i = 0; i < oc.length; i++) buildMap(oc[i], cc[i]);
        }
      };
      buildMap(sel, cloned);
      for (const [oldId, asset] of Object.entries(images)) {
        const newId = idMap.get(oldId);
        if (newId) assets[newId] = { filename: asset.filename, dataURL: asset.dataURL };
      }
      pushHistory(prev);
      const next = { ...cur, layers: [...cur.layers, cloned], selectedId: (cloned as any).id, assets };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, [pushHistory]);

  const undo = useCallback(() => {
    setDoc((current) => {
      if (!current) return current;
      const past = pastRef.current;
      if (past.length === 0) return current;
      const previous = past.pop() as ProjectDocument;
      futureRef.current.push(current);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setDoc((current) => {
      if (!current) return current;
      const future = futureRef.current;
      if (future.length === 0) return current;
      const next = future.pop() as ProjectDocument;
      pastRef.current.push(current);
      return next;
    });
  }, []);

  const setActiveState = useCallback((state: 'Base State' | 'Locked' | 'Unlock' | 'Sleep') => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const next = { ...cur, activeState: state };
      return { ...prev, docs: { ...prev.docs, [key]: next } } as ProjectDocument;
    });
  }, []);

  const updateStateOverride = useCallback((targetId: string, keyPath: 'position.x' | 'position.y' | 'opacity', value: number) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const state = cur.activeState && cur.activeState !== 'Base State' ? cur.activeState : null;
      if (!state) return prev;
      const next = { ...(cur.stateOverrides || {}) } as Record<string, Array<{ targetId: string; keyPath: string; value: number | string }>>;
      const list = [...(next[state] || [])];
      const idx = list.findIndex((o) => o.targetId === targetId && o.keyPath === keyPath);
      if (idx >= 0) list[idx] = { ...list[idx], value };
      else list.push({ targetId, keyPath, value });
      next[state] = list;
      pushHistory(prev);
      const nextCur = { ...cur, stateOverrides: next } as CADoc;
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, [pushHistory]);

  const updateStateOverrideTransient = useCallback((targetId: string, keyPath: 'position.x' | 'position.y' | 'opacity', value: number) => {
    skipPersistRef.current = true;
    setDoc((prev) => {
      if (!prev) return prev;
      const key = prev.activeCA;
      const cur = prev.docs[key];
      const state = cur.activeState && cur.activeState !== 'Base State' ? cur.activeState : null;
      if (!state) return prev;
      const next = { ...(cur.stateOverrides || {}) } as Record<string, Array<{ targetId: string; keyPath: string; value: number | string }>>;
      const list = [...(next[state] || [])];
      const idx = list.findIndex((o) => o.targetId === targetId && o.keyPath === keyPath);
      if (idx >= 0) list[idx] = { ...list[idx], value };
      else list.push({ targetId, keyPath, value });
      next[state] = list;
      const nextCur = { ...cur, stateOverrides: next } as CADoc;
      return { ...prev, docs: { ...prev.docs, [key]: nextCur } } as ProjectDocument;
    });
  }, []);

  const value = useMemo<EditorContextValue>(() => ({
    doc,
    setDoc,
    activeCA: doc?.activeCA ?? 'floating',
    setActiveCA: (v) => setDoc((prev) => (prev ? { ...prev, activeCA: v } : prev)),
    savingStatus,
    lastSavedAt,
    flushPersist,
    addTextLayer,
    addImageLayer,
    addImageLayerFromFile,
    addImageLayerFromBlob,
    replaceImageForLayer,
    addShapeLayer,
    addGradientLayer,
    addVideoLayerFromFile,
    updateLayer,
    updateLayerTransient,
    selectLayer,
    deleteLayer,
    copySelectedLayer,
    pasteFromClipboard,
    duplicateLayer,
    moveLayer,
    moveLayerInto,
    persist,
    undo,
    redo,
    setActiveState,
    updateStateOverride,
    updateStateOverrideTransient,
    isAnimationPlaying,
    setIsAnimationPlaying,
    animatedLayers,
    setAnimatedLayers,
  }), [
    doc,
    setDoc,
    savingStatus,
    lastSavedAt,
    flushPersist,
    addTextLayer,
    addImageLayer,
    addImageLayerFromFile,
    addImageLayerFromBlob,
    replaceImageForLayer,
    addShapeLayer,
    addGradientLayer,
    addVideoLayerFromFile,
    updateLayer,
    updateLayerTransient,
    selectLayer,
    deleteLayer,
    copySelectedLayer,
    pasteFromClipboard,
    duplicateLayer,
    moveLayer,
    persist,
    undo,
    redo,
    setActiveState,
    updateStateOverride,
    updateStateOverrideTransient,
    isAnimationPlaying,
    setIsAnimationPlaying,
    animatedLayers,
    setAnimatedLayers,
  ]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorProvider");
  return ctx;
}

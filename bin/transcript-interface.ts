import type { TreeComponent } from "../ui/types.js";

type Render = TreeComponent["render"];

function replaceRender(component: TreeComponent, render: Render) {
  const own = Object.getOwnPropertyDescriptor(component, "render");
  component.render = render;
  return () => {
    if (component.render !== render) return;
    if (own) Object.defineProperty(component, "render", own);
    else Reflect.deleteProperty(component, "render");
  };
}

/**
 * Pi's document is a native Container, opaque to its layout's frame cache.
 * Share sibling measurements with that Container's real render/mouse layout.
 * Nothing survives the synchronous document render: streaming, resize, theme
 * changes and tool expansion need no cross-frame cache invalidation protocol.
 */
export function shareTranscriptFrame(document: TreeComponent) {
  const native = document.render;
  return replaceRender(document, function (this: TreeComponent, width) {
    const restore: (() => void)[] = [];
    try {
      for (const child of new Set(document.children ?? [])) {
        const render = child.render;
        const linesByWidth = new Map<number, string[]>();
        restore.push(replaceRender(child, function (this: TreeComponent, childWidth) {
          let lines = linesByWidth.get(childWidth);
          if (lines === undefined) {
            lines = render.call(this, childWidth);
            linesByWidth.set(childWidth, lines);
          }
          return lines;
        }));
      }
      return native.call(this, width);
    } finally {
      for (const reset of restore.reverse()) reset();
    }
  });
}

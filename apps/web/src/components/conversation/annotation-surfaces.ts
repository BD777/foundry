import { anchorStillMatches, type AnnotationAnchor } from "./annotations";

/**
 * A place that shows (part of) an answer's text: the answer itself, or a copy
 * of one of its tables in the expanded view. Annotations always use the
 * answer's offsets; a surface maps them to and from its own DOM.
 */
export interface AnnotationSurface {
  /** The answer's plain text, which offsets count. */
  text(): string;
  /** The surface's range for an anchor, if the surface shows that text. */
  rangeFor(anchor: AnnotationAnchor): Range | null;
  /** The answer offsets of a range inside the surface, if it maps to them. */
  offsetsFor(range: Range): { start: number; end: number } | null;
}

/** Offset of a DOM point in the element's text, counted like textContent. */
function textOffset(element: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * The DOM point at a text offset of the element. An offset between two text
 * nodes belongs to the next one when it starts a range ("start") and to the
 * previous one when it ends a range ("end"), so a range never begins at the
 * end of the text before it (e.g. in a table that precedes the passage).
 */
function textPoint(
  element: Node,
  offset: number,
  side: "start" | "end" = "end",
): { node: Node; offset: number } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let position = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    const inside =
      side === "start"
        ? offset < position + length
        : offset <= position + length;
    if (inside) return { node, offset: offset - position };
    position += length;
  }
  return { node: element, offset: element.childNodes.length };
}

/** The DOM range covering text offsets [start, end) of the root. */
function rangeAt(root: Node, start: number, end: number): Range | null {
  const length = root.textContent?.length ?? 0;
  if (start > end || end > length) return null;
  const from = textPoint(root, start, "start");
  const to = textPoint(root, end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export function answerSurface(root: HTMLElement): AnnotationSurface {
  return {
    text: () => root.textContent ?? "",
    rangeFor: (anchor) =>
      anchorStillMatches(root.textContent ?? "", anchor)
        ? rangeAt(root, anchor.start, anchor.end)
        : null,
    offsetsFor: (range) =>
      root.contains(range.commonAncestorContainer)
        ? {
            start: textOffset(root, range.startContainer, range.startOffset),
            end: textOffset(root, range.endContainer, range.endOffset),
          }
        : null,
  };
}

/** Whether the range takes in any of the element: it starts or ends inside
 *  it, or starts before it and ends after it. Ranges here are made of text
 *  points, so document order of their containers decides. */
function overlaps(range: Range, element: Element): boolean {
  if (element.contains(range.startContainer)) return true;
  if (element.contains(range.endContainer)) return true;
  const startsBefore =
    range.startContainer.compareDocumentPosition(element) &
    Node.DOCUMENT_POSITION_FOLLOWING;
  const endsAfter =
    range.endContainer.compareDocumentPosition(element) &
    Node.DOCUMENT_POSITION_PRECEDING;
  return Boolean(startsBefore && endsAfter);
}

interface CellPoint {
  row: number;
  cell: number;
  offset: number;
}

/** Where a DOM point sits in a table: its cell and the offset in its text. */
function cellPoint(
  table: HTMLTableElement,
  node: Node,
  offset: number,
): CellPoint | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  const cell = element?.closest("td, th");
  if (!(cell instanceof HTMLTableCellElement) || !table.contains(cell))
    return null;
  const row = cell.parentElement;
  if (!(row instanceof HTMLTableRowElement)) return null;
  return {
    row: row.rowIndex,
    cell: cell.cellIndex,
    offset: textOffset(cell, node, offset),
  };
}

function pointInTable(
  table: HTMLTableElement,
  point: CellPoint,
  side: "start" | "end",
) {
  const cell = table.rows[point.row]?.cells[point.cell];
  return cell ? textPoint(cell, point.offset, side) : null;
}

function lastCellPoint(table: HTMLTableElement): CellPoint | null {
  const row = table.rows[table.rows.length - 1];
  const cell = row?.cells[row.cells.length - 1];
  return row && cell
    ? {
        row: row.rowIndex,
        cell: cell.cellIndex,
        offset: cell.textContent?.length ?? 0,
      }
    : null;
}

/**
 * The expanded copy of one of the answer's tables. Both render the same
 * Markdown, so a point maps across by its cell (row and column) and its
 * offset in the cell's text.
 */
export function tableMirrorSurface(
  root: HTMLElement,
  source: HTMLTableElement,
  mirror: HTMLTableElement,
): AnnotationSurface {
  const answer = answerSurface(root);
  return {
    text: answer.text,
    rangeFor(anchor) {
      const range = answer.rangeFor(anchor);
      if (!range || !overlaps(range, source)) return null;
      const start = source.contains(range.startContainer)
        ? cellPoint(source, range.startContainer, range.startOffset)
        : { row: 0, cell: 0, offset: 0 };
      const end = source.contains(range.endContainer)
        ? cellPoint(source, range.endContainer, range.endOffset)
        : lastCellPoint(source);
      const from = start && pointInTable(mirror, start, "start");
      const to = end && pointInTable(mirror, end, "end");
      if (!from || !to) return null;
      const mirrored = document.createRange();
      mirrored.setStart(from.node, from.offset);
      mirrored.setEnd(to.node, to.offset);
      return mirrored;
    },
    offsetsFor(range) {
      if (!mirror.contains(range.commonAncestorContainer)) return null;
      const start = cellPoint(mirror, range.startContainer, range.startOffset);
      const end = cellPoint(mirror, range.endContainer, range.endOffset);
      const from = start && pointInTable(source, start, "start");
      const to = end && pointInTable(source, end, "end");
      if (!from || !to) return null;
      return {
        start: textOffset(root, from.node, from.offset),
        end: textOffset(root, to.node, to.offset),
      };
    },
  };
}

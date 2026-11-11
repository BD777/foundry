import { inspect } from "node:util";
import { Node } from "happy-dom";

const maxTextLength = 60;

function clipText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxTextLength);
}

function describeNode(node) {
  try {
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const tagName = String(node.localName || node.nodeName).toLowerCase();
        const attributes = [];
        if (node.id) attributes.push(`id=${JSON.stringify(clipText(node.id))}`);
        if (node.className)
          attributes.push(`class=${JSON.stringify(clipText(node.className))}`);
        const text = clipText(node.textContent);
        const opening = `<${tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
        return `${opening}${text}</${tagName}>`;
      }
      case Node.TEXT_NODE:
        return `[Text ${JSON.stringify(clipText(node.data))}]`;
      case Node.DOCUMENT_NODE:
        return "[Document]";
      default:
        return `[${node.constructor?.name || node.nodeName || "Node"}]`;
    }
  } catch {
    return `[${node.constructor?.name || "Node"}]`;
  }
}

// Happy DOM exposes an enumerable graph of parent, child, owner document and
// window links, so printing a node walks the whole document. console.log and
// util.inspect use this summary instead. node:assert formats its diff with
// customInspect off, so tests compare what a node shows (text, attributes,
// presence as a boolean), never the node itself: assert.equal(node, undefined)
// can only end through --test-timeout.
Object.defineProperty(Node.prototype, inspect.custom, {
  configurable: true,
  value: function inspectDOMNode() {
    return describeNode(this);
  },
});

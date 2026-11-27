import { defineRule } from "@oxlint/plugins";

// AC-002 (docs/design/anti-cases.md): the shared surface accessory slots
// (SurfacePanelHeader/SurfaceSection/SurfaceDetailsSection/
// SurfaceGroupHeader `actions`/`action`) are icon-control territory —
// T3 expresses repeated row/section accessory actions as
// size="icon-*" buttons with an accessible name and tooltip. A
// non-icon-size Button there is the text-button proliferation the
// anti-case ledger rejects. Primary/rare labeled actions belong outside
// these slots; legitimate exceptions suppress with a reason
// (require-suppression-reason).
const SLOT_COMPONENTS = new Set([
  "SurfacePanelHeader",
  "SurfaceSection",
  "SurfaceDetailsSection",
  "SurfaceGroupHeader",
]);
const SLOT_PROPS = new Set(["actions", "action"]);

const isIconSize = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("icon");

type AttrNode = {
  name?: { name?: string };
  value?: unknown;
};

function jsxAttrString(attributes: AttrNode[] | undefined, name: string): string | undefined {
  for (const attr of attributes ?? []) {
    if (attr.name?.name !== name) continue;
    const v = attr.value as
      | { type?: string; value?: unknown }
      | { type?: string; expression?: { value?: unknown } }
      | null
      | undefined;
    if (!v || typeof v !== "object") continue;
    if (v.type === "Literal" && typeof (v as { value?: unknown }).value === "string") {
      return (v as { value: string }).value;
    }
    if (v.type === "JSXExpressionContainer") {
      const expr = (v as { expression?: { value?: unknown } }).expression;
      if (expr && typeof expr.value === "string") return expr.value;
    }
  }
  return undefined;
}

interface ButtonHit {
  node: unknown;
  size: string | undefined;
}

// Depth-first walk over an arbitrary ESTree-ish node collecting
// JSXElements named `Button` and their `size` attribute.
function* findButtons(node: unknown): Generator<ButtonHit> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* findButtons(item);
    return;
  }
  const n = node as {
    type?: string;
    openingElement?: {
      name?: { type?: string; name?: string };
      attributes?: AttrNode[];
    };
  };
  if (n.type === "JSXElement" && n.openingElement) {
    const opening = n.openingElement;
    if (opening.name?.type === "JSXIdentifier" && opening.name.name === "Button") {
      yield { node, size: jsxAttrString(opening.attributes, "size") };
    }
  }
  for (const [key, value] of Object.entries(node)) {
    // ESTree nodes carry `parent` back-references — following them
    // recurses forever.
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (value && typeof value === "object") yield* findButtons(value);
  }
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Accessory action slots on surface headers take icon controls (size=\"icon-*\" + accessible name/tooltip), not text buttons (AC-002).",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !SLOT_COMPONENTS.has(node.name.name)) {
          return;
        }
        for (const attr of node.attributes ?? []) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name.type !== "JSXIdentifier" || !SLOT_PROPS.has(attr.name.name)) {
            continue;
          }
          const value = attr.value;
          if (!value || value.type !== "JSXExpressionContainer") continue;
          for (const hit of findButtons(value.expression)) {
            if (isIconSize(hit.size)) continue;
            context.report({
              node: hit.node as never,
              message:
                "Text-size Button inside a surface accessory slot. Use size=\"icon-*\" with aria-label + tooltip for repeated actions, or suppress with a reason if this labeled action is intentional (AC-002).",
            });
          }
        }
      },
    };
  },
});

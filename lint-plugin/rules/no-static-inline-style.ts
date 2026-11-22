import { defineRule } from "@oxlint/plugins";

// Static inline styles belong in classes/tokens. Runtime-computed styles
// (pane geometry, measured values) are legitimate and need a suppression
// with a reason.
const isStaticLiteral = (node: unknown): boolean => {
  if (!node || typeof node !== "object") return false;
  const t = (node as { type?: string }).type;
  return t === "Literal" || t === "StringLiteral" || t === "NumericLiteral";
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow style={{}} whose values are all static literals; use a class or token. Runtime-computed styles need a suppression with a reason.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (filename.includes("components/ui/")) return {};
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "style") return;
        const value = node.value;
        if (!value || value.type !== "JSXExpressionContainer") return;
        const expr = value.expression;
        if (!expr || expr.type !== "ObjectExpression") return;
        const props = expr.properties;
        if (props.length === 0) return;
        const allStatic = props.every((p) => {
          if (p.type !== "Property") return false;
          const v = (p as { value?: { type?: string } }).value;
          return isStaticLiteral(v);
        });
        if (allStatic) {
          context.report({
            node,
            message:
              "Static inline style; use a class or design token. If the value is runtime-computed, restructure or suppress with a reason.",
          });
        }
      },
    };
  },
});

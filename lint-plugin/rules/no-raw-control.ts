import { defineRule } from "@oxlint/plugins";

// Styled raw <button>/<input>/<select>/<textarea> outside src/components/ui/
// is a control a shared primitive already provides. Semantic rows, tabs,
// resize handles and editor surfaces are allowed via an oxlint-disable
// comment with a reason (enforced by require-suppression-reason).
const CONTROL_ELEMENTS = new Set(["button", "input", "select", "textarea"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow styled raw form controls outside components/ui; use the shared primitives.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (filename.includes("components/ui/")) return {};
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!CONTROL_ELEMENTS.has(node.name.name)) return;
        const styled = node.attributes.some(
          (a) =>
            a.type === "JSXAttribute" &&
            a.name.type === "JSXIdentifier" &&
            a.name.name === "className",
        );
        if (!styled) return;
        context.report({
          node,
          message:
            `Raw <${node.name.name}> with className duplicates a ui/ primitive. Use Button/Input/Select/Textarea, or suppress with a reason if this is a semantic element.`,
        });
      },
    };
  },
});

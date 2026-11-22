import { defineRule } from "@oxlint/plugins";

// Raw <button>/<input>/<select>/<textarea> outside src/components/ui/ is a
// control a shared primitive already provides — styled or not. Semantic rows,
// tabs, resize handles and editor surfaces are allowed via an oxlint-disable
// comment with a reason (enforced by require-suppression-reason). Hidden
// inputs are exempt: they carry no rendered control.
const CONTROL_ELEMENTS = new Set(["button", "input", "select", "textarea"]);

const isHiddenInput = (node: {
  attributes: { type: string; name?: unknown; value?: unknown }[];
}) =>
  node.attributes.some(
    (a) =>
      a.type === "JSXAttribute" &&
      (a.name as { name?: string })?.name === "type" &&
      typeof a.value === "object" &&
      a.value !== null &&
      (a.value as { type?: string; value?: unknown }).type === "Literal" &&
      (a.value as { value?: unknown }).value === "hidden",
  );

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw form controls outside components/ui; use the shared primitives. Hidden inputs and reasoned semantic elements are exempt.",
    },
  },
  create(context) {
    const filename = context.filename ?? "";
    if (filename.includes("components/ui/")) return {};
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!CONTROL_ELEMENTS.has(node.name.name)) return;
        if (node.name.name === "input" && isHiddenInput(node)) return;
        context.report({
          node,
          message: `Raw <${node.name.name}> duplicates a ui/ primitive. Use Button/Input/Select/Textarea, or suppress with a reason if this is a semantic element.`,
        });
      },
    };
  },
});

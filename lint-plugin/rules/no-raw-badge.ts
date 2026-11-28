import { defineRule } from "@oxlint/plugins";

// AC-003 (docs/design/anti-cases.md): <Badge> is reserved for semantic
// status and classification. Using it for metadata chips (kind labels,
// paths, counts, guard flags, license/name tags) is badge abuse — render
// that content as plain muted text instead. Status indicators go through
// StatusBadge (ui/status-badge), the typed status channel. The ui/
// primitives themselves are exempt via .oxlintrc.json; surface debt is
// tracked at warn level under src/components/** until the #534 audit
// migrates each call site.
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Raw <Badge> is limited to semantic status/classification; use StatusBadge for status and plain text for metadata (AC-003).",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Badge") {
          return;
        }
        context.report({
          node: node as never,
          message:
            "Raw <Badge> outside the status channel. Use StatusBadge for status indicators, plain muted text for metadata (kind/paths/counts/flags), or suppress with a reason if this is genuine classification (AC-003).",
        });
      },
    };
  },
});

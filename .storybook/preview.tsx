import type { Preview } from "@storybook/react-vite";
import "../src/index.css";

const preview: Preview = {
  initialGlobals: { theme: "light" },
  globalTypes: {
    theme: {
      description: "Color theme (toggles the `.dark` class the app uses)",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div
        className={
          context.globals.theme === "dark"
            ? "dark min-h-screen bg-background text-foreground"
            : "min-h-screen bg-background text-foreground"
        }
      >
        <div className="p-6">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
};

export default preview;

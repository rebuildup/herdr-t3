import type { CSSProperties } from "react";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { Tooltip } from "../../src/components/ui/tooltip";

const paneStyle: CSSProperties = { position: "absolute", left: "10%", top: "20%" };

// Clean fixture: primitives used correctly, semantic exceptions carry a
// suppression with a reason, runtime styles are allowed.
export function GoodFixture() {
  return (
    <div>
      <Tooltip content="tip">
        <span>hover</span>
      </Tooltip>
      <Button title="Save" className="w-full">
        Save
      </Button>
      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row, not a standalone control */}
      <button type="button" className="flex h-9 items-center px-2.5">
        row
      </button>
      <div style={paneStyle}>runtime-positioned pane</div>
      <Input />
    </div>
  );
}

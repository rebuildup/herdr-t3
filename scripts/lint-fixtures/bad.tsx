import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { cn } from "../../src/lib/utils";

// This fixture intentionally violates every UI lint rule. It is excluded from
// the product lint run (`oxlint src`) and only exercised by
// scripts/lint-ui.test.ts, which asserts each rule fires.
export function BadFixture() {
  return (
    <div>
      <select className="rounded border px-2 py-1">
        <option value="a">a</option>
      </select>
      <input
        type="text"
        className={cn(
          "w-full rounded-md border px-2 py-1",
          "text-sm",
        )}
      />
      <Button className="bg-red-500 text-white">restyled</Button>
      <div title="native tooltip">hover me</div>
      <div style={{ color: "red", padding: "4px" }}>static style</div>
      {/* oxlint-disable-next-line herdr-t3/no-raw-control */}
      <button type="button" className="px-2">suppressed without reason</button>
    </div>
  );
}

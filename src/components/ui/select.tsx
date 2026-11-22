import { Select as BaseSelect } from "@base-ui/react/select";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Select({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <BaseSelect.Root value={value} onValueChange={(v) => onValueChange(String(v))}>
      {children}
    </BaseSelect.Root>
  );
}

export function SelectTrigger({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <BaseSelect.Trigger
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-2xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
      <BaseSelect.Icon className="text-muted-foreground">▾</BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectValue() {
  return <BaseSelect.Value />;
}

export function SelectContent({ children }: { children: ReactNode }) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner className="z-50">
        <BaseSelect.Popup className="min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseSelect.Item value={value} className="flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

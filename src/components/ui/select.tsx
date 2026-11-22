import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
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
        "flex min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-2xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
    >
      {children}
      <BaseSelect.Icon className="shrink-0 text-muted-foreground">
        <ChevronDown className="size-3.5" aria-hidden />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectValue() {
  return <BaseSelect.Value className="min-w-0 flex-1 truncate data-[placeholder]:text-muted-foreground" />;
}

export function SelectContent({ children }: { children: ReactNode }) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner className="z-50">
        <BaseSelect.Popup className="min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseSelect.Item
      value={value}
      className="flex cursor-default items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
    >
      <BaseSelect.ItemIndicator className="shrink-0 text-muted-foreground">
        <Check className="size-3.5" aria-hidden />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

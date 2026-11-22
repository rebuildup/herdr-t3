import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

export function DialogContent({ children }: { children: ReactNode }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
      <BaseDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg">
        {children}
        <BaseDialog.Close
          aria-label="Close"
          className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden />
        </BaseDialog.Close>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <BaseDialog.Title className="mb-3 text-sm font-medium">{children}</BaseDialog.Title>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <BaseDialog.Description className="mb-3 text-xs text-muted-foreground">{children}</BaseDialog.Description>;
}

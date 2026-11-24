import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { rpc } from "../lib/api";
import type { RpcMethod } from "../../shared/protocol";

export interface RenameTarget {
  kind: "workspace" | "tab" | "pane";
  id: string;
  label: string;
}

const METHOD: Record<RenameTarget["kind"], RpcMethod> = {
  workspace: "workspace.rename",
  tab: "tab.rename",
  pane: "pane.rename",
};

const PARAM_KEY: Record<RenameTarget["kind"], string> = {
  workspace: "workspace_id",
  tab: "tab_id",
  pane: "pane_id",
};

export function RenameDialog({
  target,
  machine,
  onClose,
}: {
  target: RenameTarget | null;
  machine: string;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(target?.label ?? "");
    if (target) requestAnimationFrame(() => inputRef.current?.select());
  }, [target]);

  const submit = () => {
    if (!target) return;
    const label = value.trim();
    if (!label) {
      onClose();
      return;
    }
    void rpc(METHOD[target.kind], { [PARAM_KEY[target.kind]]: target.id, label }, machine).finally(onClose);
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {target?.kind}</DialogTitle>
          <DialogDescription>Shown in the {target?.kind} list and tab strip.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            className="w-full"
          />
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

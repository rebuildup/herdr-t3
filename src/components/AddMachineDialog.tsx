import { useState } from "react";
import { machineAdd } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogAction,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function AddMachineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [session, setSession] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim() || !target.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await machineAdd({
        label: label.trim(),
        target: target.trim(),
        session: session.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription>
            Connect to a herdr server over SSH. Uses your existing ssh config; the first
            connect may require interactive SSH authentication in a terminal.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-6 pb-6">
          <Input
            placeholder="Label (e.g. lab-windows)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            placeholder="SSH target (user@host or ssh config alias)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Input
            placeholder="Herdr session (default)"
            value={session}
            onChange={(e) => setSession(e.target.value)}
          />
          {error && <p className="text-2xs text-error">{error}</p>}
        </div>
        <DialogFooter>
          <DialogAction variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </DialogAction>
          <DialogAction
            size="sm"
            disabled={busy || !label.trim() || !target.trim()}
            onClick={() => void submit()}
          >
            Add
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

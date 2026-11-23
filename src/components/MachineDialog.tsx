/*
 * Machine management dialogs for Settings → Connections (issue #85).
 * Every action goes through the bridge's machine_* frames, which shell out
 * to `herdr machine …` in the main process — the registry in
 * endpoints.json stays herdr-owned; nothing here writes it directly.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { machineAdd, machineRemove, machineUpdate, ApiError } from "../lib/api";
import type { MachineInfo } from "../../shared/protocol";

export type MachineDialogState =
  | { mode: "add" }
  | { mode: "rename"; machine: MachineInfo }
  | { mode: "remove"; machine: MachineInfo };

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function MachineDialog({
  state,
  onClose,
}: {
  state: MachineDialogState | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLabel(state?.mode === "rename" ? state.machine.label : "");
    setTarget("");
    setSession("");
    setBusy(false);
    setError(null);
    if (state) requestAnimationFrame(() => inputRef.current?.select());
  }, [state]);

  const machine = state && state.mode !== "add" ? state.machine : null;

  const submit = () => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    const done = () => {
      setBusy(false);
      onClose();
    };
    const fail = (err: unknown) => {
      setBusy(false);
      setError(errorText(err));
    };
    if (state.mode === "add") {
      const trimmedLabel = label.trim();
      const trimmedTarget = target.trim();
      if (!trimmedLabel || !trimmedTarget) {
        setBusy(false);
        setError("Label and target are required.");
        return;
      }
      void machineAdd({
        label: trimmedLabel,
        target: trimmedTarget,
        ...(session.trim() ? { session: session.trim() } : {}),
      }).then(done, fail);
      return;
    }
    if (state.mode === "rename") {
      const trimmed = label.trim();
      if (!trimmed || trimmed === machine?.label) {
        done();
        return;
      }
      void machineUpdate(machine!.id, { label: trimmed }).then(done, fail);
      return;
    }
    void machineRemove(machine!.id).then(done, fail);
  };

  const titles = { add: "Add machine", rename: "Rename machine", remove: "Remove machine" } as const;
  const descriptions = {
    add: "Save an SSH endpoint in herdr's machine registry. herdr machine add may ask for approval in your terminal.",
    rename: "The label shown in the sidebar and settings.",
    remove: "Removes the saved SSH endpoint from herdr's registry. Running sessions are disconnected; panes on that machine are not killed.",
  } as const;

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogTitle>{state ? titles[state.mode] : ""}</DialogTitle>
        <DialogDescription>{state ? descriptions[state.mode] : ""}</DialogDescription>
        {state?.mode === "add" ? (
          <div className="mb-4 flex flex-col gap-2">
            <Input
              ref={inputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Workstation)"
              aria-label="Machine label"
            />
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Target (user@host or ssh alias)"
              aria-label="SSH target"
            />
            <Input
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="Remote session (optional)"
              aria-label="Remote herdr session"
            />
          </div>
        ) : state?.mode === "rename" ? (
          <Input
            ref={inputRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mb-4 w-full"
            aria-label="Machine label"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
          />
        ) : state?.mode === "remove" ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Remove <span className="font-medium text-foreground">{machine?.label}</span>
            {machine?.target ? ` (${machine.target})` : ""}?
          </p>
        ) : null}
        {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={state?.mode === "remove" ? "destructive" : "default"}
            disabled={busy}
            onClick={submit}
          >
            {busy
              ? "Working…"
              : state?.mode === "add"
                ? "Add machine"
                : state?.mode === "rename"
                  ? "Rename"
                  : "Remove"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

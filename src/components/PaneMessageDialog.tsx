import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { rpc } from "../lib/api";
import { focusPaneTerminal } from "../lib/paneFocus";
import type { PaneInfo } from "../../shared/protocol";

/**
 * Sends text to a pane through herdr's canonical input paths:
 * `agent.prompt` for agent panes, `pane.send_text` + `pane.send_keys` for
 * plain shells. Never guesses key sequences for prompt answers — the
 * attached terminal remains the interactive path for those.
 */
export function PaneMessageDialog({
  pane,
  machine,
  onClose,
}: {
  pane: PaneInfo | null;
  machine: string;
  onClose: () => void;
}) {
  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isAgent = Boolean(pane?.agent);

  useEffect(() => {
    setText("");
    setSending(false);
    if (pane) requestAnimationFrame(() => inputRef.current?.focus());
  }, [pane]);

  const submit = async () => {
    const value = text.trim();
    if (!pane || !value || sending) return;
    setSending(true);
    try {
      if (isAgent) {
        await rpc("agent.prompt", { target: pane.pane_id, text: value }, machine);
      } else {
        await rpc("pane.send_text", { pane_id: pane.pane_id, text: value }, machine);
        await rpc("pane.send_keys", { pane_id: pane.pane_id, keys: ["enter"] }, machine);
      }
      requestClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={pane !== null} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent>
        <DialogTitle>{isAgent ? "Prompt agent" : "Send text"}</DialogTitle>
        <DialogDescription>
          {isAgent
            ? `Submitted through agent.prompt to ${pane?.agent} in ${pane?.pane_id}.`
            : `Typed into ${pane?.pane_id} through pane.send_text + enter.`}
        </DialogDescription>
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            if (e.key === "Escape") requestClose();
          }}
          rows={4}
          placeholder={isAgent ? "Prompt for the agent…" : "Text to type into the pane…"}
          className="mb-4 w-full resize-none"
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={sending || !text.trim()}>
            {isAgent ? "Send prompt" : "Send"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

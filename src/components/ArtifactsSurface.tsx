/*
 * Artifacts surface (issue #396 read surface, #455 mutations;
 * ADR-0011 boundary): the host's `rebuildup.artifacts` plugin
 * (`herdr-plugins.artifacts/v1` pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0) owns the artifact registry
 * — references to generated files (HTML pages, images, PDFs, generic
 * files) with kind validation, verify, deliver and gc.
 *
 * Reads: `export` (the contract-designated client read surface — the
 * same annotated records as `list` plus `returned`/`complete`/`filters`
 * echo), `search` (free-text over metadata, never payload bytes) and
 * `verify` (read-only integrity re-check). Mutations (issue #455):
 * `register` (existing host paths only — `--stdin` bytes cannot cross
 * `plugin_call`), `delete` (`--force` only after explicit opt-in for
 * referenced records), `deliver` (`--agent` agent.prompt / `--pane`
 * pane.send_text of the resolved path) and `gc` (`--older-than`,
 * dry-run default). Every mutation is gated per host by
 * `artifactsSupportsMutation` (local allowlist ∩ advertised
 * `mutation_commands` ∩ `commands`), confirms through a dialog naming
 * the exact artifact id/path/kind/target, and renders the plugin's
 * result document verbatim — honest `error.kind`/detail on failure,
 * never relabelled.
 *
 * Honesty rules rendered verbatim: `missing_ref`, `owner_stale`,
 * `oversize`, top-level `orphans`/`corrupt`, verify `status`
 * (`ok`|`corrupt`|`missing`) and `issues[]`, gc per-entry
 * `action`/`reason`/`error`. An empty registry is the normal state
 * while no producer registers artifacts — rendered as an honest empty
 * state. Artifact payloads are NEVER rendered inline: `resolved_path`
 * is shown as text (with a copy affordance) because no shell-open
 * bridge exists yet; `kind:"html"` records additionally carry
 * `meta.render {isolation:"required", policy:"client"}` —
 * client-side isolated rendering is a later concern, so HTML is
 * link/copy-only here.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CopyIcon,
  EraserIcon,
  PackagePlusIcon,
  SearchIcon,
  SendHorizontalIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import { RefreshIcon } from "./ui/refresh-icon";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import {
  artifactsCapability,
  artifactsErrorHint,
  artifactsSupportsMutation,
  classifyArtifactsError,
  deleteArtifact,
  deliverArtifact,
  fetchArtifactsExport,
  fetchArtifactsSearch,
  fetchArtifactsVerify,
  gcArtifacts,
  refreshArtifacts,
  registerArtifact,
  useArtifactsState,
  type ArtifactRecord,
  type ArtifactVerification,
  type ArtifactsCapability,
  type ArtifactsDeleteResult,
  type ArtifactsDeliverResult,
  type ArtifactsDeliverTargetKind,
  type ArtifactsExportReport,
  type ArtifactsGcReport,
  type ArtifactsReadOptions,
  type ArtifactsSearchReport,
  type ArtifactsUnavailableReason,
  type ArtifactsVerifyReport,
} from "../shell/artifacts";

const UNAVAILABLE_LABELS: Record<ArtifactsUnavailableReason, string> = {
  not_installed: "artifacts plugin not installed",
  disabled: "artifacts plugin disabled",
  incompatible: "artifacts contract incompatible",
  unreachable: "artifacts host unreachable",
  error: "artifacts unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyArtifactsError(error);
  const hint = artifactsErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  return hint !== null ? `${base} (${hint})` : base;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatBytes(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Basename of the storage ref — the plugin's sanitized filename. */
function artifactFilename(record: ArtifactRecord): string {
  const ref = record.storage.ref;
  if (ref === null || ref === "") return record.artifact_id;
  const name = ref.split("/").pop();
  return name !== undefined && name !== "" ? name : record.artifact_id;
}

const FALLBACK_KINDS = ["html", "image", "pdf", "file", "other"] as const;

/** `owner.created_by` contract values (model.ts CREATED_BY, verbatim). */
const CREATED_BY_VALUES = ["pane", "agent", "handoff", "script", "cli", "unknown"] as const;

function kindBadgeVariant(
  kind: string | null,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (kind) {
    case "html":
      return "info";
    case "image":
      return "success";
    case "pdf":
      return "warning";
    case "file":
    case "other":
      return "secondary";
    default:
      return "outline";
  }
}

function verifyStatusVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "ok":
      return "success";
    case "corrupt":
      return "error";
    case "missing":
      return "warning";
    default:
      return "outline";
  }
}

/* ------------------------------ artifact row -------------------------- */

function HonestFlags({ record }: { record: ArtifactRecord }) {
  return (
    <>
      {record.missing_ref ? (
        <Badge size="sm" variant="error" title="payload missing or unsafe (storage_ref_missing)">
          missing_ref
        </Badge>
      ) : null}
      {record.owner_stale ? (
        <Badge size="sm" variant="warning" title="owner pane absent from the live snapshot">
          owner_stale
        </Badge>
      ) : null}
      {record.oversize ? (
        <Badge size="sm" variant="warning" title="size exceeds the per-kind cap">
          oversize
        </Badge>
      ) : null}
      {record.warnings
        .filter(
          (w) =>
            w !== "storage_ref_missing" &&
            w !== "owner_stale" &&
            w !== "oversize",
        )
        .map((warning) => (
          <Badge key={warning} size="sm" variant="outline">
            {warning}
          </Badge>
        ))}
    </>
  );
}

function ArtifactRow({
  record,
  machine,
  cap,
  onMutated,
}: {
  record: ArtifactRecord;
  machine?: string;
  cap?: ArtifactsCapability | null | undefined;
  onMutated?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const resolvedPath = record.storage.resolved_path;
  const copyPath = () => {
    if (resolvedPath === null) return;
    void navigator.clipboard?.writeText(resolvedPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  const ownerBits = [
    record.owner.pane_id !== null ? `pane ${record.owner.pane_id}` : null,
    record.owner.agent_session !== null ? `agent ${record.owner.agent_session}` : null,
    record.owner.created_by !== null ? `by ${record.owner.created_by}` : null,
  ].filter((bit): bit is string => bit !== null);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant={kindBadgeVariant(record.kind)}>
          {record.kind ?? "unknown"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {record.title ?? artifactFilename(record)}
        </span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
          {record.artifact_id}
        </span>
        <HonestFlags record={record} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="shrink-0">{formatTime(record.created_at)}</span>
        <span className="shrink-0">{formatBytes(record.size)}</span>
        {record.mime !== null ? <span className="shrink-0">{record.mime}</span> : null}
        {record.storage.mode !== null ? (
          <Badge size="sm" variant="outline">
            {record.storage.mode}
          </Badge>
        ) : null}
        {ownerBits.length > 0 ? (
          <span className="min-w-0 truncate">{ownerBits.join(" · ")}</span>
        ) : null}
        {record.session !== null || record.host !== null ? (
          <span className="min-w-0 truncate text-muted-foreground/70">
            {[record.host, record.session].filter((v): v is string => v !== null).join(" / ")}
          </span>
        ) : null}
      </div>
      {resolvedPath !== null ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
            {resolvedPath}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={copyPath}
            aria-label={copied ? "Path copied" : "Copy resolved path"}
            title={copied ? "Copied" : "Copy resolved path"}
          >
            <CopyIcon className="size-3" />
          </Button>
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground/70">no resolved_path reported</p>
      )}
      {record.kind === "html" && record.meta?.render != null ? (
        <p className="text-2xs text-muted-foreground/70">
          html — render isolation required, sandbox/CSP is client-side; open the
          resolved path externally (never rendered inline)
        </p>
      ) : null}
      {record.refs.length > 0 ? (
        <p className="truncate text-2xs text-muted-foreground/70">
          refs: {record.refs.join(", ")}
        </p>
      ) : null}
      {machine !== undefined && onMutated !== undefined ? (
        <ArtifactActions
          machine={machine}
          record={record}
          cap={cap}
          onMutated={onMutated}
        />
      ) : null}
    </div>
  );
}

/* --------------------------- record mutations -------------------------- */

type ArtifactRowAction = "deliver" | "delete";

/** Compact target-identity block for the confirmation dialog. */
function artifactIdentityLines(record: ArtifactRecord): string[] {
  const lines: string[] = [
    `artifact ${record.artifact_id}${record.kind !== null ? ` (${record.kind})` : ""}`,
    record.title ?? artifactFilename(record),
    `created ${formatTime(record.created_at)} · ${formatBytes(record.size)}${
      record.mime !== null ? ` · ${record.mime}` : ""
    }`,
  ];
  const hostBits = [record.host, record.session]
    .filter((v): v is string => v !== null)
    .join(" / ");
  if (hostBits !== "") lines.push(`host/session ${hostBits}`);
  if (record.storage.mode !== null) lines.push(`storage ${record.storage.mode}`);
  if (record.storage.resolved_path !== null) {
    lines.push(`path ${record.storage.resolved_path}`);
  }
  if (record.refs.length > 0) {
    lines.push(`refs ${record.refs.join(", ")}`);
  }
  if (record.missing_ref) lines.push("missing_ref — payload absent or unsafe");
  if (record.owner_stale) lines.push("owner_stale — owner pane not in live snapshot");
  return lines;
}

const ROW_ACTION_TITLES: Record<ArtifactRowAction, string> = {
  deliver: "Deliver artifact?",
  delete: "Delete artifact?",
};

const ROW_ACTION_CONFIRM: Record<ArtifactRowAction, string> = {
  deliver: "Deliver",
  delete: "Delete",
};

const ROW_ACTION_DESCRIPTIONS: Record<ArtifactRowAction, string> = {
  deliver:
    "Sends the artifact's resolved path inside agent.prompt (--agent) or pane.send_text (--pane) text — v1 delivery is the path embedded in the message, there is no structured attachment API. --pane delivers literal text: embedded newlines reach the PTY as Enter, so prefer --agent for agent panes. The plugin refuses missing payloads (missing_ref) and stale/absent targets (target_not_found/agent_not_found).",
  delete:
    "Removes the index record permanently; state_copy payloads are deleted too, while path_ref external files are NEVER removed by the plugin. Records carrying refs (handoff/conversations/checkpoint back-references) refuse without --force — tick 'force' only when you accept breaking those references.",
};

type ArtifactMutationResult =
  | { action: "deliver"; result: ArtifactsDeliverResult }
  | { action: "delete"; result: ArtifactsDeleteResult };

function ArtifactMutationResultView({ result }: { result: ArtifactMutationResult }) {
  if (result.action === "deliver") {
    const r = result.result;
    return (
      <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-2xs">
        <div className="flex items-center gap-2">
          <Badge size="sm" variant="success">
            delivered
          </Badge>
          <span className="text-muted-foreground">
            {r.method ?? "?"} → {r.target.kind ?? "?"} {r.target.pane_id ?? "?"}
          </span>
        </div>
        <div className="font-mono text-muted-foreground">
          artifact {r.artifact_id ?? "?"}
        </div>
        {r.message !== null ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-1.5 font-mono text-muted-foreground">
            {r.message}
          </pre>
        ) : null}
      </div>
    );
  }
  const r = result.result;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-2xs">
      <div className="flex items-center gap-2">
        <Badge size="sm" variant="success">
          deleted
        </Badge>
        <span className="font-mono text-muted-foreground">
          {r.artifact_id ?? "?"}
        </span>
      </div>
      <div className="text-muted-foreground">
        storage {r.storage_mode ?? "?"} · payload{" "}
        {r.removed_payload === true
          ? "removed"
          : r.removed_payload === false
            ? "kept (path_ref external file)"
            : "?"}
      </div>
    </div>
  );
}

/**
 * Confirmation + options dialog for one per-record mutation
 * (`deliver`/`delete`). The identity block always names the exact
 * artifact id/kind/path before anything is sent; `delete` on a
 * referenced record requires the explicit force opt-in. On success the
 * plugin's own result document is rendered verbatim and `onMutated`
 * refetches — the surface never assumes the post-mutation state.
 */
function ArtifactMutationDialog({
  machine,
  action,
  record,
  onClose,
  onMutated,
}: {
  machine: string;
  action: ArtifactRowAction;
  record: ArtifactRecord;
  onClose: () => void;
  onMutated: () => void;
}) {
  const isDeliver = action === "deliver";
  const [targetKind, setTargetKind] = useState<ArtifactsDeliverTargetKind>("agent");
  const [paneId, setPaneId] = useState(record.owner.pane_id ?? "");
  const [note, setNote] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArtifactMutationResult | null>(null);

  const formValid = !isDeliver || paneId.trim() !== "";
  const referenced = record.refs.length > 0;

  const submit = async () => {
    if (busy || !formValid) return;
    setBusy(true);
    setError(null);
    try {
      if (isDeliver) {
        const next = await deliverArtifact(machine, {
          artifactId: record.artifact_id,
          targetKind,
          paneId,
          note,
        });
        setResult({ action: "deliver", result: next });
      } else {
        const next = await deleteArtifact(machine, record.artifact_id, force);
        setResult({ action: "delete", result: next });
      }
      // The registry changed plugin-side; refetch rather than assume.
      onMutated();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{ROW_ACTION_TITLES[action]}</DialogTitle>
          <DialogDescription>{ROW_ACTION_DESCRIPTIONS[action]}</DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
              {artifactIdentityLines(record).map((line) => (
                <p key={line} className="text-2xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>

            {isDeliver ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Select
                    value={targetKind}
                    onValueChange={(value) =>
                      setTargetKind(value === "pane" ? "pane" : "agent")
                    }
                  >
                    <SelectTrigger aria-label="Deliver target kind" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">agent (agent.prompt)</SelectItem>
                      <SelectItem value="pane">pane (send_text)</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    size="sm"
                    value={paneId}
                    onChange={(e) => setPaneId(e.target.value)}
                    placeholder="target pane id (e.g. w1:p1)"
                    aria-label="Deliver target pane"
                    className="w-44"
                  />
                </div>
                {targetKind === "pane" ? (
                  <p className="text-2xs text-muted-foreground/70">
                    pane target sends literal text via pane.send_text — embedded
                    newlines reach the PTY as Enter
                  </p>
                ) : null}
                <Input
                  size="sm"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="note (optional — appended to the delivered message)"
                  aria-label="Deliver note"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {referenced ? (
                  <>
                    <p className="text-2xs text-warning">
                      this record carries {record.refs.length} ref
                      {record.refs.length === 1 ? "" : "s"} — delete refuses
                      without --force
                    </p>
                    <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                      <Switch
                        size="sm"
                        checked={force}
                        onCheckedChange={(checked) => setForce(checked === true)}
                        aria-label="Force delete referenced artifact"
                      />
                      <span>
                        Force delete (--force) — removes the record despite its
                        back-references; consumers of those refs will dangle
                      </span>
                    </div>
                  </>
                ) : null}
                {record.storage.mode === "path_ref" ? (
                  <p className="text-2xs text-muted-foreground/70">
                    path_ref storage: only the index record is removed — the
                    external file at the resolved path is never touched
                  </p>
                ) : null}
              </div>
            )}

            {error !== null ? (
              <p className="text-2xs text-destructive">mutation failed: {error}</p>
            ) : null}

            {result !== null ? <ArtifactMutationResultView result={result} /> : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
            {result !== null ? "Done" : "Cancel"}
          </Button>
          {result === null ? (
            <Button
              size="sm"
              variant={action === "delete" ? "destructive" : "default"}
              disabled={busy || !formValid}
              onClick={() => void submit()}
            >
              {busy ? "Working…" : ROW_ACTION_CONFIRM[action]}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mutation action row for one artifact. Buttons render only when the
 * host capability allows the command; `cap === undefined` (probing) or
 * `null` (unavailable) hides everything.
 */
function ArtifactActions({
  machine,
  record,
  cap,
  onMutated,
}: {
  machine: string;
  record: ArtifactRecord;
  cap: ArtifactsCapability | null | undefined;
  onMutated: () => void;
}) {
  const [action, setAction] = useState<ArtifactRowAction | null>(null);
  const canDeliver = artifactsSupportsMutation(cap, "deliver") === true;
  const canDelete = artifactsSupportsMutation(cap, "delete") === true;

  if (!canDeliver && !canDelete) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {canDeliver ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => setAction("deliver")}
          >
            <SendHorizontalIcon />
            Deliver…
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={() => setAction("delete")}
          >
            <Trash2Icon />
            Delete
          </Button>
        ) : null}
      </div>
      {action !== null ? (
        <ArtifactMutationDialog
          machine={machine}
          action={action}
          record={record}
          onClose={() => setAction(null)}
          onMutated={onMutated}
        />
      ) : null}
    </div>
  );
}

/* ------------------------- surface mutations --------------------------- */

/**
 * `register` dialog — registers an existing host path. `--stdin` is
 * never offered (payload bytes cannot cross `plugin_call`); kind,
 * storage, created-by and refs are optional and left unset they are
 * inferred/defaulted plugin-side, never fabricated here. Refs are one
 * per line (`<plugin>:<kind>/<id>` convention).
 */
function RegisterArtifactDialog({
  machine,
  kinds,
  onClose,
  onMutated,
}: {
  machine: string;
  kinds: readonly string[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [path, setPath] = useState("");
  const [kind, setKind] = useState("");
  const [storage, setStorage] = useState("");
  const [title, setTitle] = useState("");
  const [paneId, setPaneId] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [refs, setRefs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<ArtifactRecord | null>(null);

  const formValid = path.trim() !== "";

  const submit = async () => {
    if (busy || !formValid) return;
    setBusy(true);
    setError(null);
    try {
      const next = await registerArtifact(machine, {
        path,
        ...(kind !== "" ? { kind } : {}),
        ...(storage !== "" ? { storage } : {}),
        ...(title.trim() !== "" ? { title } : {}),
        ...(paneId.trim() !== "" ? { paneId } : {}),
        ...(createdBy !== "" ? { createdBy } : {}),
        refs: refs
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      });
      setRecord(next);
      onMutated();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Register artifact?</DialogTitle>
          <DialogDescription>
            Registers an existing file on this host into the artifact
            registry. state_copy (default) copies the payload into plugin
            state; path_ref stores only the resolved path. HTML payloads
            must open like a document — the plugin validates shape, never
            renders.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[5rem_1fr] items-center gap-1.5">
              <span className="text-2xs text-muted-foreground">path</span>
              <Input
                size="sm"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/file"
                aria-label="Artifact source path"
              />
              <span className="text-2xs text-muted-foreground">kind</span>
              <Select
                value={kind === "" ? "__auto__" : kind}
                onValueChange={(value) => setKind(value === "__auto__" ? "" : value)}
              >
                <SelectTrigger aria-label="Artifact kind" className="w-full">
                  <SelectValue>
                    {(value) => (value === "__auto__" ? "auto (infer)" : value)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">auto (infer from extension/MIME)</SelectItem>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-2xs text-muted-foreground">storage</span>
              <Select
                value={storage === "" ? "__default__" : storage}
                onValueChange={(value) =>
                  setStorage(value === "__default__" ? "" : value)
                }
              >
                <SelectTrigger aria-label="Storage mode" className="w-full">
                  <SelectValue>
                    {(value) =>
                      value === "__default__" ? "default (state_copy)" : value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">default (state_copy)</SelectItem>
                  <SelectItem value="state_copy">state_copy</SelectItem>
                  <SelectItem value="path_ref">path_ref</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-2xs text-muted-foreground">title</span>
              <Input
                size="sm"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="optional display name"
                aria-label="Artifact title"
              />
              <span className="text-2xs text-muted-foreground">pane</span>
              <Input
                size="sm"
                value={paneId}
                onChange={(e) => setPaneId(e.target.value)}
                placeholder="owner pane id (e.g. w1:p1)"
                aria-label="Owner pane"
              />
              <span className="text-2xs text-muted-foreground">created by</span>
              <Select
                value={createdBy === "" ? "__any__" : createdBy}
                onValueChange={(value) =>
                  setCreatedBy(value === "__any__" ? "" : value)
                }
              >
                <SelectTrigger aria-label="Created by" className="w-full">
                  <SelectValue>
                    {(value) => (value === "__any__" ? "plugin default" : value)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">plugin default</SelectItem>
                  {CREATED_BY_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-2xs text-muted-foreground">
                refs (optional — one per line, e.g.{" "}
                <span className="font-mono">conversations:event/evt-1</span>;
                referenced records refuse delete/gc without force)
              </span>
              <Textarea
                value={refs}
                onChange={(e) => setRefs(e.target.value)}
                placeholder={"conversations:event/evt-1\nhandoff:record/h-1"}
                aria-label="Artifact refs"
                className="min-h-14"
              />
            </div>

            {path.trim() !== "" ? (
              <p className="text-2xs text-muted-foreground">
                registers <span className="font-mono">{path.trim()}</span>
                {kind !== "" ? ` as ${kind}` : ""}
                {storage !== "" ? ` (${storage})` : ""}
              </p>
            ) : null}
            {error !== null ? (
              <p className="text-2xs text-destructive">register failed: {error}</p>
            ) : null}
            {record !== null ? (
              <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-2xs">
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant={kindBadgeVariant(record.kind)}>
                    {record.kind ?? "unknown"}
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    {record.artifact_id}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {record.title ?? artifactFilename(record)}
                  {record.storage.resolved_path !== null
                    ? ` · ${record.storage.resolved_path}`
                    : ""}
                </div>
                {record.warnings.length > 0 ? (
                  <div className="text-muted-foreground">
                    warnings: {record.warnings.join(", ")}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            {record !== null ? "Done" : "Cancel"}
          </Button>
          {record === null ? (
            <Button
              size="sm"
              disabled={busy || !formValid}
              onClick={() => void submit()}
            >
              {busy ? "Working…" : "Register"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `gc` dialog — age-based retention. `--dry-run` is the default and
 * performs the full evaluation with zero mutation; unchecking it sends
 * the real collect. The plugin's per-entry report (`deleted` /
 * `would_delete` / `skipped` + verbatim `reason`/`error`) and totals
 * are rendered verbatim — referenced records are skipped, never
 * collected, and `path_ref` external files are never deleted.
 */
function GcArtifactsDialog({
  machine,
  onClose,
  onMutated,
}: {
  machine: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [olderThan, setOlderThan] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ArtifactsGcReport | null>(null);

  const olderThanDate = olderThan === "" ? null : new Date(olderThan);
  const olderThanValid =
    olderThanDate !== null && !Number.isNaN(olderThanDate.getTime());
  const formValid = olderThanValid;

  const submit = async () => {
    if (busy || !formValid || olderThanDate === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await gcArtifacts(machine, {
        olderThan: olderThanDate.toISOString(),
        dryRun,
      });
      setReport(next);
      onMutated();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Collect old artifacts?</DialogTitle>
          <DialogDescription>
            Removes unreferenced artifact records created strictly before
            the cutoff. state_copy payloads are deleted with the record;
            path_ref external files are never touched. Referenced records
            are always skipped. Dry run previews the full evaluation with
            zero mutation.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                size="sm"
                type="datetime-local"
                value={olderThan}
                onChange={(e) => setOlderThan(e.target.value)}
                aria-label="Collect artifacts older than"
                title="Collect artifacts older than (created_at strictly before)"
              />
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <Switch
                  size="sm"
                  checked={dryRun}
                  onCheckedChange={(checked) => setDryRun(checked === true)}
                  aria-label="Dry run"
                />
                <span>dry run (evaluate only, no mutation)</span>
              </div>
            </div>
            {olderThan !== "" && !olderThanValid ? (
              <p className="text-2xs text-destructive">enter a valid date/time</p>
            ) : null}
            {error !== null ? (
              <p className="text-2xs text-destructive">gc failed: {error}</p>
            ) : null}

            {report !== null ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-2xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" variant={report.dryRun === true ? "info" : "success"}>
                    {report.dryRun === true ? "dry run" : "collected"}
                  </Badge>
                  <span className="text-muted-foreground">
                    older than {report.olderThan ?? "?"} · evaluated{" "}
                    {report.evaluated ?? "?"} · expired {report.expired ?? "?"}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {report.totals.deleted ?? "?"} deleted ·{" "}
                  {report.totals.would_delete ?? "?"} would delete ·{" "}
                  {report.totals.skipped_referenced ?? "?"} skipped (referenced)
                  · {report.totals.skipped_other ?? "?"} skipped (other) ·{" "}
                  {report.totals.kept ?? "?"} kept
                  {(report.totals.errors ?? 0) > 0
                    ? ` · ${report.totals.errors} error${report.totals.errors === 1 ? "" : "s"}`
                    : ""}
                </div>
                {report.entries.length > 0 ? (
                  <div className="flex max-h-48 flex-col gap-0.5 overflow-auto">
                    {report.entries.map((entry) => (
                      <div
                        key={entry.artifact_id}
                        className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-0.5"
                      >
                        <Badge
                          size="sm"
                          variant={
                            entry.action === "deleted" || entry.action === "would_delete"
                              ? "warning"
                              : entry.action === "skipped"
                                ? "outline"
                                : "secondary"
                          }
                        >
                          {entry.action ?? "?"}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {entry.artifact_id}
                        </span>
                        <span className="shrink-0 text-muted-foreground/70">
                          {entry.reason ?? entry.storage_mode ?? ""}
                          {entry.removed_payload === true ? " · payload removed" : ""}
                          {entry.error !== null ? ` · ${entry.error}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">no entries reported</p>
                )}
                {report.orphans.length > 0 || report.corrupt.length > 0 ? (
                  <div className="text-muted-foreground/70">
                    {report.orphans.length > 0
                      ? `${report.orphans.length} orphan payload dir(s): ${report.orphans.join(", ")}`
                      : ""}
                    {report.orphans.length > 0 && report.corrupt.length > 0 ? " · " : ""}
                    {report.corrupt.length > 0
                      ? `${report.corrupt.length} corrupt index record(s): ${report.corrupt.join(", ")}`
                      : ""}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            {report !== null ? "Done" : "Cancel"}
          </Button>
          {report === null ? (
            <Button
              size="sm"
              variant={dryRun ? "default" : "destructive"}
              disabled={busy || !formValid}
              onClick={() => void submit()}
            >
              {busy ? "Working…" : dryRun ? "Preview" : "Collect"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- honesty footer --------------------------- */

function HonestyFooter({ report }: { report: ArtifactsExportReport | ArtifactsSearchReport | ArtifactsVerifyReport }) {
  return (
    <div className="flex flex-col gap-0.5">
      {"complete" in report && report.complete === false ? (
        <p className="text-2xs text-warning">
          export truncated — showing {report.returned ?? "?"} of{" "}
          {report.total ?? "?"} artifacts
        </p>
      ) : null}
      {report.orphans.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {report.orphans.length} orphan payload dir
          {report.orphans.length === 1 ? "" : "s"} (no index record):{" "}
          <span className="font-mono">{report.orphans.join(", ")}</span>
        </p>
      ) : null}
      {report.corrupt.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {report.corrupt.length} corrupt index record
          {report.corrupt.length === 1 ? "" : "s"} (failed parsing):{" "}
          <span className="font-mono">{report.corrupt.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------ filter bar ---------------------------- */

interface ArtifactFilters {
  kind: string;
  paneId: string;
  createdBy: string;
}

const EMPTY_FILTERS: ArtifactFilters = { kind: "", paneId: "", createdBy: "" };

function filtersToOptions(filters: ArtifactFilters): ArtifactsReadOptions {
  return {
    ...(filters.kind !== "" ? { kind: filters.kind } : {}),
    ...(filters.paneId.trim() !== "" ? { paneId: filters.paneId.trim() } : {}),
    ...(filters.createdBy !== "" ? { createdBy: filters.createdBy } : {}),
  };
}

function FilterBar({
  filters,
  kinds,
  onChange,
}: {
  filters: ArtifactFilters;
  kinds: readonly string[];
  onChange: (next: ArtifactFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {/* Visible field labels: the selects' "__all__" sentinel values
          read as unlabeled duplicate dropdowns without them, and the
          pane input's placeholder clipped at narrow widths (issue
          #480). SelectValue gets an explicit mapper so the trigger
          never falls back to the raw sentinel when items are
          unmounted. */}
      <span className="flex items-center gap-1 text-2xs text-muted-foreground/70">
        kind
        <Select
          value={filters.kind === "" ? "__all__" : filters.kind}
          onValueChange={(value) =>
            onChange({ ...filters, kind: value === "__all__" ? "" : value })
          }
        >
          <SelectTrigger aria-label="Kind filter" className="w-28">
            <SelectValue>
              {(value) => (value === "__all__" ? "all kinds" : value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">all kinds</SelectItem>
            {kinds.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <span className="flex items-center gap-1 text-2xs text-muted-foreground/70">
        pane
        <Input
          size="sm"
          value={filters.paneId}
          onChange={(e) => onChange({ ...filters, paneId: e.target.value })}
          placeholder="e.g. w1:p1"
          aria-label="Pane filter"
          className="w-28"
        />
      </span>
      <span className="flex items-center gap-1 text-2xs text-muted-foreground/70">
        creator
        <Select
          value={filters.createdBy === "" ? "__all__" : filters.createdBy}
          onValueChange={(value) =>
            onChange({ ...filters, createdBy: value === "__all__" ? "" : value })
          }
        >
          <SelectTrigger aria-label="Created-by filter" className="w-32">
            <SelectValue>
              {(value) => (value === "__all__" ? "any creator" : value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">any creator</SelectItem>
            {CREATED_BY_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </div>
  );
}

/** Debounced filter options so typing does not spam plugin calls. */
function useDebouncedOptions(filters: ArtifactFilters): ArtifactsReadOptions {
  const [options, setOptions] = useState<ArtifactsReadOptions>(() =>
    filtersToOptions(filters),
  );
  useEffect(() => {
    const timer = setTimeout(() => setOptions(filtersToOptions(filters)), 400);
    return () => clearTimeout(timer);
  }, [filters]);
  return options;
}

const filtersActive = (filters: ArtifactFilters) =>
  filters.kind !== "" || filters.paneId.trim() !== "" || filters.createdBy !== "";

/* ---------------------------- registry section ------------------------ */

function RegistrySection({
  machine,
  filters,
  cap,
  refreshNonce,
  onMutated,
  canRegister,
  onRegister,
}: {
  machine: string;
  filters: ArtifactFilters;
  cap: ArtifactsCapability | null | undefined;
  /** Bumped after a mutation so the registry refetches. */
  refreshNonce: number;
  onMutated: () => void;
  /** Empty registry is the normal first-run state — offer Register as
   * the primary action there (issue #480). */
  canRegister: boolean;
  onRegister: () => void;
}) {
  const options = useDebouncedOptions(filters);
  const active = filtersActive(filters);
  const [report, setReport] = useState<ArtifactsExportReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchArtifactsExport(machine, options)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshNonce is the explicit invalidation signal after a mutation; the fetch is keyed on machine + options
  }, [machine, options, refreshNonce]);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Registry{active ? " (filtered)" : ""}
      </h3>
      {loading && report === null ? (
        <p className="text-2xs text-muted-foreground">loading artifacts…</p>
      ) : null}
      {error !== null ? (
        <p className="text-2xs text-destructive">export failed: {error}</p>
      ) : null}
      {report !== null ? (
        <>
          {report.artifacts.length === 0 ? (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-2xs text-muted-foreground">
                {active
                  ? "no artifacts match these filters"
                  : "no artifacts registered — producer plugins may not exist yet; an empty registry is honest, not an error"}
              </p>
              {!active && canRegister ? (
                <Button size="sm" onClick={onRegister}>
                  <PackagePlusIcon />
                  Register artifact…
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {report.artifacts.map((record) => (
                <ArtifactRow
                  key={record.artifact_id}
                  record={record}
                  machine={machine}
                  cap={cap}
                  onMutated={onMutated}
                />
              ))}
            </div>
          )}
          {report.total !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              {report.artifacts.length} of {report.total} artifact
              {report.total === 1 ? "" : "s"}
              {report.session !== null ? ` · session ${report.session}` : ""}
            </p>
          ) : null}
          <HonestyFooter report={report} />
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------- search -------------------------------- */

interface SearchFilters extends ArtifactFilters {
  since: string;
  until: string;
}

function SearchSection({
  machine,
  filters,
  onFiltersChange,
  cap,
  onMutated,
}: {
  machine: string;
  filters: SearchFilters;
  onFiltersChange: (next: SearchFilters) => void;
  cap: ArtifactsCapability | null | undefined;
  onMutated: () => void;
}) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<ArtifactsSearchReport | null>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (q === "" || loading) return;
    setLoading(true);
    setError(null);
    const options: ArtifactsReadOptions & { since?: string; until?: string } = {
      ...filtersToOptions(filters),
    };
    // datetime-local values are local instants; the contract takes ISO.
    if (filters.since !== "") {
      const date = new Date(filters.since);
      if (!Number.isNaN(date.getTime())) options.since = date.toISOString();
    }
    if (filters.until !== "") {
      const date = new Date(filters.until);
      if (!Number.isNaN(date.getTime())) options.until = date.toISOString();
    }
    fetchArtifactsSearch(machine, q, options)
      .then((next) => {
        setReport(next);
        setSearched(q);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine, query, filters, loading]);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Search
      </h3>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <Input
          size="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search artifact metadata…"
          aria-label="Search artifacts"
          className="min-w-40 flex-1"
        />
        {/* Visible from/to labels: two identical datetime fields read
            as a duplicate pair without them (same fix as the Usage
            surface, issue #417; flagged again in #480). */}
        <span className="flex items-center gap-1 text-2xs text-muted-foreground/70">
          from
          <Input
            size="sm"
            type="datetime-local"
            value={filters.since}
            onChange={(e) => onFiltersChange({ ...filters, since: e.target.value })}
            aria-label="Since"
            title="Since (inclusive, created_at)"
          />
        </span>
        <span className="flex items-center gap-1 text-2xs text-muted-foreground/70">
          to
          <Input
            size="sm"
            type="datetime-local"
            value={filters.until}
            onChange={(e) => onFiltersChange({ ...filters, until: e.target.value })}
            aria-label="Until"
            title="Until (inclusive, created_at)"
          />
        </span>
        <Button
          size="sm"
          type="submit"
          variant={loading || query.trim() === "" ? "secondary" : "default"}
          disabled={loading || query.trim() === ""}
        >
          <SearchIcon />
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>
      {error !== null ? (
        <p className="text-2xs text-destructive">search failed: {error}</p>
      ) : null}
      {searched !== null && report !== null ? (
        <div className="flex flex-col gap-1">
          {report.artifacts.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              no artifacts match &quot;{searched}&quot;
            </p>
          ) : (
            <>
              <p className="text-2xs text-muted-foreground/70">
                {report.artifacts.length} of {report.total ?? report.artifacts.length} match
                {report.total !== null && report.artifacts.length < report.total
                  ? " (truncated by limit)"
                  : ""}
              </p>
              {report.artifacts.map((record) => (
                <ArtifactRow
                  key={record.artifact_id}
                  record={record}
                  machine={machine}
                  cap={cap}
                  onMutated={onMutated}
                />
              ))}
            </>
          )}
          <HonestyFooter report={report} />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------- verify -------------------------------- */

function VerifySection({ machine }: { machine: string }) {
  const [report, setReport] = useState<ArtifactsVerifyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runVerify = useCallback(() => {
    if (loading) return;
    setLoading(true);
    setError(null);
    fetchArtifactsVerify(machine)
      .then(setReport)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine, loading]);

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Integrity verify
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={runVerify}
          disabled={loading}
          title="Re-check payload existence, sha256, size, mime and oversize flags (read-only; may hash every payload)"
        >
          <ShieldCheckIcon className={loading ? "animate-pulse" : undefined} />
          {loading ? "Verifying…" : "Verify"}
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground/70">
        read-only health report — ok | corrupt | missing per artifact
      </p>
      {error !== null ? (
        <p className="text-2xs text-destructive">verify failed: {error}</p>
      ) : null}
      {report !== null ? (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <span>
              {report.summary.total ?? report.results.length} checked —{" "}
              <span className="font-medium text-success-foreground">
                {report.summary.ok ?? "?"} ok
              </span>
              ,{" "}
              <span className="font-medium text-destructive-foreground">
                {report.summary.corrupt ?? "?"} corrupt
              </span>
              ,{" "}
              <span className="font-medium text-warning-foreground">
                {report.summary.missing ?? "?"} missing
              </span>
            </span>
          </p>
          {report.results.length === 0 ? (
            <p className="text-2xs text-muted-foreground">no artifacts to verify</p>
          ) : (
            report.results.map((result) => (
              <VerifyRow key={result.artifact_id} result={result} />
            ))
          )}
          <HonestyFooter report={report} />
        </div>
      ) : null}
    </section>
  );
}

function VerifyRow({ result }: { result: ArtifactVerification }) {
  const record = result.artifact;
  const failedChecks = (
    [
      ["payload_exists", result.checks.payload_exists],
      ["sha256_match", result.checks.sha256_match],
      ["size_match", result.checks.size_match],
      ["mime_match", result.checks.mime_match],
    ] as const
  ).filter(([, value]) => value === false);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant={verifyStatusVariant(result.status)}>
          {result.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">
          {result.artifact_id}
        </span>
        {record?.kind != null ? (
          <Badge size="sm" variant={kindBadgeVariant(record.kind)}>
            {record.kind}
          </Badge>
        ) : null}
      </div>
      {result.issues.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          issues: {result.issues.join(", ")}
        </p>
      ) : null}
      {failedChecks.length > 0 ? (
        <p className="text-2xs text-muted-foreground/70">
          failed checks: {failedChecks.map(([name]) => name).join(", ")}
        </p>
      ) : null}
      {record !== null && record.title !== null ? (
        <p className="truncate text-2xs text-muted-foreground/70">{record.title}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function ArtifactsSurface({ machine }: { machine: string }) {
  const state = useArtifactsState(machine);
  const [cap, setCap] = useState<ArtifactsCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<ArtifactFilters>(EMPTY_FILTERS);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    ...EMPTY_FILTERS,
    since: "",
    until: "",
  });
  // Bumped after any successful mutation so the registry section
  // refetches the post-mutation index instead of assuming the result.
  const [mutationNonce, setMutationNonce] = useState(0);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [gcOpen, setGcOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    artifactsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshArtifacts(machine);
  }, [machine, state.status.kind]);

  const kinds =
    cap !== null && cap !== undefined && cap.kinds.length > 0
      ? cap.kinds
      : FALLBACK_KINDS;

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshArtifacts(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const onMutated = useCallback(() => {
    setMutationNonce((n) => n + 1);
    void refreshArtifacts(machine);
  }, [machine]);

  const canRegister = artifactsSupportsMutation(cap, "register") === true;
  const canGc = artifactsSupportsMutation(cap, "gc") === true;

  // The registry filter bar and the search filters share kind/pane/
  // created-by so they read as one control set; search adds its own
  // since/until bounds.
  const onFiltersChange = useCallback((next: ArtifactFilters) => {
    setFilters(next);
    setSearchFilters((prev) => ({ ...prev, ...next }));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        {/* flex-wrap + ml-auto: in a narrow docked panel/sheet the
            action row drops below the intro instead of clipping the
            Refresh button past the right edge (issue #480). */}
        <div className="flex flex-wrap items-start gap-2">
          <p className="min-w-0 flex-1 basis-56 text-2xs text-muted-foreground">
            Artifact registry from the rebuildup.artifacts plugin —
            references to generated files (html/image/pdf/file/other)
            with kind validation and integrity checks. Reads:
            export/search/verify; mutations (register/delete/deliver/gc)
            are offered per host capability behind confirmation dialogs.
            Payloads are never rendered inline — resolved_path is shown
            for external open.
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canRegister ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setRegisterOpen(true)}
                title="Register an existing host file into the artifact registry"
              >
                <PackagePlusIcon />
                Register…
              </Button>
            ) : null}
            {canGc ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setGcOpen(true)}
                title="Collect unreferenced artifacts older than a cutoff (dry-run first)"
              >
                <EraserIcon />
                GC…
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh artifacts"
            >
              <RefreshIcon refreshing={refreshing} />
              Refresh
            </Button>
          </div>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading artifacts…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.report !== null ? " (showing last known registry)" : ""}
          </p>
        ) : null}

        {state.reportError !== null ? (
          <p className="text-2xs text-destructive">export failed: {state.reportError}</p>
        ) : null}

        {state.status.kind === "ready" || state.report !== null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <FilterBar filters={filters} kinds={kinds} onChange={onFiltersChange} />
            </div>
            <RegistrySection
              machine={machine}
              filters={filters}
              cap={cap}
              refreshNonce={mutationNonce}
              onMutated={onMutated}
              canRegister={canRegister}
              onRegister={() => setRegisterOpen(true)}
            />
            <SearchSection
              machine={machine}
              filters={searchFilters}
              onFiltersChange={setSearchFilters}
              cap={cap}
              onMutated={onMutated}
            />
            <VerifySection machine={machine} />
          </div>
        ) : null}
      </DialogPanel>

      {registerOpen ? (
        <RegisterArtifactDialog
          machine={machine}
          kinds={kinds}
          onClose={() => setRegisterOpen(false)}
          onMutated={onMutated}
        />
      ) : null}
      {gcOpen ? (
        <GcArtifactsDialog
          machine={machine}
          onClose={() => setGcOpen(false)}
          onMutated={onMutated}
        />
      ) : null}
    </div>
  );
}

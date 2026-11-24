/*
 * Notice toasts (issue #113): bottom-right transient cards for attention
 * events (agent blocked/done). Auto-dismisses; the action button jumps to
 * the source. Pure presentation over the notices store — herdr state is
 * never mutated here.
 */
import { useEffect } from "react";
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { dismissNotice, useNotices, type Notice } from "./notices";

const VISIBLE_MS = 10_000;

function NoticeCard({ notice }: { notice: Notice }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissNotice(notice.id), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice.id]);

  return (
    <div
      role="status"
      className="animate-notice-in flex w-80 items-start gap-2 rounded-md border border-border bg-popover p-3 text-sm shadow-md"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-popover-foreground">{notice.title}</div>
        {notice.body ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {notice.body}
          </div>
        ) : null}
        {notice.action ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              notice.action?.run();
              dismissNotice(notice.id);
            }}
          >
            {notice.action.label}
          </Button>
        ) : null}
      </div>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Dismiss notification"
        onClick={() => dismissNotice(notice.id)}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

export function NoticeToasts() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {notices.map((notice) => (
        <div key={notice.id} className="pointer-events-auto">
          <NoticeCard notice={notice} />
        </div>
      ))}
    </div>
  );
}

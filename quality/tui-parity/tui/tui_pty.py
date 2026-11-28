#!/usr/bin/env python3
"""Drive the `herdr` TUI inside a pseudo-terminal for GUI-vs-TUI parity checks.

The TUI probes the terminal for capabilities before it draws, so this driver
embeds a small terminal responder that answers DA1/DA2, OSC 10/11/4,
XTGETTCAP, the kitty keyboard query, DSR status and DSR cursor-position.

Protocol (line-delimited JSON on stdin/stdout):

  stdin  {"cmd":"send","data_b64":"..."}   raw bytes into the pty master
         {"cmd":"send_text","text":"..."}   utf-8 text into the pty master
         {"cmd":"resize","rows":30,"cols":100}
         {"cmd":"snapshot"}                 flush all bytes since last snapshot
         {"cmd":"quit"}                     terminate the child and exit
  stdout {"type":"out","seq":N,"ts_ms":F,"data_b64":"..."}
         {"type":"snapshot","seq":N,"ts_ms":F,"data_b64":"..."}
         {"type":"ready","pid":N}
         {"type":"exit","code":N}
         {"type":"error","message":"..."}

`ts_ms` is monotonic milliseconds since the driver started. The `ready` event
is emitted when the TUI produces its first output; `--ready-timeout-ms` bounds
that wait.

Exit codes: 0 clean quit, 2 usage error, 3 ready timeout, 4 spawn failure.

Set `TUI_PTY_NO_RESPONDER=1` to disable the terminal responder (control
experiment: it shows what the TUI does when the terminal never answers).
"""

from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios
import time
from typing import Iterator, Optional

PROMPT = "[tui-parity]"
QUIT = object()  # sentinel: the harness asked us to terminate the child


def log(msg: str) -> None:
    """Write a human-readable log line to stderr."""
    try:
        sys.stderr.write(f"{PROMPT} {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _csi_end(buf: bytes, start: int) -> int:
    """Index just past the end of the CSI sequence starting at `start`."""
    for i in range(start + 2, len(buf)):
        if 0x40 <= buf[i] <= 0x7E:
            return i + 1
    return -1


def _osc_end(buf: bytes, start: int) -> int:
    """Index just past the end of the OSC sequence starting at `start`."""
    for i in range(start + 2, len(buf)):
        if buf[i] == 0x07:  # BEL terminator
            return i + 1
        if buf[i] == 0x1B and i + 1 < len(buf) and buf[i + 1] == 0x5C:  # ST
            return i + 2
    return -1


def scan(buf: bytes) -> Iterator[tuple]:
    """Yield ("text"|"csi"|"osc"|"esc", payload) for complete items in `buf`.

    An incomplete trailing escape sequence is not yielded, so the caller can
    keep it and retry once more bytes arrive.
    """
    i = 0
    n = len(buf)
    while i < n:
        j = buf.find(b"\x1b", i)
        if j < 0:
            yield ("text", buf[i:])
            return
        if j > i:
            yield ("text", buf[i:j])
        if j + 1 >= n:
            return  # incomplete
        nxt = buf[j + 1 : j + 2]
        if nxt == b"[":
            end = _csi_end(buf, j)
            kind = "csi"
        elif nxt in (b"]", b"P"):  # OSC or DCS
            end = _osc_end(buf, j)
            kind = "osc"
        else:
            yield ("esc", buf[j : j + 2])
            i = j + 2
            continue
        if end < 0:
            return  # incomplete
        yield (kind, buf[j:end])
        i = end


class CursorTracker:
    """Minimal cursor position tracker used to answer DSR (CPR) queries.

    Tracks CUP/CUF/CUB/CUU/CNL/CPL/CHA/VPA plus printable characters and
    wrapping at the column width. It is not a full terminal emulator, so
    `--strict-cpr` makes the driver refuse to start when the TUI asks for a
    cursor position we cannot answer reliably.
    """

    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.row = 1  # 1-based
        self.col = 1  # 1-based
        self.buf = b""  # trailing incomplete escape sequence

    def resize(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self._clamp()

    def _clamp(self) -> None:
        self.row = max(1, min(self.rows, self.row))
        self.col = max(1, min(self.cols, self.col))

    def feed(self, data: bytes) -> None:
        """Feed raw TUI output bytes into the tracker."""
        self.buf += data
        consumed = 0
        for kind, payload in scan(self.buf):
            if kind == "text":
                self._text(payload)
            elif kind == "csi":
                self._csi(payload)
            consumed += len(payload)
        # Keep only what the scanner could not consume (an incomplete tail).
        self.buf = self.buf[consumed:]

    def _text(self, data: bytes) -> None:
        for byte in data:
            ch = chr(byte)
            if ch == "\n":
                self.row += 1
                self.col = 1
            elif ch == "\r":
                self.col = 1
            elif ch == "\x08":
                self.col -= 1
            elif ch == "\t":
                self.col = min(self.cols, ((self.col - 1) // 8 + 1) * 8 + 1)
            elif " " <= ch <= "~":
                self.col += 1
                if self.col > self.cols:
                    self.col = 1
                    self.row += 1
            self._clamp()

    def _csi(self, seq: bytes) -> None:
        body = seq[2:-1].decode("latin-1", "replace")
        private = body[:1] in ("?", ">", "<", "=")
        nums = [int(p) if p.isdigit() else 0 for p in body.lstrip("?><!").split(";")]
        count = nums[0] if nums and nums[0] else 1
        final = chr(seq[-1])
        if final in "Hf":
            self.row = nums[0] if nums[0] else 1
            self.col = nums[1] if len(nums) > 1 and nums[1] else 1
        elif final == "C":
            self.col += count
        elif final == "D":
            self.col -= count
        elif final == "A":
            self.row -= count
        elif final == "B":
            self.row += count
        elif final == "E":
            self.row += count
            self.col = 1
        elif final == "F":
            self.row -= count
            self.col = 1
        elif final == "G":
            self.col = count
        elif final == "d":
            self.row = count
        elif private:
            return  # private modes do not move the cursor in our model
        self._clamp()


class Responder:
    """Answers the terminal capability queries found in the TUI output stream."""

    def __init__(self, tracker: CursorTracker, enabled: bool = True, strict_cpr: bool = False) -> None:
        self.tracker = tracker
        self.enabled = enabled
        self.strict_cpr = strict_cpr
        self.buf = b""
        self.cpr_error: Optional[str] = None
        self.reply_count = 0

    def feed(self, data: bytes) -> bytes:
        """Feed output bytes; return the bytes to write back to the pty master."""
        if not self.enabled:
            return b""
        self.buf += data
        replies = b""
        consumed = 0
        for kind, payload in scan(self.buf):
            if kind == "csi":
                reply = self._answer_csi(payload)
            elif kind == "osc":
                reply = self._answer_osc(payload)
            else:
                reply = b""
            consumed += len(payload)
            if reply:
                replies += reply
                self.reply_count += 1
        # Keep only the incomplete tail.
        self.buf = self.buf[consumed:]
        return replies

    def _answer_osc(self, seq: bytes) -> bytes:
        text = seq[2:].rstrip(b"\x07").rstrip(b"\x1b\\").decode("latin-1", "replace")
        if text.startswith("10;?"):
            return b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"
        if text.startswith("11;?"):
            return b"\x1b]11;rgb:0000/0000/0000\x1b\\"
        if text.startswith("4;") and text.endswith("?"):
            try:
                idx = int(text[2:-1].split(";")[0])
            except ValueError:
                return b""
            if 0 <= idx <= 255:
                return f"\x1b]4;{idx};rgb:8080/8080/8080\x1b\\".encode("latin-1")
        return b""

    def _answer_csi(self, seq: bytes) -> bytes:
        """Answer a complete CSI sequence. `seq` includes ESC [ ... final."""
        final = chr(seq[-1])
        body = seq[2:-1].decode("latin-1", "replace")
        if final == "c" and body == "":
            return b"\x1b[?1;2c"  # DA1
        if final == "c" and body == ">":
            return b"\x1b[>0;10;1c"  # DA2
        if final == "u" and body == "?":
            return b"\x1b[?0u"  # XTGETTCAP
        if final == "u" and body == ">7":
            return b"\x1b[?0u"  # kitty keyboard query
        if final == "n" and body == "5":
            return b"\x1b[0n"  # DSR status
        if final == "n" and body == "6":
            if self.strict_cpr:
                self.cpr_error = "CPR query received but --strict-cpr forbids answering"
                return b""
            return f"\x1b[{self.tracker.row};{self.tracker.col}R".encode("latin-1")
        if final == "n" and body.startswith("?"):
            # DECRQM: `CSI ? Ps n` asks whether private mode Ps is set.
            # Answer "mode not recognized" (0) — the TUI treats an
            # unanswered query as a stuck terminal and stops reading
            # input, which is exactly the failure this driver exists to
            # expose.
            try:
                mode = int(body[1:])
            except ValueError:
                return b""
            return f"\x1b[?{mode};0$y".encode("latin-1")
        if final == "p" and "$" in body:
            # DECRQM request form `CSI ? Ps $ p` -> `CSI ? Ps ; Pp $ y`.
            head, _, _ = body.partition("$")
            if head.startswith("?"):
                try:
                    mode = int(head[1:])
                except ValueError:
                    return b""
                return f"\x1b[?{mode};0$y".encode("latin-1")
        return b""


class Driver:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.t0 = time.monotonic()
        self.seq = 0
        self.pid: Optional[int] = None
        self.master_fd: Optional[int] = None
        self.snapshot_buf = bytearray()
        self.tracker: Optional[CursorTracker] = None

    # --- output helpers -------------------------------------------------
    def now_ms(self) -> float:
        return (time.monotonic() - self.t0) * 1000.0

    def emit(self, obj: dict) -> None:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def emit_out(self, data: bytes) -> None:
        self.seq += 1
        self.emit({
            "type": "out",
            "seq": self.seq,
            "ts_ms": round(self.now_ms(), 3),
            "data_b64": base64.b64encode(data).decode("ascii"),
        })
        self.snapshot_buf += data

    def emit_snapshot(self) -> None:
        self.seq += 1
        data = bytes(self.snapshot_buf)
        self.snapshot_buf.clear()
        self.emit({
            "type": "snapshot",
            "seq": self.seq,
            "ts_ms": round(self.now_ms(), 3),
            "data_b64": base64.b64encode(data).decode("ascii"),
        })

    def emit_error(self, message: str) -> None:
        self.emit({"type": "error", "message": message})

    # --- child process --------------------------------------------------
    def _reap(self, pid: int, timeout: float) -> bool:
        """Poll for the child to exit without ever blocking indefinitely."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return True
            if done == pid:
                return True
            time.sleep(0.02)
        return False

    def close_master(self) -> None:
        if self.master_fd is None:
            return
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        self.master_fd = None

    def cleanup(self) -> None:
        """Terminate the child. Never blocks forever, never kills other pids."""
        pid = self.pid
        if pid is None:
            return
        # The TUI keeps running while the pty master stays open (it sits in the
        # terminal "exiting" state), so close the master first to let it exit.
        self.close_master()
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, OSError):
                pass
            if self._reap(pid, 2.0):
                break
        self.pid = None

    # --- main loop ------------------------------------------------------
    def run(self) -> int:
        args = self.args
        tracker = CursorTracker(args.rows, args.cols)
        self.tracker = tracker
        responder = Responder(
            tracker,
            enabled=not os.environ.get("TUI_PTY_NO_RESPONDER"),
            strict_cpr=args.strict_cpr,
        )

        import pty  # local import: only needed on the parent side

        # The exec-error pipe lets the parent distinguish "the binary could not
        # be started" from "the TUI ran and exited".
        err_r, err_w = os.pipe()
        pid, master_fd = pty.fork()
        if pid == 0:  # child
            try:
                os.close(err_r)
                os.execvpe(args.herdr_bin, [args.herdr_bin, "--session", args.session], self._child_env())
            except Exception as exc:  # pragma: no cover - child path
                try:
                    os.write(err_w, f"exec failed: {exc}".encode("utf-8", "replace"))
                except OSError:
                    pass
                os._exit(127)
        os.close(err_w)
        self.pid = pid
        self.master_fd = master_fd
        # Disable echo and canonical mode so our replies to the TUI are never
        # echoed back into the measured output stream.
        try:
            attrs = termios.tcgetattr(master_fd)
            attrs[3] &= ~(termios.ECHO | termios.ECHOE | termios.ECHOK | termios.ECHONL | termios.ICANON)
            termios.tcsetattr(master_fd, termios.TCSANOW, attrs)
        except termios.error:
            pass
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
        log(f"spawned pid={pid}")

        stdin_fd = sys.stdin.fileno()
        os.set_blocking(master_fd, False)
        os.set_blocking(err_r, False)
        deadline = time.monotonic() + args.ready_timeout_ms / 1000.0
        got_first_output = False
        pending_stdin = b""
        reported_replies = 0

        try:
            while True:
                rlist = [master_fd, err_r]
                if stdin_fd >= 0:
                    rlist.append(stdin_fd)
                try:
                    ready, _, _ = select.select(rlist, [], [], 0.05)
                except (OSError, ValueError) as exc:
                    if getattr(exc, "errno", None) == errno.EINTR:
                        continue
                    raise
                if err_r in ready:
                    try:
                        msg = os.read(err_r, 4096)
                    except OSError:
                        msg = b""
                    if msg:
                        self.emit_error(msg.decode("utf-8", "replace").strip())
                        self.cleanup()
                        return 4
                if not got_first_output and time.monotonic() > deadline:
                    self.emit_error("ready timeout: no TUI output received")
                    self.cleanup()
                    return 3
                if master_fd in ready:
                    try:
                        data = os.read(master_fd, 65536)
                    except BlockingIOError:
                        data = b""
                    except OSError as exc:
                        if exc.errno not in (errno.EIO, errno.EBADF):
                            raise
                        data = b""
                    if data:
                        if not got_first_output:
                            got_first_output = True
                            self.emit({"type": "ready", "pid": self.pid, "ts_ms": round(self.now_ms(), 3)})
                            log(f"ready pid={self.pid}")
                        self.emit_out(data)
                        tracker.feed(data)
                        reply = responder.feed(data)
                        if reply:
                            try:
                                os.write(master_fd, reply)
                            except OSError:
                                pass
                        if responder.reply_count != reported_replies:
                            reported_replies = responder.reply_count
                            log(f"responder replied {reported_replies} times")
                        if responder.cpr_error:
                            self.emit_error(responder.cpr_error)
                            self.cleanup()
                            return 3
                if stdin_fd in ready:
                    try:
                        chunk = os.read(stdin_fd, 65536)
                    except BlockingIOError:
                        chunk = b""
                    if chunk:
                        pending_stdin += chunk
                        while b"\n" in pending_stdin:
                            line, pending_stdin = pending_stdin.split(b"\n", 1)
                            rc = self.handle_command(line.strip())
                            if rc is QUIT:
                                self.cleanup()
                                self.emit({"type": "exit", "code": 0})
                                return 0
                    else:
                        stdin_fd = -1  # stdin closed: stop reading commands
                if self.pid is not None:
                    try:
                        done, status = os.waitpid(self.pid, os.WNOHANG)
                    except ChildProcessError:
                        done, status = self.pid, 0
                    if done == self.pid:
                        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
                        self.pid = None
                        self.emit({"type": "exit", "code": code})
                        log(f"child exited code={code}")
                        if not got_first_output:
                            # The child died before drawing anything.
                            self.emit_error(f"child exited before producing output (code={code})")
                            return 4 if code == 127 else 0
                        return 0
        finally:
            self.close_master()

    def _child_env(self) -> dict:
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env.pop("NO_COLOR", None)
        return env

    def handle_command(self, line: bytes):
        """Handle one stdin command. Returns QUIT, an exit code, or None."""
        if not line:
            return None
        try:
            cmd = json.loads(line.decode("utf-8"))
        except Exception as exc:
            self.emit_error(f"bad command json: {exc}")
            return None
        if not isinstance(cmd, dict):
            self.emit_error("command must be a JSON object")
            return None
        kind = cmd.get("cmd")
        master = self.master_fd
        try:
            if kind == "send":
                os.write(master, base64.b64decode(cmd.get("data_b64", "")))
            elif kind == "send_text":
                os.write(master, str(cmd.get("text", "")).encode("utf-8"))
            elif kind == "resize":
                rows = int(cmd.get("rows", self.args.rows))
                cols = int(cmd.get("cols", self.args.cols))
                self.args.rows, self.args.cols = rows, cols
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                if self.pid is not None:
                    os.kill(self.pid, signal.SIGWINCH)
                if self.tracker is not None:
                    self.tracker.resize(rows, cols)
            elif kind == "snapshot":
                self.emit_snapshot()
            elif kind == "quit":
                log("quit requested")
                return QUIT
            else:
                self.emit_error(f"unknown command: {kind!r}")
        except Exception as exc:
            self.emit_error(f"command failed: {exc}")
        return None


def parse_args(argv) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Drive the herdr TUI inside a pty.")
    p.add_argument("--session", default="ht3tui")
    p.add_argument("--rows", type=int, default=30)
    p.add_argument("--cols", type=int, default=100)
    p.add_argument("--herdr-bin", default="herdr")
    p.add_argument("--ready-timeout-ms", type=int, default=10000)
    p.add_argument("--strict-cpr", action="store_true")
    args = p.parse_args(argv)
    if args.rows <= 0 or args.cols <= 0:
        p.error("--rows and --cols must be positive")
    if args.ready_timeout_ms <= 0:
        p.error("--ready-timeout-ms must be positive")
    return args


def main(argv) -> int:
    args = parse_args(argv)
    if args.strict_cpr:
        log("strict CPR mode enabled")
    driver = Driver(args)
    try:
        return driver.run()
    except FileNotFoundError as exc:
        driver.emit_error(f"herdr binary not found: {exc}")
        return 4
    except Exception as exc:  # pragma: no cover - defensive
        driver.emit_error(f"driver failure: {exc}")
        driver.cleanup()
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

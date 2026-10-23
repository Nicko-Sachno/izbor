import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def emit(message):
    print(json.dumps(message), flush=True)


master, slave = pty.openpty()
initial_flags = termios.tcgetattr(slave)[3]


def resize(columns, rows):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


columns, rows, *command = sys.argv[1:]
resize(int(columns), int(rows))
child = subprocess.Popen(
    command,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
)
emit({"type": "ready"})
pending = b""

try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.05)
        if master in readable:
            try:
                output = os.read(master, 65536)
                if output:
                    emit({"type": "output", "data": base64.b64encode(output).decode()})
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if sys.stdin.fileno() in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                message = json.loads(line)
                if message["type"] == "input":
                    os.write(master, base64.b64decode(message["data"]))
                elif message["type"] == "resize":
                    resize(message["columns"], message["rows"])
                    os.kill(child.pid, signal.SIGWINCH)
        if child.poll() is not None:
            while select.select([master], [], [], 0)[0]:
                try:
                    output = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not output:
                    break
                emit({"type": "output", "data": base64.b64encode(output).decode()})
            restored_flags = termios.tcgetattr(master)[3]
            tracked_flags = termios.ICANON | termios.ECHO
            emit(
                {
                    "type": "exit",
                    "code": child.returncode,
                    "modesRestored": (initial_flags & tracked_flags)
                    == (restored_flags & tracked_flags),
                }
            )
            break
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    os.close(master)
    os.close(slave)

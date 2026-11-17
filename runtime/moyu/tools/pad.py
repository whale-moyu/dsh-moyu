"""Send a command to the running padhost (see padhost.py).

Usage:
  python pad.py A            # tap A once
  python pad.py DOWN 3       # tap D-pad down three times
  python pad.py STICK 0.4 0  # push left stick
  python pad.py QUIT         # stop padhost
"""
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
QUEUE = os.path.join(BASE, "pad-queue.txt")
LOG = os.path.join(BASE, "padhost.log")


def main(argv):
    args = argv[1:]
    if not args:
        print("no command")
        return 2
    if not os.path.exists(LOG):
        print("padhost not running (no log)")
        return 3
    line = " ".join(args)
    tmp = QUEUE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(line + "\n")
    os.replace(tmp, QUEUE)
    time.sleep(0.4)
    print(f"queued: {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

"""Persistent virtual Xbox pad host.

Keeps one ViGEmBus pad connected for the whole session and executes commands
written by pad.py into pad-queue.txt.

Run:  pythonw padhost.py     (no console window)
Stop: kill the process / write QUIT into the queue
"""
import os
import sys
import time

import vgamepad as vg

BASE = os.path.dirname(os.path.abspath(__file__))
QUEUE = os.path.join(BASE, "pad-queue.txt")
LOG = os.path.join(BASE, "padhost.log")

BUTTONS = {
    "A": vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
    "B": vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
    "X": vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
    "Y": vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
    "UP": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    "DOWN": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    "LEFT": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    "RIGHT": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
    "START": vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    "BACK": vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
    "LB": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    "RB": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    "LS": vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
    "RS": vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
}


def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


def tap(pad, name, dur=0.09, gap=0.22):
    btn = BUTTONS[name]
    pad.press_button(btn)
    pad.update()
    time.sleep(dur)
    pad.release_button(btn)
    pad.update()
    time.sleep(gap)


def main():
    pad = vg.VX360Gamepad()
    log("pad connected")
    while True:
        try:
            if os.path.exists(QUEUE):
                with open(QUEUE, "r", encoding="utf-8") as f:
                    lines = [ln.strip() for ln in f if ln.strip()]
                os.remove(QUEUE)
                for line in lines:
                    parts = line.upper().split()
                    if parts[0] == "QUIT":
                        log("quit")
                        return 0
                    if parts[0] == "STICK":
                        x = float(parts[1])
                        y = float(parts[2])
                        pad.left_joystick_float(x_value_float=x, y_value_float=y)
                        pad.update()
                        log(f"stick {x},{y}")
                        time.sleep(0.4)
                        pad.left_joystick_float(x_value_float=0.0, y_value_float=0.0)
                        pad.update()
                        continue
                    n = int(parts[1]) if len(parts) > 1 else 1
                    for _ in range(n):
                        tap(pad, parts[0])
                    log(f"{parts[0]} x{n}")
            time.sleep(0.15)
        except Exception as exc:  # keep the pad alive no matter what
            log(f"error {exc}")
            time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())

"""Select a visible Chrome network permission button on the test's private Xvfb."""
import csv
import ctypes
import io
import os
import subprocess
import sys
import time

choice, permission = sys.argv[1:]
assert choice in ("Block", "Allow") and os.environ["HOME"] == "/tmp/qualification-home"
# Read the private virtual display in memory. No screenshot, URL, OTP or record is logged.
deadline = time.monotonic() + 6
while time.monotonic() < deadline:
    # Read the permission bubble in the browser chrome. Page text behind it
    # can otherwise be interleaved with the permission text by full-screen OCR.
    screen = subprocess.check_output(["import", "-window", "root", "-crop", "670x395+0+0", "+repage", "png:-"])
    tsv = subprocess.run(
        ["tesseract", "stdin", "stdout", "--psm", "11", "tsv"], input=screen, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, check=True,
    ).stdout.decode()
    words = [row for row in csv.DictReader(io.StringIO(tsv), delimiter="\t") if row["text"].strip()]
    text = " ".join(row["text"] for row in words).lower()
    buttons = [row for row in words if row["text"] == choice]
    wording = ("other apps" in text and "this device" in text
               if permission == "loopback-network" else "local network" in text)
    if wording and {"Block", "Allow"}.issubset({row["text"] for row in words}) and len(buttons) == 1:
        break
    time.sleep(0.15)
else:
    sys.exit("Native network permission prompt was not recognized")

# Send a real pointer click at the observed button. The browser applies its own
# decision; the caller independently verifies the resulting Permissions API state.
# Chrome ignores input on a prompt it has only just shown, and on an idle machine
# the screen is read sooner than that.
time.sleep(0.7)
button = buttons[0]
x = int(button["left"]) + int(button["width"]) // 2
y = int(button["top"]) + int(button["height"]) // 2
x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
display = ctypes.c_void_p(x11.XOpenDisplay(None))
assert display.value
xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
xtst.XTestFakeButtonEvent(display, 1, True, 0)
xtst.XTestFakeButtonEvent(display, 1, False, 0)
x11.XSync(display, False)
x11.XCloseDisplay(display)

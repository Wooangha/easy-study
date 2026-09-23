"""Generate samples/sample-lecture.pdf — a small synthetic lecture deck used for demos and tests.

Some slides put key information *only inside raster images* (diagrams, Gantt charts) so that
plain text extraction misses it; this demonstrates why easy-study feeds slide images to the LLM.

Usage: uv run --with reportlab --with pillow python scripts/make_sample_pdf.py samples/sample-lecture.pdf
"""

import io
import sys

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

W, H = 960, 540  # 16:9 slide in points
FONT_PATHS = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def pil_font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def to_reader(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return ImageReader(buf)


def process_state_diagram():
    img = Image.new("RGB", (1400, 620), "white")
    d = ImageDraw.Draw(img)
    f = pil_font(40)
    small = pil_font(30)
    boxes = {
        "New": (60, 60),
        "Ready": (420, 260),
        "Running": (820, 260),
        "Terminated": (1120, 60),
        "Waiting": (620, 480),
    }
    for name, (x, y) in boxes.items():
        d.rounded_rectangle([x, y, x + 240, y + 90], radius=24, outline="#1d4ed8", width=5, fill="#eff6ff")
        tw = d.textlength(name, font=f)
        d.text((x + 120 - tw / 2, y + 22), name, fill="#111827", font=f)

    def arrow(p, q, label, lp):
        d.line([p, q], fill="#dc2626", width=5)
        (x1, y1), (x2, y2) = p, q
        import math

        a = math.atan2(y2 - y1, x2 - x1)
        for s in (-0.4, 0.4):
            d.line([q, (x2 - 26 * math.cos(a + s), y2 - 26 * math.sin(a + s))], fill="#dc2626", width=5)
        d.text(lp, label, fill="#991b1b", font=small)

    arrow((300, 110), (440, 260), "admitted", (330, 150))
    arrow((660, 290), (820, 290), "scheduler dispatch", (600, 215))
    arrow((820, 330), (660, 330), "interrupt (quantum expired)", (560, 360))
    arrow((1000, 260), (1160, 150), "exit", (1080, 210))
    arrow((940, 350), (840, 480), "I/O or event wait", (930, 420))
    arrow((620, 520), (540, 350), "I/O done", (430, 450))
    return img


def gantt(segments, total, title):
    img = Image.new("RGB", (1500, 360), "white")
    d = ImageDraw.Draw(img)
    f = pil_font(38)
    small = pil_font(30)
    d.text((40, 20), title, fill="#111827", font=f)
    x0, y0, x1, y1 = 60, 120, 1440, 240
    scale = (x1 - x0) / total
    colors = {"P1": "#fde68a", "P2": "#bbf7d0", "P3": "#bfdbfe", "P4": "#fbcfe8"}
    for name, start, end in segments:
        a, b = x0 + start * scale, x0 + end * scale
        d.rectangle([a, y0, b, y1], fill=colors.get(name, "#e5e7eb"), outline="#111827", width=3)
        tw = d.textlength(name, font=f)
        d.text(((a + b) / 2 - tw / 2, y0 + 38), name, fill="#111827", font=f)
    ticks = sorted({s for _, s, _ in segments} | {e for _, _, e in segments})
    for t in ticks:
        x = x0 + t * scale
        d.line([x, y1, x, y1 + 18], fill="#111827", width=3)
        tw = d.textlength(str(t), font=small)
        d.text((x - tw / 2, y1 + 24), str(t), fill="#111827", font=small)
    return img


def slide(c, title, bullets=(), image=None, img_box=None, footer_no=None, subtitle=None):
    c.setFillColor(HexColor("#0f172a"))
    c.rect(0, H - 80, W, 80, stroke=0, fill=1)
    c.setFillColor(HexColor("#ffffff"))
    c.setFont("Helvetica-Bold", 30)
    c.drawString(40, H - 55, title)
    y = H - 130
    if subtitle:
        c.setFillColor(HexColor("#334155"))
        c.setFont("Helvetica-Oblique", 20)
        c.drawString(40, y, subtitle)
        y -= 40
    c.setFillColor(HexColor("#111827"))
    for b in bullets:
        indent = 40
        size = 22
        if b.startswith("  "):
            indent, size, b = 80, 18, b.strip()
        c.setFont("Helvetica", size)
        c.drawString(indent, y, ("• " if indent == 40 else "– ") + b)
        y -= size + 16
    if image is not None:
        x, yy, w, h = img_box
        c.drawImage(to_reader(image), x, yy, w, h, preserveAspectRatio=True, anchor="c")
    if footer_no:
        c.setFillColor(HexColor("#64748b"))
        c.setFont("Helvetica", 12)
        c.drawRightString(W - 30, 20, f"OS 101 · Lecture 5 · {footer_no}")
    c.showPage()


def main(out):
    c = canvas.Canvas(out, pagesize=(W, H))
    c.setTitle("OS 101 Lecture 5 - CPU Scheduling")

    # 1. Title
    c.setFillColor(HexColor("#0f172a"))
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(HexColor("#ffffff"))
    c.setFont("Helvetica-Bold", 48)
    c.drawCentredString(W / 2, H / 2 + 30, "Lecture 5: CPU Scheduling")
    c.setFont("Helvetica", 24)
    c.drawCentredString(W / 2, H / 2 - 20, "OS 101 · Operating Systems")
    c.showPage()

    slide(c, "Agenda", [
        "Process states and the scheduler",
        "Scheduling criteria",
        "FCFS, SJF, Round Robin",
        "Predicting the next CPU burst",
        "Summary and practice questions",
    ], footer_no=2)

    slide(c, "Process States", ["The scheduler moves processes between states (see diagram)."],
          image=process_state_diagram(), img_box=(60, 40, 840, 380), footer_no=3)

    slide(c, "Scheduling Criteria", [
        "CPU utilization: keep the CPU as busy as possible",
        "Throughput: # of processes completed per time unit",
        "Turnaround time = completion time - arrival time",
        "Waiting time = turnaround time - burst time",
        "Response time: time until the first response is produced",
    ], footer_no=4)

    fcfs = gantt([("P1", 0, 24), ("P2", 24, 27), ("P3", 27, 30)], 30, "FCFS order: P1, P2, P3 (all arrive at t=0)")
    slide(c, "First-Come, First-Served (FCFS)", [
        "Bursts: P1 = 24, P2 = 3, P3 = 3",
        "Average waiting time = (0 + 24 + 27) / 3 = 17",
        "Convoy effect: short processes wait behind a long one",
    ], image=fcfs, img_box=(60, 30, 840, 200), footer_no=5)

    sjf = gantt([("P4", 0, 3), ("P1", 3, 9), ("P3", 9, 16), ("P2", 16, 24)], 24, "SJF (non-preemptive), all arrive at t=0")
    slide(c, "Shortest-Job-First (SJF)", [
        "Pick the process with the smallest next CPU burst",
        "Provably optimal for average waiting time",
        "Problem: we cannot know the next burst length in advance",
    ], image=sjf, img_box=(60, 30, 840, 200), footer_no=6)

    rr = gantt([("P1", 0, 4), ("P2", 4, 7), ("P3", 7, 10), ("P1", 10, 14), ("P1", 14, 18),
                ("P1", 18, 22), ("P1", 22, 26), ("P1", 26, 30)], 30, "Round Robin, time quantum q = ?")
    slide(c, "Round Robin (RR)", [
        "Each process gets a small unit of CPU time (time quantum)",
        "After the quantum expires, the process is preempted to the ready queue",
        "Read the quantum off the Gantt chart below",
    ], image=rr, img_box=(60, 30, 840, 200), footer_no=7)

    slide(c, "Predicting the Next CPU Burst", [
        "Exponential averaging:",
        "  tau(n+1) = alpha * t(n) + (1 - alpha) * tau(n)",
        "  t(n): actual length of the n-th CPU burst",
        "  tau(n+1): predicted value for the next CPU burst",
        "  0 <= alpha <= 1 (commonly alpha = 1/2)",
    ], footer_no=8)

    slide(c, "Summary & Practice", [
        "FCFS is simple but suffers from the convoy effect",
        "SJF minimizes average waiting time but needs burst prediction",
        "RR is fair; performance depends heavily on the quantum size",
        "Q1. Compute the average waiting time for the RR example (slide 7)",
        "Q2. With alpha = 1/2, tau(0) = 10, t(0) = 6: what is tau(1)?",
    ], footer_no=9)

    c.save()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "samples/sample-lecture.pdf")

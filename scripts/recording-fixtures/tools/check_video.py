#!/usr/bin/env python3
"""Verify the slideshow video follows ground_truth.shownTimeline frame-exactly (10 fps).
For every change point tc: frame round(tc*10)-1 must match the previous slide and frame round(tc*10) the new one
(best PSNR among the two candidate slide PNGs). usage: check_video.py <ground_truth.json> <video>"""
import json, os, re, shutil, subprocess, sys, tempfile
DECK = os.path.join(os.environ.get("EASY_STUDY_DECK") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "library", "example-parsing-deck"), "slides")  # the deck build.py used
gt = json.load(open(sys.argv[1])); video = sys.argv[2]; tl = gt["shownTimeline"]
want = {}
for i in range(1, len(tl)):
    k = round(tl[i]["start"] * 10)
    want[k - 1] = (tl[i - 1]["slide"], tl[i]["slide"], tl[i - 1]["slide"])
    want[k] = (tl[i - 1]["slide"], tl[i]["slide"], tl[i]["slide"])
tmp = tempfile.mkdtemp(dir=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_build"))
sel = "+".join(f"eq(n\\,{n})" for n in sorted(want))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", f"select='{sel}'", "-fps_mode", "passthrough",
                "-frame_pts", "1", os.path.join(tmp, "f_%d.png")], check=True)
def psnr(png, slide):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", png, "-i", f"{DECK}/{slide:03d}.png", "-filter_complex",
                        "[1:v]scale=1280:720:flags=lanczos[b];[0:v][b]psnr", "-f", "null", "-"], capture_output=True, text=True)
    return float(re.search(r"average:([\d.]+)", r.stderr).group(1))
ok, bad, margins = 0, [], []
for n, (a, b, exp) in sorted(want.items()):
    p = os.path.join(tmp, f"f_{n}.png")
    pa, pb = psnr(p, a), psnr(p, b)
    got = a if pa > pb else b
    margins.append(abs(pa - pb))
    if got == exp: ok += 1
    else: bad.append({"frame": n, "t": n / 10, "expected": exp, "got": got})
print(json.dumps({"video": video.split("/")[-1], "framesChecked": len(want), "matched": ok, "mismatches": bad,
                  "minPsnrMarginDb": round(min(margins), 1)}))
shutil.rmtree(tmp)

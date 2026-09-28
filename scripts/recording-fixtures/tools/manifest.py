#!/usr/bin/env python3
"""Write manifest.json: every fixture with bytes, sha256, duration and stream info (ffprobe)."""
import hashlib, json, os, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GT = {"ko-mixed": "ko-mixed/ground_truth.json", "en": "en/ground_truth.json", "long": "long/ground_truth.long60.json"}
out = []
for d in ("ko-mixed", "en", "long"):
    for f in sorted(os.listdir(os.path.join(ROOT, d))):
        if f.endswith((".json", ".vtt")):
            continue
        p = os.path.join(ROOT, d, f)
        pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries",
            "format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels,width,height",
            "-of", "json", p], capture_output=True, text=True, check=True).stdout)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        gt = GT[d] if d != "ko-mixed" or ".smoke." not in f else "ko-mixed/ground_truth.smoke.json"
        out.append({"path": f"{d}/{f}", "bytes": os.path.getsize(p), "sha256": h,
                    "duration": round(float(pr["format"]["duration"]), 3), "container": pr["format"]["format_name"],
                    "streams": pr["streams"], "groundTruth": gt})
json.dump({"generated": "tools/build.py", "files": out}, open(os.path.join(ROOT, "manifest.json"), "w"), indent=1)
for o in out:
    print(f'{o["path"]:38s} {o["duration"]:9.3f}s {o["bytes"]/1e6:7.1f} MB')

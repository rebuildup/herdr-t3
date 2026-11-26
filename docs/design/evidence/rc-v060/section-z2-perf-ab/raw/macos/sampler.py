import subprocess, time, datetime, sys, os
out = sys.argv[1]
with open(out, "w") as f:
    f.write("timestamp,cpu_busy_pct,loadavg1\n")
while True:
    try:
        r = subprocess.run(["iostat", "-c", "2"], capture_output=True, text=True, timeout=15)
        lines = [l.split() for l in r.stdout.strip().splitlines() if l.strip()]
        nums = [l for l in lines if len(l) >= 3 and all(x.replace(".", "").replace("-", "").isdigit() for x in l[:3])]
        if nums:
            us, sy, idle = map(float, nums[-1][:3])
            busy = round(100 - idle, 1)
        else:
            busy = -1
        la = round(os.getloadavg()[0], 2)
        ts = datetime.datetime.now().astimezone().isoformat()
        with open(out, "a") as f:
            f.write(f"{ts},{busy},{la}\n")
    except Exception:
        with open(out, "a") as f:
            f.write(f"{datetime.datetime.now().astimezone().isoformat()},-1,err\n")
    time.sleep(1)

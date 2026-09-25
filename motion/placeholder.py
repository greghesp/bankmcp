"""Synthesise a 120 BPM placeholder track (stand-in until the Mixkit song is in place).

Deliberately starts 0.37 s late and runs at 120.4 BPM so the analyser has to find
tempo and downbeat for real rather than assuming them.
"""
import numpy as np, wave, sys

SR = 44100
BPM = 120.4
LEAD = 0.37
BARS = 16
beat = 60 / BPM
n = int(SR * (LEAD + BARS * 4 * beat + 1))
out = np.zeros(n)
rng = np.random.default_rng(7)

def add(sig, t):
    i = int(t * SR)
    j = min(n, i + len(sig))
    out[i:j] += sig[: j - i]

def env(d, a=0.002, r=None):
    t = np.arange(int(d * SR)) / SR
    e = np.minimum(1, t / a)
    return t, e * np.exp(-t / (r or d / 4))

def kick():
    t, e = env(0.35, 0.001, 0.09)
    f = 48 + 90 * np.exp(-t / 0.03)
    return 0.9 * np.sin(2 * np.pi * np.cumsum(f) / SR) * e

def clap():
    t, e = env(0.22, 0.001, 0.05)
    x = rng.standard_normal(len(t))
    x = np.convolve(x, np.ones(6) / 6, 'same') - np.convolve(x, np.ones(40) / 40, 'same')
    return 0.35 * x * e

def hat(open_=False):
    t, e = env(0.12 if open_ else 0.04, 0.0005, 0.03 if open_ else 0.008)
    x = rng.standard_normal(len(t))
    x = x - np.convolve(x, np.ones(4) / 4, 'same')
    return 0.12 * x * e

def tone(freq, d, amp, r=None, harm=(1, .5, .25)):
    t, e = env(d, 0.004, r)
    return amp * e * sum(h * np.sin(2 * np.pi * freq * (k + 1) * t) for k, h in enumerate(harm))

prog = [(45, [57, 60, 64]), (41, [57, 60, 65]), (48, [55, 60, 64]), (43, [55, 59, 62])]  # Am F C G
midi = lambda m: 440 * 2 ** ((m - 69) / 12)
for bar in range(BARS):
    root, chord = prog[bar % 4]
    t0 = LEAD + bar * 4 * beat
    for b in range(4):
        tb = t0 + b * beat
        add(kick(), tb)
        if b in (1, 3) and bar >= 2:
            add(clap(), tb)
        for h in range(2):
            add(hat(open_=(h == 1 and b == 3)), tb + h * beat / 2)
        for e8 in range(2):
            add(tone(midi(root - 12 * (e8 == 0)), beat / 2 * 0.9, 0.28, 0.08, (1, .3)), tb + e8 * beat / 2)
    for m in chord:
        add(tone(midi(m), 4 * beat, 0.07, 1.2, (1, .2)), t0)
    add(tone(midi(chord[-1] + 12), beat * 0.9, 0.05, 0.12), t0)   # a small accent on each downbeat

out = np.tanh(out * 1.1) * 0.8
pcm = (np.stack([out, out], 1) * 32767).astype(np.int16)
path = sys.argv[1] if len(sys.argv) > 1 else 'audio/placeholder_120.wav'
with wave.open(path, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', path)

"""Beat-grid the song with numpy, cut 28 beats starting on a downbeat, and lay UI
sounds on top so each sound's measured peak lands on its visual event.

usage: python3 audio.py <song file> [out_dir]
writes <out_dir>/beats.json and <out_dir>/mix.wav (a seamless loop)
"""
import json, subprocess, sys, wave
import numpy as np
import imageio_ffmpeg

SR = 44100
DESIGN_BPM = 120.0
BEATS = 28

# UI events in design seconds (120 BPM grid) -> sound
EVENTS = [
    (0.50, 'click'), (1.00, 'tick'), (1.50, 'chime'), (2.00, 'tap'), (2.50, 'click'),
    (3.00, 'click'), (3.50, 'grab'), (4.50, 'release'), (5.00, 'tap'), (5.50, 'grab'),
    (6.00, 'thud'), (6.50, 'release'), (7.00, 'tap'), (7.50, 'toggle'), (8.00, 'tap'),
    (8.50, 'click'), (9.00, 'tap'), (9.50, 'tick'), (10.00, 'hover'), (10.50, 'hover'),
    (11.00, 'click'), (11.50, 'key'), (11.75, 'key'), (12.00, 'key'), (12.50, 'click'),
    (13.00, 'pop'), (13.50, 'tap'),
]


def load(path):
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    raw = subprocess.run([ff, '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)


# ---------------------------------------------------------------- analysis
def onset_envelope(mono, n_fft=2048, hop=441):
    """Log-magnitude spectral flux, one value per 10 ms hop. Also returns a low-band flux."""
    win = np.hanning(n_fft)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(mono, (n_fft // 2, n_fft)), n_fft)[::hop]
    mag = np.log1p(100 * np.abs(np.fft.rfft(frames * win, axis=1)))
    flux = np.maximum(0, np.diff(mag, axis=0, prepend=mag[:1]))
    freqs = np.fft.rfftfreq(n_fft, 1 / SR)
    full = flux.sum(1)
    low = flux[:, freqs < 180].sum(1)
    full = full - np.convolve(full, np.ones(50) / 50, 'same')         # remove slow trend
    return np.maximum(full, 0), low, SR / hop


def tempo(env, fps, lo=80, hi=170, prior=120):
    ac = np.correlate(env, env, 'full')[len(env) - 1:]
    lags = np.arange(len(ac))
    bpm = 60 * fps / np.maximum(lags, 1)
    ok = (bpm >= lo) & (bpm <= hi)
    weight = np.exp(-0.5 * (np.log2(bpm / prior) / 0.5) ** 2)     # log-gaussian prior around 120
    score = np.where(ok, ac * weight, -np.inf)
    k = int(np.argmax(score))
    a, b, c = ac[k - 1], ac[k], ac[k + 1]                         # parabolic refinement
    k = k + 0.5 * (a - c) / (a - 2 * b + c)
    return 60 * fps / k


def interp(x, idx):
    return np.interp(idx, np.arange(len(x)), x, right=0)


def refine_period(env, fps, bpm):
    """Grid-search the beat period and phase that put the most onset energy on the grid."""
    best = (-1, None, None)
    for b in np.linspace(bpm * 0.99, bpm * 1.01, 81):
        period = 60 * fps / b
        for ph in np.arange(0, period, 0.25):
            idx = np.arange(ph, len(env), period)
            s = interp(env, idx).sum()
            if s > best[0]:
                best = (s, b, ph)
    return best[1], best[2] / fps


def harmonic_change(mono, beats, beat, n_fft=8192):
    freqs = np.fft.rfftfreq(n_fft, 1 / SR)
    band = (freqs > 150) & (freqs < 2500)
    win = np.hanning(n_fft)

    def spec(t):
        i = int(t * SR)
        x = mono[max(0, i):max(0, i) + n_fft]
        if len(x) < n_fft:
            x = np.pad(x, (0, n_fft - len(x)))
        return np.abs(np.fft.rfft(x * win))[band]

    out = []
    for t in beats:
        a, b = spec(t - beat * 0.9), spec(t + beat * 0.05)
        out.append(1 - a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
    return np.array(out)


def analyse(stereo):
    mono = stereo.mean(1)
    env, low, fps = onset_envelope(mono)
    bpm = tempo(env, fps)
    bpm, phase = refine_period(env, fps, bpm)
    beat = 60 / bpm
    beats = np.arange(phase, len(mono) / SR - beat, beat)
    # snap each beat to the local onset peak (+-30 ms), then refit a straight line
    snapped = []
    for t in beats:
        i0, i1 = int((t - .03) * fps), int((t + .03) * fps) + 1
        i0 = max(i0, 0)
        seg = env[i0:i1]
        snapped.append((i0 + int(np.argmax(seg))) / fps if len(seg) else t)
    n = np.arange(len(beats))
    beat, t0 = np.polyfit(n, np.array(snapped), 1)
    beats = t0 + beat * n
    # sample-accurate: shift the grid by the median offset to the steepest attack near each beat
    sm = np.convolve(np.abs(mono), np.ones(44) / 44, 'same')
    offs = []
    for t in beats:
        i0 = max(0, int((t - .025) * SR)); seg = sm[i0:int((t + .025) * SR)]
        if len(seg) > 2:
            offs.append((i0 + int(np.argmax(np.diff(seg)))) / SR - t)
    beats = beats + float(np.median(offs))
    # downbeat: harmony changes on the bar line, so score each bar position by how much
    # the 150-2500 Hz spectrum after the beat differs from the spectrum before it
    novelty = harmonic_change(mono, beats, beat)
    pos = int(np.argmax([novelty[k::4].mean() for k in range(4)]))
    downbeats = beats[pos::4]
    # start on the downbeat whose 28-beat window has the most energy
    dur = BEATS * beat
    cands = [d for d in downbeats if d + dur <= len(mono) / SR - 0.1]
    rms = [np.sqrt(np.mean(mono[int(d * SR):int((d + dur) * SR)] ** 2)) for d in cands]
    start = float(cands[int(np.argmax(rms))])
    return dict(bpm=60 / beat, beat=beat, start=start, duration=dur, first_beat=float(beats[0]),
                downbeat_position=pos, n_beats=len(beats))


# ---------------------------------------------------------------- UI sounds
rng = np.random.default_rng(3)


def _t(d):
    return np.arange(int(d * SR)) / SR


def _e(t, a, r):
    return np.minimum(1, t / a) * np.exp(-t / r)


def _hp(x, k=3):
    return x - np.convolve(x, np.ones(k) / k, 'same')


def sfx(kind):
    if kind == 'click':
        t = _t(.06); return .55 * _hp(rng.standard_normal(len(t))) * _e(t, .0004, .003) + .5 * np.sin(2 * np.pi * 1850 * t) * _e(t, .0008, .012)
    if kind == 'grab':
        t = _t(.07); return .4 * _hp(rng.standard_normal(len(t))) * _e(t, .0004, .003) + .5 * np.sin(2 * np.pi * 1150 * t) * _e(t, .001, .018)
    if kind == 'release':
        t = _t(.06); return .3 * _hp(rng.standard_normal(len(t))) * _e(t, .0004, .002) + .4 * np.sin(2 * np.pi * 2300 * t) * _e(t, .001, .012)
    if kind == 'toggle':
        t = _t(.09); return .5 * np.sin(2 * np.pi * 950 * t) * _e(t, .001, .02) + .35 * np.sin(2 * np.pi * 1900 * t) * _e(t, .001, .01)
    if kind == 'tick':
        t = _t(.03); return .35 * np.sin(2 * np.pi * 3100 * t) * _e(t, .0005, .006)
    if kind == 'hover':
        t = _t(.03); return .22 * np.sin(2 * np.pi * 2600 * t) * _e(t, .0008, .006)
    if kind == 'key':
        t = _t(.05); x = _hp(rng.standard_normal(len(t)), 5); return .4 * x * _e(t, .0006, .005) + .3 * np.sin(2 * np.pi * 420 * t) * _e(t, .001, .012)
    if kind == 'tap':
        t = _t(.12); return .45 * np.sin(2 * np.pi * (170 + 60 * np.exp(-t / .02)) * t) * _e(t, .002, .035)
    if kind == 'thud':
        t = _t(.2); return .6 * np.sin(2 * np.pi * 95 * t) * _e(t, .003, .06)
    if kind == 'chime':
        t = _t(.7)
        a = .3 * np.sin(2 * np.pi * 1318.5 * t) * _e(t, .002, .18)
        b = np.zeros_like(t); k = int(.07 * SR)
        b[k:] = .3 * np.sin(2 * np.pi * 1975.5 * t[:-k]) * _e(t[:-k], .002, .22)
        return a + b
    if kind == 'pop':
        t = _t(.25); f = 520 + 420 * (1 - np.exp(-t / .025)); return .45 * np.sin(2 * np.pi * np.cumsum(f) / SR) * _e(t, .004, .06)
    raise KeyError(kind)


def peak_index(x):
    """Sample index of the loudest point of the envelope (1 ms max filter)."""
    env = np.abs(x)
    w = max(1, SR // 1000)
    env = np.lib.stride_tricks.sliding_window_view(np.pad(env, (0, w - 1)), w).max(1)
    return int(np.argmax(env))


# ---------------------------------------------------------------- mix
def main():
    song, out = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'audio')
    stereo = load(song)
    info = analyse(stereo)
    beat, start, dur = info['beat'], info['start'], info['duration']
    n = int(round(dur * SR))
    xf = int(0.04 * SR)
    i0 = int(round(start * SR))
    seg = stereo[i0:i0 + n + xf].copy()
    loop = seg[:n].copy()
    ramp = np.linspace(0, 1, xf)[:, None]
    loop[:xf] = loop[:xf] * ramp + seg[n:n + xf] * (1 - ramp)      # fold the tail into the head
    loop *= 0.72
    scale = DESIGN_BPM * beat / 60                                 # design seconds -> song seconds
    placed = []
    fx = np.zeros(n)
    for t_design, kind in EVENTS:
        s = sfx(kind)
        pk = peak_index(s)
        at = int(round(t_design * scale * SR)) - pk
        idx = (np.arange(len(s)) + at) % n                         # wrap so the loop stays seamless
        np.add.at(fx, idx, s)
        placed.append(dict(t=t_design, video_t=round(t_design * scale, 4), sound=kind, peak_ms=round(1000 * pk / SR, 2)))
    mix = np.tanh((loop + 0.55 * fx[:, None]) * 1.05)
    with wave.open(f'{out}/mix.wav', 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())
    info.update(song=song, sounds=placed, time_scale=scale)
    json.dump(info, open(f'{out}/beats.json', 'w'), indent=1)
    print(json.dumps({k: v for k, v in info.items() if k != 'sounds'}, indent=1))


if __name__ == '__main__':
    main()

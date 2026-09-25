"""Build a single-file, playable page from index.html: the animation scaled to fit,
the loop's audio (gapless WAV, played through Web Audio) and a beat-grid transport.

usage: python3 player/build.py [out.html]
"""
import base64, json, re, subprocess, sys
from pathlib import Path
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / 'index.html').read_text()
style = re.search(r'<style>(.*?)</style>', src, re.S).group(1)
markup = re.search(r'<body>(.*?)<script>', src, re.S).group(1)
script = re.search(r'<script>(.*?)</script>', src, re.S).group(1)

font = base64.b64encode((ROOT / 'fonts/Geist-Variable.woff2').read_bytes()).decode()
style = style.replace('url(fonts/Geist-Variable.woff2)', f'url(data:font/woff2;base64,{font})')
# the animation owned <body>; scope it to the frame instead
style = re.sub(r'html, body \{[^}]*\}', '#frame { position: absolute; left: 0; top: 0; width: 1440px; height: 1440px; overflow: hidden; background: var(--canvas); transform-origin: 0 0; }', style)
style = re.sub(r'\nbody \{', '\n#frame {', style)
style = style.replace(':root { --canvas: #ECE9E4; }', '#frame { --canvas: #ECE9E4; }')

wav = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-i', str(ROOT / 'audio/mix.wav'),
                      '-ac', '1', '-ar', '32000', '-f', 'wav', '-'], check=True, capture_output=True).stdout
audio = base64.b64encode(wav).decode()
info = json.loads((ROOT / 'audio/beats.json').read_text())

page = (Path(__file__).parent / 'template.html').read_text()
page = (page.replace('/*ANIM_STYLE*/', style).replace('<!--ANIM_MARKUP-->', markup)
            .replace('/*ANIM_SCRIPT*/', script).replace('__AUDIO__', audio)
            .replace('__AUDIO_DUR__', repr(info['duration'])).replace('__BPM__', f"{info['bpm']:.1f}"))
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'out/player.html'
out.write_text(page)
print(out, f'{len(page) / 1e6:.2f} MB')

"""Build inspectable comparison sheets without changing any captured image."""
from PIL import Image, ImageChops, ImageDraw
from pathlib import Path
import sys
root = Path(sys.argv[1] if len(sys.argv) > 1 else 'qa-results/corpus-visual-20261025')
cols = [('original.png', 'Original LaTeX'), ('preserved.png', 'MCP preview / snap OFF'),
        ('preserved-export.png', 'Export LaTeX / snap OFF'), ('snapped.png', 'MCP preview / snap ON'),
        ('snapped-export.png', 'Export LaTeX / snap ON')]
for directory in sorted(p for p in root.iterdir() if p.is_dir() and p.name[:2].isdigit()):
    sheet = Image.new('RGB', (2500, 560), '#eeeeee')
    draw = ImageDraw.Draw(sheet)
    for j, (name, title) in enumerate(cols):
        draw.text((j*500+12, 12), directory.name+' | '+title, fill='black')
        source = directory / name
        if not source.exists():
            continue
        im = Image.open(source).convert('RGB')
        bounds = ImageChops.difference(im, Image.new('RGB', im.size, 'white')).getbbox()
        if bounds:
            im = im.crop((max(0, bounds[0]-10), max(0, bounds[1]-10),
                          min(im.width, bounds[2]+10), min(im.height, bounds[3]+10)))
        ratio = min(476/im.width, 490/im.height)
        im = im.resize((round(im.width*ratio), round(im.height*ratio)), Image.Resampling.LANCZOS)
        sheet.paste(im, (j*500+(500-im.width)//2, 45+(490-im.height)//2))
    sheet.save(directory / 'comparison.png')

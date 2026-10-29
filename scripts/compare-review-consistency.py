from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
import json, sys, html

root=Path(sys.argv[1])
manifest=json.loads((root/'results.json').read_text(encoding='utf-8'))
rows=[]
for sample in manifest['samples']:
    folder=root/sample['id']
    sheet=Image.new('RGB',(1800,530),'#eeeeee')
    draw=ImageDraw.Draw(sheet)
    for col,(filename,title) in enumerate([('original.png','Original XeLaTeX'),('preview.png','MCP preview'),('export.png','Export XeLaTeX')]):
        draw.text((col*600+10,10),sample['id']+' | '+title,fill='black')
        p=folder/filename
        if not p.exists():
            draw.text((col*600+10,45),'Missing / compilation failed',fill='red');continue
        im=Image.open(p).convert('RGB')
        box=ImageChops.difference(im,Image.new('RGB',im.size,'white')).getbbox()
        if box: im=im.crop((max(0,box[0]-8),max(0,box[1]-8),min(im.width,box[2]+8),min(im.height,box[3]+8)))
        im.thumbnail((578,475),Image.Resampling.LANCZOS)
        sheet.paste(im,(col*600+(600-im.width)//2,35+(475-im.height)//2))
    sheet.save(folder/'comparison.png')
    rows.append(sheet)
for start in range(0,len(rows),4):
    montage=Image.new('RGB',(1800,530*len(rows[start:start+4])),'white')
    for i,row in enumerate(rows[start:start+4]):montage.paste(row,(0,i*530))
    montage.save(root/f'overview-{start//4+1:02}.png')
parts=['<!doctype html><meta charset="utf-8"><title>电机学导入一致性</title><style>body{font:16px sans-serif;margin:24px}img{width:100%;border:1px solid #ccc}section{margin:32px 0}</style><h1>电机学导入一致性</h1><p>从左到右：原代码 XeLaTeX 编译、MCP 预览、导出后 XeLaTeX 编译。关闭网格吸附。各列独立缩放，不用于比较绝对尺寸。</p>']
for s in manifest['samples']:
    parts.append(f'<section><h2>{html.escape(s["id"])}</h2><p>{html.escape(s["file"])}:{s["line"]} strict={s.get("strictAccepted")} objects={s.get("componentCount")}</p><pre>{html.escape(chr(10).join(s.get("warnings",[])))}</pre><img loading="lazy" src="{s["id"]}/comparison.png"></section>')
(root/'index.html').write_text(''.join(parts),encoding='utf-8')
print(f'{len(rows)} comparison sheets, {(len(rows)+3)//4} overviews')

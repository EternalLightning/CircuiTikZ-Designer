"""Inspect actual compiled PDFs and render reproducible editor/PDF comparisons."""
import json
from pathlib import Path
import pdfplumber
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'qa-results' / 'text-layout'
data = json.loads((OUT / 'results.json').read_text(encoding='utf8'))
reports = {}
for size in ('10', '12', 'plain-10', 'plain-12'):
    report = []
    with pdfplumber.open(OUT / f'compiled-{size}pt.pdf') as pdf:
        assert len(pdf.pages) == len(data['results'])
        for result, page in zip(data['results'], pdf.pages):
            chars = page.chars
            spec = result['spec']
            record = {'id':spec['id'], 'page':page.page_number,
                      'pageSize':[page.width, page.height],
                      'previewLines':sorted(set(round(s['localY'], 4) for s in result['spans'])),
                      'compiledText':page.extract_text()}
            if chars and result['spans']:
                first = chars[0]
                # PDF user units are bp; the editor uses CSS px (96 per inch).
                px = (first['matrix'][4] - page.width / 2) * 4 / 3
                py = (page.height / 2 - first['matrix'][5]) * 4 / 3
                s = result['spans'][0]
                record.update(previewFirstBaseline=[s['x'],s['y']],
                              compiledFirstBaseline=[px,py],
                              firstBaselineDelta=[px-s['x'], py-s['y']],
                              compiledFirstFontBp=first['size'])
            if spec['rotation'] == 0:
                record['compiledBaselinesPx'] = sorted(set(round((page.height/2-c['matrix'][5])*4/3,4) for c in chars))
            if spec['id'] == 'justify-short':
                record['previewWords']=[{'text':s['text'],'x':s['x']} for s in result['spans']]
                record['compiledWords']=[{'text':w['text'],'x':(w['x0']-page.width/2)*4/3} for w in page.extract_words()]
            report.append(record)
    reports[str(size)] = report
    pdf = pdfium.PdfDocument(OUT / f'compiled-{size}pt.pdf')
    for i, result in enumerate(data['results']):
        bitmap = pdf[i].render(scale=8/3)
        bitmap.to_pil().convert('RGB').save(OUT / f"{result['spec']['id']}-compiled-{size}pt.png")
    pdf.close()

(OUT / 'measurements.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf8')

font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 23)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
selected = [('align-0--1', 'Single line, top left'),
            ('multiline-top', 'Three explicit lines'),
            ('justify-short', 'Justified short final line'),
            ('hyphen-off', 'Hyphenation disabled'),
            ('font-Huge', 'Large font with automatic line wrapping'),
            ('overflow-width', 'Padding exceeds the box width')]
sheet = Image.new('RGB',(1472,len(selected)*390+56),'#e7edf2')
draw = ImageDraw.Draw(sheet)
draw.text((20,12),'Editor preview',font=font,fill='#193040')
draw.text((752,12),'Compiled LaTeX (10pt)',font=font,fill='#193040')
for row, (case, title) in enumerate(selected):
    y = 56 + row*390
    draw.rounded_rectangle((12,y,1460,y+378),radius=9,fill='white')
    draw.text((26,y+9),title,font=font,fill='#193040')
    for col, suffix in enumerate(('preview','compiled-plain-10pt')):
        im=Image.open(OUT / f'{case}-{suffix}.png').convert('RGB')
        im=im.crop((120,88,600,374)).resize((696,318))
        sheet.paste(im,(20+col*732,y+43))
sheet.save(OUT/'comparison.png')

size_sheet=Image.new('RGB',(1472,870),'#e7edf2')
draw=ImageDraw.Draw(size_sheet)
draw.text((20,12),'Editor preview (fixed 10pt)',font=font,fill='#193040')
draw.text((752,12),'Same export in a 12pt document',font=font,fill='#193040')
for row,case in enumerate(('align-0--1','wrap-left')):
    y=56+row*400
    for col,suffix in enumerate(('preview','compiled-plain-12pt')):
        im=Image.open(OUT/f'{case}-{suffix}.png').convert('RGB').crop((120,60,600,390)).resize((696,360))
        size_sheet.paste(im,(20+col*732,y))
size_sheet.save(OUT/'document-font-size.png')

zhfont=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',24)
key_sheet=Image.new('RGB',(1472,870),'#e7edf2')
draw=ImageDraw.Draw(key_sheet)
draw.text((20,10),'画布预览',font=zhfont,fill='#193040')
draw.text((752,10),'实际编译结果（10pt 文档）',font=zhfont,fill='#193040')
for row,(case,title) in enumerate((('justify-short','两端对齐：最后一行的单词位置不同'),
                                   ('font-Huge','大字号自动换行：第二行高度不同'))):
    y=54+row*400
    draw.rounded_rectangle((12,y,1460,y+388),radius=9,fill='white')
    draw.text((26,y+8),title,font=zhfont,fill='#193040')
    for col,suffix in enumerate(('preview','compiled-plain-10pt')):
        im=Image.open(OUT/f'{case}-{suffix}.png').convert('RGB').crop((120,60,600,390)).resize((696,330))
        key_sheet.paste(im,(20+col*732,y+46))
key_sheet.save(OUT/'key-comparison.png')

for key, rows in reports.items():
    print(f'DOCUMENT {key}pt')
    for r in rows:
        print(json.dumps({k:r[k] for k in ('id','firstBaselineDelta','previewLines','compiledBaselinesPx') if k in r},ensure_ascii=True))

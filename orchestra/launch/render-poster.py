"""Deterministic typography/score artwork, without AI or external render service."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
fonts = Path('/System/Library/Fonts/Supplemental')
image=Image.new('RGB',(1200,630),'#0d0b09'); draw=ImageDraw.Draw(image)
def text(x,y,value,size,color='#f4ead8',serif=False):
    font=ImageFont.truetype(str(fonts/('Georgia.ttf' if serif else 'Arial.ttf')),size)
    draw.text((x,y),value,font=font,fill=color,anchor='ls')
text(64,76,'AGENT ORCHESTRA',22,'#e8b65a')
text(64,200,'Bugünkü çalışmanın',76,serif=True)
text(64,288,'bir sesi var.',76,'#e8b65a',True)
for y in (380,405,430,455,480):draw.line((64,y,1136,y),fill='#40382e')
for x,y in ((180,430),(380,405),(590,455),(800,380),(1010,405)):
    draw.ellipse((x-12,y-8,x+12,y+8),fill='#e8b65a');draw.line((x+11,y,x+11,y-72),fill='#e8b65a',width=2)
text(64,546,'Kendi sesini keşfet → Orkestraya katıl → Anını paylaş',22,'#b5a794')
text(64,592,'DijitalPi tarafından geliştirildi',18,'#b5a794')
text(950,592,'Canlı çalışma sesleri',18,'#b5a794')
root=Path(__file__).resolve().parents[1]
image.save(root/'web/og.png');image.save(root/'launch/poster.png')

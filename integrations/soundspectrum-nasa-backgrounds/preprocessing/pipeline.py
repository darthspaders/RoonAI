"""Offline catalog preparation. Original sources and native rendering stay separate."""
import argparse, hashlib, json, os, warnings
from pathlib import Path
import numpy as np
import cv2
from PIL import Image, ImageOps
from masks import detect, SIZE, NAMES, GAINS
from curated import layers_for
from worker import environment

VERSION = 'catalog-conservative-1'
Image.MAX_IMAGE_PIXELS = 80_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def receipt(folder, name, data):
    temporary = folder/(name+'.tmp')
    temporary.write_text(json.dumps(data, indent=2)+'\n', encoding='utf8')
    os.replace(temporary, folder/name)
    return data

def prepare(folder):
    with Image.open(folder/'download.bin') as im:
        if im.format not in ('JPEG','PNG'): raise ValueError('unsupported_format')
        im.load()
        image=ImageOps.exif_transpose(im).convert('RGB')
    w,h=image.size
    if max(w,h)<3840 or min(w,h)<2160: raise ValueError('insufficient_resolution')
    original=[w,h]
    image.thumbnail((6144,6144),Image.Resampling.LANCZOS)
    if image.width*image.height>24_000_000:
        factor=(24_000_000/(image.width*image.height))**.5
        image=image.resize((int(image.width*factor),int(image.height*factor)),Image.Resampling.LANCZOS)
    image.save(folder/'source.jpg',quality=95,subsampling=0)
    # Crop only a small edge margin. Preserve the entire subject for other ratios.
    ratio=image.width/image.height
    compatibility=min(ratio/(16/9),(16/9)/ratio)
    if compatibility>=.96 and image.width>=3840 and image.height>=2160:
        presentation=ImageOps.fit(image,(3840,2160),Image.Resampling.LANCZOS)
        strategy='center-crop-under-4-percent'
    else:
        fitted=ImageOps.contain(image,(3840,2160),Image.Resampling.LANCZOS)
        presentation=Image.new('RGB',(3840,2160));presentation.paste(fitted,((3840-fitted.width)//2,(2160-fitted.height)//2))
        strategy='contain-preserve-subject'
    presentation.save(folder/'background-4k.jpg',quality=94,subsampling=0)
    thumb=np.asarray(presentation.resize((17,16)).convert('L'));bits=thumb[:,:-1]>thumb[:,1:]
    perceptual=''.join(f'{int("".join("1" if b else "0" for b in row),2):04x}' for row in bits)
    lum=np.asarray(presentation.resize((960,540)).convert('L'),np.float32)/255
    detail=float(np.std(cv2.Laplacian(lum,cv2.CV_32F)))
    return receipt(folder,'prepared.json',dict(version=VERSION,sourceDimensions=original,retainedDimensions=list(image.size),
        sourceAspectRatio=w/h,fit=strategy,perceptualHash=perceptual,fileType='JPEG',detailScore=detail,contrast=float(np.std(lum)),
        files={n:digest(folder/n) for n in ('source.jpg','background-4k.jpg')}))

def masks(folder, image_id):
    dependencies=environment()
    with Image.open(folder/'background-4k.jpg') as im:
        if im.size!=(3840,2160): raise ValueError('invalid_presentation')
        picture=im.convert('RGB').resize(SIZE,Image.Resampling.LANCZOS)
    rgb=np.asarray(picture,np.float32)/255
    generated,stars,quality=detect(rgb)
    profiles=json.loads((Path(__file__).parent/'curated-profiles.json').read_text())
    sha=digest(folder/'background-4k.jpg')
    profile=profiles.get(image_id)
    reviewed=False;reason='automatic high-confidence stellar cores; diffuse regions withheld without source-bound review'
    if profile and profile['sourceSha256']==sha:
        found=sorted(stars,key=lambda p:p['flux'],reverse=True)[:32]
        chosen=[]
        for xy in profile['stars']:
            p=next((p for p in found if [p['x'],p['y']]==xy),None)
            if p is None: raise ValueError('reviewed_star_changed')
            chosen.append(p)
        generated=layers_for(rgb,chosen,profile['regions']);stars=chosen;reviewed=True;reason=profile['reason']
    elif image_id=='nasa-science-904703' and sha=='da7cf9e36fad99e0df3470c979e8824dc0e7bee100349fd2c59c8f8eda5c72e9':
        reviewed=True;reason='existing source-bound Cosmic Cliffs review'
    else:
        meta=json.loads((folder/'input.json').read_text(encoding='utf8'))
        # Compact galaxy nuclei, planetary features and cloud knots are ambiguous.
        forbidden=any(s in (meta.get('title','')+' '+meta.get('description','')).lower() for s in ('galaxy','galaxies','deep field','jupiter','saturn','planetary surface'))
        stars=[] if forbidden or quality.get('pre_cap',0)>600 else [p for p in stars if p['confidence']>=.94 and p['radial']==1 and p['axis_ratio']>=.8 and p['curvature']>=.65 and p['contrast']>=.6 and p['diameter']>=3][:24]
        generated=layers_for(rgb,stars,[])
        if not stars: reason='static fallback: no trustworthy automatic stellar/diffuse separation'
    delta=sum(rgb*(1-rgb)*m[:,:,None]*g for m,g in zip(generated,GAINS))
    if not np.isfinite(delta).all() or delta.max()>.03001: raise ValueError('emission_budget_failed')
    names=('stars-small-mask.png','stars-medium-mask.png','stars-bright-mask.png','nebula-mask.png')
    files={}
    for name,alpha,channel in zip(names,generated,NAMES):
        Image.fromarray(np.uint8(np.clip(alpha,0,1)*255)).save(folder/name)
        emission='reactive-'+channel+'.png'
        Image.fromarray(np.uint8(rgb*(1-rgb)*alpha[:,:,None]*255)).save(folder/emission)
        for n in (name,emission): files[n]=digest(folder/n)
    active=any(float(m.max())>.005 for m in generated)
    quality=dict(status='reactive' if active else 'static',reviewed=reviewed,reason=reason,
        stars=len(stars),groups={n:sum(p['group']==n for p in stars) for n in NAMES[:3]},
        cloudMean=float(generated[3].mean()),maxDelta8bit=float(delta.max()*255))
    # Compact offline review sheet, never loaded by WhiteCap.
    sheet=Image.new('RGB',(960,810));sheet.paste(picture.resize((960,540)),(0,0))
    for i,m in enumerate(generated): sheet.paste(Image.fromarray(np.uint8(m*255)).convert('RGB').resize((240,270)),(i*240,540))
    sheet.save(folder/'review.jpg',quality=90)
    return receipt(folder,'masks.json',dict(version=VERSION,sourceSha256=sha,quality=quality,stars=stars,files=files,dependencies=dependencies,
        algorithmHashes={n:digest(Path(__file__).parent/n) for n in ('pipeline.py','masks.py','curated.py','curated-profiles.json','requirements.txt')}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','masks']);p.add_argument('folder');p.add_argument('id');a=p.parse_args()
    cv2.setNumThreads(2)
    print(json.dumps(prepare(Path(a.folder)) if a.action=='prepare' else masks(Path(a.folder),a.id)))

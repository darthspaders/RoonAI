"""Full 4K recomposition and bounded mesh sweep against the existing catalog."""
import hashlib,json,math,pathlib
import cv2,numpy as np
from PIL import Image
here=pathlib.Path(__file__).resolve().parent;root=here.parents[2]
work=root/'data/nasa-whitecap/layer-pilot';library=root/'data/nasa-whitecap/library'
plan=json.loads((here/'plan.json').read_text());results=[]
for cfg in plan['images']:
    p=work/(cfg['id']+'-'+cfg['sha256'][:12]);receipt=json.loads((p/'candidate.json').read_text())
    source=library/(cfg['sha256']+'.jpg')
    with source.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==cfg['sha256']
    for member,sha in receipt['files'].items():
        with (p/member).open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==sha
    src=np.array(Image.open(source).convert('RGB'))
    bg=np.array(Image.open(p/'background.png')).astype('float32')
    fg=np.array(Image.open(p/'cloud-rgba.png')).astype('float32')
    stars=np.array(Image.open(p/'stellar.png')).astype('float32')
    assert bg.shape==src.shape==stars.shape and fg.shape==(2160,3840,4)
    alpha=fg[:,:,3:4]/255
    rebuilt=np.round(bg*(1-alpha)+fg[:,:,:3]*alpha+stars).clip(0,255).astype('uint8')
    error=np.abs(rebuilt.astype('int16')-src.astype('int16'))
    assert not error.any(), 'Neutral reconstruction is not source exact'
    x0,y0,x1,y1=receipt['contentBox']
    mask=np.array(Image.open(p/'cloud-mask.png'))
    sky=mask==0
    assert np.array_equal(bg[y0:y1,x0:x1][sky].astype('uint8'),src[y0:y1,x0:x1][sky])
    assert not stars[y0:y1,x0:x1][sky].any(), 'Sky galaxies must not become a stellar overlay'
    cols,rows,weights=receipt['grid'];weights=np.array(weights).reshape(rows,cols)
    y,x=np.mgrid[:rows,:cols];x=x/(cols-1);y=y/(rows-1)
    minimum=1.;maximum=0.
    # Independent phases span more than the renderer's single time trajectory.
    for px in np.linspace(0,2*math.pi,24,endpoint=False):
        for py in np.linspace(0,2*math.pi,24,endpoint=False):
            dx=cfg['maxMotionPixels'][0]*weights*np.sin(px+y*5+x*2)
            dy=cfg['maxMotionPixels'][1]*weights*np.sin(py-x*4+y*2)
            maximum=max(maximum,float(np.sqrt(dx*dx+dy*dy).max()))
            vx=x*3840+dx;vy=y*2160+dy
            a=np.stack((vx[:-1,:-1],vy[:-1,:-1]),-1)
            b=np.stack((vx[:-1,1:],vy[:-1,1:]),-1)
            c=np.stack((vx[1:,:-1],vy[1:,:-1]),-1)
            d=np.stack((vx[1:,1:],vy[1:,1:]),-1)
            area1=np.cross(b-a,c-a);area2=np.cross(d-b,c-b)
            relative=min(float(area1.min()),float(area2.min()))/((3840/(cols-1))*(2160/(rows-1)))
            assert relative>.2, 'Mesh fold or excessive compression'
            minimum=min(minimum,relative)
            assert not dx[[0,-1],:].any() and not dy[:,[0,-1]].any()
    if not cfg['cloud']: assert not stars.any() and not alpha.any() and maximum==0
    result={'imageId':cfg['id'],'fullFrameNeutralMaxError':int(error.max()),'skyPixelsPreserved':int(sky.sum()),
            'motionSweepCases':576,'minimumTriangleAreaRatio':round(minimum,5),'maximumDisplacementPixels':round(maximum,3),
            'controlStatic':not cfg['cloud'],'files':receipt['files']}
    results.append(result);print(json.dumps({k:v for k,v in result.items() if k!='files'}))
(work/'asset-verification.json').write_text(json.dumps(results,indent=2)+'\n')

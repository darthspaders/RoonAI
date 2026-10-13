"""Conservative display-image masks. No rendering, network, or live audio code.

Coordinates and apparent flux/size describe tone-mapped RGB pixels, not physical
stellar measurements. False negatives are deliberately preferable to cloud flicker.
"""
import collections
import math
import warnings
import cv2
import numpy as np
from astropy.stats import SigmaClip
from photutils.background import Background2D, MedianBackground
from photutils.detection import DAOStarFinder

VERSION = 'conservative-1'
SIZE = (1920, 1080)
NAMES = ('small', 'medium', 'large', 'cloud')  # existing renderer channel names
GAINS = (.12, .09, .055, .045)  # reference only; renderer is unchanged
PARAMETERS = dict(fwhm=[2.5, 5., 9., 15.], threshold_floor=.16, noise_multiple=6.,
                  peak_min=.65, contrast_min=.26, min_flux=3.5,
                  max_stars=180, min_stars=12, spacing=18., cloud_gain=.50,
                  core_color_floor=.60, core_color_spread=.35)

def blur(a, sigma):
    return cv2.GaussianBlur(a, (0, 0), sigma)

def measure(lum, smooth, x, y):
    """Reject ridges/elongated cores before selecting artistic response classes."""
    x, y = int(round(x)), int(round(y))
    h, w = lum.shape
    if min(x, y, w-1-x, h-1-y) < 28:
        return None, 'border'
    # A subpixel Gaussian centroid may lie beside a saturated core. Recenter only
    # within three pixels; never jump to another distant peak.
    cut = smooth[y-3:y+4, x-3:x+4]
    dy, dx = np.unravel_index(np.argmax(cut), cut.shape)
    x, y = x+int(dx)-3, y+int(dy)-3
    peak = float(smooth[y, x])
    if peak < PARAMETERS['peak_min']:
        return None, 'dim'
    yy, xx = np.mgrid[-24:25, -24:25]
    rr = np.hypot(xx, yy)
    patch = smooth[y-24:y+25, x-24:x+25]
    base = float(np.median(patch[(rr>=18)&(rr<=24)]))
    contrast = peak-base
    if contrast < PARAMETERS['contrast_min']:
        return None, 'low_contrast'
    signal = np.maximum(patch-base, 0)
    binary = (signal >= contrast*.80).astype(np.uint8)
    # Remove one-pixel spike connections from broad cores, without eroding tiny stars.
    if binary[22:27,22:27].sum()>=20:
        binary=cv2.morphologyEx(binary,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(3,3)))
    _, labels = cv2.connectedComponents(binary)
    label = labels[24, 24]
    if not label:
        return None, 'no_core'
    core = labels == label
    sy, sx = np.nonzero(core)
    if len(sx)<3 or len(sx)>400 or np.max(np.hypot(sx-24,sy-24))>=20:
        return None, 'core_size'
    covariance = np.cov(np.stack([sx, sy]))
    axes = np.linalg.eigvalsh(covariance)
    axis_ratio = float(axes[0]/max(axes[1], .001))
    if axis_ratio < .48:
        return None, 'elongated_core'
    diameter = float(2*np.sqrt(len(sx)/np.pi))
    # Radial contrast around almost the entire core: a cloud edge cannot pass
    # just because one side drops into a dark dust lane.
    radius = float(np.clip(diameter*1.7, 5, 23))
    angles = np.arange(24)*2*np.pi/24
    ring = smooth[np.rint(y+radius*np.sin(angles)).astype(int),
                  np.rint(x+radius*np.cos(angles)).astype(int)]
    falls = peak-ring
    radial = float(np.mean(falls > max(.15,contrast*.50)))
    if radial < 22/24:
        return None, 'ridge_ring'
    # Independent curvature test at core scale rejects compact tips on ridges.
    r = int(np.clip(round(diameter*.5), 2, 6))
    dxx = smooth[y,x+r]+smooth[y,x-r]-2*peak
    dyy = smooth[y+r,x]+smooth[y-r,x]-2*peak
    dxy = (smooth[y+r,x+r]+smooth[y-r,x-r]-smooth[y+r,x-r]-smooth[y-r,x+r])*.25
    eig = np.linalg.eigvalsh([[dxx,dxy],[dxy,dyy]])
    curvature = float(eig[1]/min(eig[0],-.0001))
    if eig[1] >= -.015 or curvature < .40:
        return None, 'ridge_curvature'
    # Broad nebulous bumps have too much pedestal relative to their sharp core.
    core_flux = float(signal[rr<=max(3,diameter)].sum())
    outer = float(np.median(signal[(rr>=radius)&(rr<=min(24,radius+3))]))
    if outer > contrast*.28 or core_flux < PARAMETERS['min_flux']:
        return None, 'diffuse_pedestal'
    confidence = float(.45*radial + .30*min(1,contrast/.65) + .25*axis_ratio)
    group = 'large' if diameter>=6 and core_flux>=15 else 'medium' if diameter>=3.3 or core_flux>=10 else 'small'
    return dict(x=x,y=y,peak=peak,contrast=contrast,flux=core_flux,
                diameter=diameter,axis_ratio=axis_ratio,radial=radial,
                curvature=curvature,confidence=confidence,group=group), None

def detect(rgb):
    if rgb.ndim!=3 or rgb.shape[2]!=3 or not np.isfinite(rgb).all() or rgb.min()<0 or rgb.max()>1:
        raise ValueError('Expected finite RGB values in [0,1]')
    cv2.setNumThreads(2)
    lum = rgb @ np.array([.2126,.7152,.0722], np.float32)
    empty = [np.zeros(lum.shape,np.float32) for _ in NAMES]
    valid = lum>.02
    if valid.mean()<.08 or np.std(lum[valid])<.025:
        return empty, [], dict(status='static',reasons=['insufficient_image_structure'],rejected={})
    smooth = blur(lum,.65)
    backdrop = blur(lum,8)
    bkg = Background2D(lum,48,filter_size=3,coverage_mask=~valid,exclude_percentile=70,
                       sigma_clip=SigmaClip(sigma=3),bkg_estimator=MedianBackground())
    residual = lum-bkg.background
    threshold = np.maximum(PARAMETERS['noise_multiple']*bkg.background_rms,PARAMETERS['threshold_floor'])
    found=[]; rejected=collections.Counter(); raw=0
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')  # NoDetectionsWarning is an expected static fallback
        for fwhm in PARAMETERS['fwhm']:
            table=DAOStarFinder(threshold=threshold,fwhm=fwhm,sharpness_range=(.25,1.),
                                roundness_range=(-.9,.9),min_separation=5.,exclude_border=True)(residual,mask=~valid)
            if table is None: continue
            raw+=len(table)
            if raw>20000:
                return empty,[],dict(status='static',reasons=['excessive_ambiguous_texture'],raw_candidates=raw,rejected=dict(rejected))
            for row in table:
                p,reason=measure(lum,smooth,float(row['x_centroid']),float(row['y_centroid']))
                if p:
                    color=rgb[p['y'],p['x']]
                    # Published-image stellar cores are commonly near-neutral.
                    # Omit strongly colored cores rather than twinkle orange/red
                    # gas knots. This intentionally loses some genuine colored stars.
                    if color.min()<PARAMETERS['core_color_floor'] or np.ptp(color)>PARAMETERS['core_color_spread']:
                        rejected['colored_texture']+=1
                    else:
                        x,y=p['x'],p['y']
                        gradient=float(math.hypot(backdrop[y,x+6]-backdrop[y,x-6],backdrop[y+6,x]-backdrop[y-6,x]))
                        if p['diameter']<4 and gradient>.12:
                            rejected['cloud_boundary']+=1
                        else: found.append(p)
                else: rejected[reason]+=1
    found.sort(key=lambda p:p['confidence']*(1+.12*math.log1p(p['flux'])),reverse=True)
    unique=[]
    for p in found:
        if any(math.hypot(p['x']-q['x'],p['y']-q['y'])<PARAMETERS['spacing'] for q in unique):
            rejected['duplicate_or_close']+=1
        else: unique.append(p)
    # Conservative exclusion on the principal Webb spike directions around strong
    # cores. Real aligned stars can be omitted; no attempt to invent missing light.
    bright=[p for p in unique if p['diameter']>=5 and p['contrast']>.55]
    accepted=[]
    for p in unique:
        fragment=False
        for q in bright:
            if p is q or p['flux']>q['flux']*.35: continue
            dx,dy=p['x']-q['x'],p['y']-q['y']; distance=math.hypot(dx,dy)
            if not 18<distance<180: continue
            for angle in (0,math.pi/6,math.pi/2,5*math.pi/6):
                cross=abs(dx*math.sin(angle)-dy*math.cos(angle))
                if cross<3.0: fragment=True;break
            if fragment: break
        if fragment: rejected['spike_guard']+=1
        else: accepted.append(p)
    pre_cap=len(accepted)
    accepted=accepted[:PARAMETERS['max_stars']]
    reasons=[]
    if len(accepted)<PARAMETERS['min_stars']: reasons.append('too_few_confident_stars')
    if pre_cap>600: reasons.append('too_many_ambiguous_peaks')
    if reasons:
        return empty,accepted,dict(status='static',reasons=reasons,raw_candidates=raw,pre_cap=pre_cap,rejected=dict(rejected))
    masks=[np.zeros_like(lum) for _ in range(3)]
    exclusion=np.zeros(lum.shape,np.uint8)
    for p in accepted:
        sigma=float(np.clip(p['diameter']/2.355,1.0,6.0))
        if p['group']=='large': sigma=min(7.0,sigma*1.15)
        radius=int(math.ceil(sigma*4));x,y=p['x'],p['y']
        x0,x1=max(0,x-radius),min(lum.shape[1],x+radius+1)
        y0,y1=max(0,y-radius),min(lum.shape[0],y+radius+1)
        yy,xx=np.mgrid[y0:y1,x0:x1]
        spot=np.exp(-((xx-x)**2+(yy-y)**2)/(2*sigma*sigma)).astype(np.float32)
        layer=masks[NAMES.index(p['group'])]
        layer[y0:y1,x0:x1]=np.maximum(layer[y0:y1,x0:x1],spot)
        cv2.circle(exclusion,(x,y),int(math.ceil(sigma*3)),255,-1)
    # Smooth on nebula scales; inpainted luminance is analysis only.
    filled=cv2.inpaint(lum.astype(np.float32),exclusion,5,cv2.INPAINT_NS)
    broad=blur(filled,32)
    cloud=np.clip((broad-.20)/.45,0,1)**1.6
    cloud*=np.clip((blur(lum,3)-.05)/.20,0,1)
    cloud*=1-np.clip(blur(np.maximum.reduce(masks),8)*3,0,1)
    cloud*=PARAMETERS['cloud_gain']
    masks.append(cloud)
    total=np.maximum(1,np.sum(masks,axis=0))
    # Feather image-content boundary without drawing into black letterbox pixels.
    support=np.clip(cv2.distanceTransform(valid.astype(np.uint8),cv2.DIST_L2,3)/4,0,1)
    masks=[np.clip(m/total*support,0,1).astype(np.float32) for m in masks]
    area=float((np.maximum.reduce(masks[:3])>.25).mean())
    if area>.015:
        return empty,accepted,dict(status='static',reasons=['excessive_star_mask_area'],raw_candidates=raw,rejected=dict(rejected))
    return masks,accepted,dict(status='candidate',reasons=[],raw_candidates=raw,pre_cap=pre_cap,
                               rejected=dict(rejected),star_area_fraction=area,
                               cloud_mean=float(masks[3].mean()))

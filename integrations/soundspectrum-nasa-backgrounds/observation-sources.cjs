"use strict";
// Only categorized astronomical observations; never the general press archives.
const S=require('./pipeline-sources.cjs');
const POLICY='observation-galleries-v1';
const feeds=[['hubble','nebulae'],['hubble','galaxies'],['hubble','starclusters'],['hubble','stars'],['webb','nebulae'],['webb','galaxies'],['webb','stars']];
const host=p=>p==='hubble'?'esahubble.org':p==='webb'?'esawebb.org':null;
function listingURL(provider,category,page=1){
 if(!feeds.some(([p,c])=>p===provider&&c===category)||!Number.isInteger(page)||page<1||page>100)throw Error('Unapproved observation gallery');
 return `https://${host(provider)}/images/archive/category/${category}/page/${page}/`;
}
function listing(html,provider,category){
 listingURL(provider,category);
 const block=String(html).match(/var images\s*=\s*\[([\s\S]*?)\];/);
 if(!block)throw Error('Observation gallery markup changed');
 const entries=[];
 for(const m of block[1].matchAll(/\{([\s\S]*?)\}/g)){
  const id=m[1].match(/\bid:\s*'([A-Za-z0-9_-]+)'/)?.[1];
  const title=m[1].match(/\btitle:\s*'((?:\\.|[^'\\])*)'/)?.[1];
  const width=Number(m[1].match(/\bwidth:\s*(\d+)/)?.[1]),height=Number(m[1].match(/\bheight:\s*(\d+)/)?.[1]);
  if(!id||!title||!width||!height)throw Error('Incomplete observation gallery entry');
  const sourceUrl=`https://${host(provider)}/images/${id}/`;
  entries.push({id:S.stable(provider,id),provider,nasaId:id,title:S.clean(title.replace(/\\'/g,"'").replace(/\\u([a-f0-9]{4})/gi,(_,v)=>String.fromCharCode(parseInt(v,16)))),sourceWidth:width,sourceHeight:height,sourceUrl,manifestUrl:sourceUrl,description:'',mission:provider==='hubble'?'Hubble Space Telescope':'James Webb Space Telescope',credit:'Pending source verification',sourcePolicy:POLICY,galleryCategory:category,detailPending:true});
 }
 return entries;
}
function details(html,e){
 const about=String(html).match(/<table[^>]*aria-describedby="About the Image"[^>]*>([\s\S]*?)<\/table>/)?.[1]||'';
 const type=S.clean(about.match(/Type:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.[1]);
 const object=String(html).match(/<table[^>]*aria-describedby="About the Object"[^>]*>([\s\S]*?)<\/table>/)?.[1]||'';
 const categories=[...object.matchAll(/\/images\/archive\/category\/([a-z-]+)\//g)].map(m=>m[1]);
 if(type!=='Observation'||!categories.includes(e.galleryCategory)||categories.some(c=>/illustration|spacecraft|launch|miscellaneous|graphics/.test(c)))throw Error('non_observation_source');
 const credit=S.clean(String(html).match(/class="credit"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
 const title=S.clean(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]);
 const size=S.clean(about.match(/Size:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.[1]).match(/(\d+)\s*x\s*(\d+)/);
 const links=[...String(html).matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
 // Use only actually advertised high-resolution raster links; dimensions are
 // independently checked by the existing worker, with no upscaling.
 const publication=Number(size?.[1])&&Math.max(Number(size[1]),Number(size[2]))/Math.min(Number(size[1]),Number(size[2]))<=4000/2160?links.find(u=>/\/archives\/images\/publicationjpg\/[^/]+\.jpg$/i.test(u)):null;
 const asset=publication||links.find(u=>/\/archives\/images\/original\/[^/]+\.(?:jpg|jpeg|png)$/i.test(u))||links.find(u=>/\/archives\/images\/large\/[^/]+\.(?:jpg|jpeg|png)$/i.test(u));
 if(!credit||!title||!size||!asset)throw Error('incomplete_observation_metadata');
 const assetUrl=S.official(new URL(asset,e.sourceUrl).href).href;
 if(![host(e.provider),'cdn.'+host(e.provider)].includes(new URL(assetUrl).hostname))throw Error('Observation asset host mismatch');
 const caption=String(html).split(/<h1[^>]*>/)[1]?.split('<strong>Credit:</strong>')[0]||'';
 const description=S.clean(caption.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
 return {...e,title,target:title,description,credit,sourceWidth:Number(size[1]),sourceHeight:Number(size[2]),assetUrl,detailPending:false,observationType:type,observationCategories:categories,sourceCheckedAt:new Date().toISOString()};
}
module.exports={POLICY,feeds,listingURL,listing,details};

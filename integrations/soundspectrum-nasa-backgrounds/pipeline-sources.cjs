"use strict";
const crypto=require('node:crypto');
const exclusions=require('./review-exclusions.json');
const hosts=new Set(['science.nasa.gov','assets.science.nasa.gov','images.nasa.gov','images-api.nasa.gov','images-assets.nasa.gov','apod.nasa.gov','api.nasa.gov','esahubble.org','cdn.esahubble.org','esawebb.org','cdn.esawebb.org']);
const clean=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
function official(value){const u=new URL(value);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.port||u.username||u.password)throw Error('unsupported_source');return u;}
function canonical(value){if(!value)return '';const u=official(value);u.hash='';u.search='';return u.href.replace(/\/$/,'');}
function manifestUrl(value){const u=new URL(value);if(u.protocol==='http:'&&u.hostname==='images-assets.nasa.gov'&&!u.username&&!u.password&&!u.port)u.protocol='https:';return official(u.href).href;}
function stable(provider,id){return provider==='science'?'nasa-science-'+id:'nasa-auto-'+crypto.createHash('sha256').update(provider+':'+id).digest('hex').slice(0,24);}
function suitability(e){
 const ratio=e.sourceWidth&&e.sourceHeight?e.sourceWidth/e.sourceHeight:null;
 const aspect=ratio?Math.min(ratio/(16/9),(16/9)/ratio):.5;
 const resolution=e.sourceWidth&&e.sourceHeight?Math.min(1,e.sourceWidth*e.sourceHeight/(3840*2160)): .5;
 return Math.round(25*resolution+25*aspect+(/webb|hubble|chandra|nebula|galax|star/i.test(e.title+' '+e.mission)?25:10)+15);
}
function eligible(e){
 const review=exclusions.entries.find(x=>x.id===e.id);
 if(review&&(!e.presentationSha256||review.presentationSha256===e.presentationSha256))return 'visual_review: '+review.reason;
 if(!e.title||!e.assetUrl&&!e.manifestUrl)return 'missing_asset';
 // Mission names in press captions establish provenance, not what is pictured.
 // Reject the depicted event/equipment before checking astronomical vocabulary.
 if(/\b(?:briefing|town hall|press conference|image (?:unveiling|debut)|official image debut|rollout|clean[ -]?room|sunshield|cryocooler|photo montage|fellows|podium)\b|speaks at|telescope (?:revealed|alignment|completes|model)|(?:observatory|telescope).{0,35}deployment|project manager|Dr\. John Mather/i.test(e.title))return 'non_celestial_subject';
 if(/\b(?:wearing.{0,35}(?:socks|shoes)|answers questions from the media|speaks at.{0,80}(?:event|anniversary)|(?:meets with|tour of).{0,100}(?:operations center|office)|(?:technicians|engineers).{0,60}(?:inspect|assemble|test|install))\b/i.test(e.description))return 'non_celestial_subject';
 if(/\.(png|jpe?g|webm|mp4)$/i.test(e.title)||/\/cds\/svs\//.test(e.assetUrl||''))return 'unclassified_media_export';
 if(!/webb|hubble|chandra|spitzer|juno|cassini|galax|nebula|star|cluster|dust|supernova|planet|jupiter|saturn|uranus|neptune|mercury|mars|deep field|NGC |IC |messier/i.test(e.title+' '+e.description))return 'not_astronomical_imagery';
 if(/compass|annotat|label(?:ed|s)|diagram|chart|graph|logo|infograph|screenshot|spectr(?:um|a)|light curve|illustrat|artist.?s (?:concept|impression)|comparison|pull[ -]?out|NIRCam and MIRI Images|engineer|hardware|launch|rocket|spacecraft|instrument|camera|telescope (?:mirror|assembly)|press kit|video|^Webb.s NIRCam$|^NASA Webb Telescope$/i.test(e.title))return 'non_photographic_or_annotated';
 if(/insets?|scale bar|text labels|white cross|location.{0,25}(?:cross|circle|arrow)|overlaid|overlay|map of dark matter|side.by.side|(?:left|right)[ -](?:panel|image)|(?:boxes|circles) (?:mark|outline|indicate)|artist.?s (?:concept|illustration)/i.test(e.description))return 'non_photographic_or_annotated';
 if(/\b(?:labelled|labeled|diagram|illustration|schematic|collage)\b|pull[ -]?out|circled in|split (?:diagonally|down)|(?:box|square).{0,45}(?:enlarged|zoom)|(?:enlarged|zoom).{0,45}(?:box|square)|outlined.{0,25}(?:box|square)/i.test(e.description)||/\b(?:shuttle|reentry)\b/i.test(e.title))return 'non_photographic_or_annotated';
 if(/\bartists?(?:['’]s?)?\s+(?:concept|impression|illustration|rendering)\b/i.test(e.title+' '+e.description))return 'non_photographic_or_annotated';
 if(e.sourceWidth&&e.sourceHeight&&(Math.max(e.sourceWidth,e.sourceHeight)<3840||Math.min(e.sourceWidth,e.sourceHeight)<2160))return 'insufficient_resolution';
 if(e.assetUrl&&!/\.(png|jpe?g)$/i.test(official(e.assetUrl).pathname))return 'unsupported_format';
 return null;
}
function science(m){
 if(!Number.isSafeInteger(m.id))return null;
 const title=clean(m.title?.rendered),assetUrl=m.source_url;
 try{official(assetUrl);official(m.link);}catch{return null;}
 const e={id:stable('science',m.id),provider:'science',nasaId:String(m.id),title,target:title.split(' (')[0],description:clean([m.caption?.rendered,m.alt_text].filter(Boolean).join(' ')),
  mission:/webb/i.test(assetUrl)?'James Webb Space Telescope':/hubble/i.test(assetUrl)?'Hubble Space Telescope':'NASA astronomy',credit:clean(m.credits)||'NASA; detailed credit unavailable in discovery record',
  sourceUrl:canonical(m.link),apiUrl:'https://science.nasa.gov/wp-json/wp/v2/media/'+m.id,assetUrl:canonical(assetUrl),
  sourceWidth:m.media_details?.width||null,sourceHeight:m.media_details?.height||null,releaseDate:m.date||null,dateKind:'NASA media record publication'};
 return {...e,suitabilityScore:suitability(e),rejection:eligible(e)};
}
function images(item){
 const d=item.data?.find(x=>x.media_type==='image');if(!d?.nasa_id)return null;
 const e={id:stable('images',d.nasa_id),provider:'images',nasaId:d.nasa_id,title:clean(d.title),target:clean(d.title),description:clean(d.description),
  mission:clean((d.keywords||[]).filter(x=>/webb|hubble|chandra|spitzer|juno|cassini/i.test(x)).join(', '))||'NASA astronomy',
  credit:clean(d.secondary_creator||d.photographer||d.center)||'NASA Image Library',sourceUrl:'https://images.nasa.gov/details/'+encodeURIComponent(d.nasa_id),
  manifestUrl:'https://images-api.nasa.gov/asset/'+encodeURIComponent(d.nasa_id),releaseDate:d.date_created||null,dateKind:'NASA Image Library record date',sourceWidth:null,sourceHeight:null};
 return {...e,suitabilityScore:suitability(e),rejection:eligible(e)};
}
function acquisition(e){
 const u=official(e.assetUrl);
 if(u.hostname==='assets.science.nasa.gov'&&u.pathname.includes('/dynamicimage/')){
  const w=e.sourceWidth||4800,h=e.sourceHeight||2700,scale=Math.min(1,4800/Math.max(w,h));
  // Preserve both admission dimensions: capping the long edge at 4,800 alone
  // incorrectly made high-resolution panoramas/portraits fail the 2,160 minimum.
  // Metadata and CDN output can differ by a few pixels; retain a small margin.
  const qualifiedScale=Math.min(1,Math.max(scale,2240/Math.min(w,h)));
  u.search='';u.searchParams.set('w',String(Math.ceil(w*qualifiedScale)));u.searchParams.set('fit','clip');
 }
 return u.href;
}
module.exports={official,canonical,manifestUrl,stable,clean,suitability,eligible,science,images,acquisition};

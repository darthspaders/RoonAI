"use strict";
// Local plugin patch. Backups permit rollback; rerun after plugin updates only
// when the expected upstream blocks still match. Does not restart playback.
const fs=require('node:fs'),path=require('node:path');
const root='C:/ProgramData/Lyrion/Cache/InstalledPlugins/Plugins/SiriusXM';
const edits=[];
function edit(name,transform){const file=path.join(root,name),before=fs.readFileSync(file,'utf8');if(before.includes('Rabbit Hole: playback-clock metadata guard'))return;const after=transform(before.replace(/\r\n/g,'\n'));edits.push({file,before,after});}
function replace(text,old,next){if(!text.includes(old))throw Error('Plugin version mismatch; no files changed.');return text.replace(old,next);}
edit('ProtocolHandler.pm',text=>{
 const start=text.indexOf('    if ($state && $state->{pending_metadata_result}) {');
 const end=text.indexOf('    # Fetch metadata update',start);
 if(start<0||end<0)throw Error('Missing transition block');
 text=text.slice(0,start)+'    # Rabbit Hole: playback-clock metadata guard\n    # A timer is only a wake-up hint. Re-read PDT before publishing the next cut.\n    delete $state->{pending_metadata_result};\n\n'+text.slice(end);
 const begin=text.indexOf('                $current_state->{pending_metadata_result} = {');
 const finish=text.indexOf('                };',begin);
 if(begin<0||finish<0)throw Error('Missing prediction block');
 text=text.slice(0,begin)+text.slice(finish+'                };'.length);
 text=replace(text,'    $delay = METADATA_UPDATE_INTERVAL unless _isValidDelay($delay);','    $delay = METADATA_UPDATE_INTERVAL unless _isValidDelay($delay);\n    $delay = METADATA_UPDATE_INTERVAL if $delay > METADATA_UPDATE_INTERVAL;');
 text=replace(text,'    my $new_meta = $result->{metadata};',`    my $cut_start = $result->{track_start};
    if (defined $cut_start && defined $state->{last_cut_start} && $cut_start < $state->{last_cut_start}) {
        $log->debug("Ignoring older metadata timestamp for client $clientId");
        return;
    }
    $state->{last_cut_start} = $cut_start if defined $cut_start;
    my $new_meta = $result->{metadata};`);
 return text;
});
edit('APImetadata.pm',text=>{
 text=replace(text,"    my $selected_track = $results->[0];","    # Rabbit Hole: playback-clock metadata guard\n    my $selected_track = $results->[0];\n    my $selected_timestamp;");
 text=replace(text,'                    $selected_track = $matched_track;','                    $selected_track = $matched_track;\n                    $selected_timestamp = $matched_ts;');
 text=replace(text,'                    $log->debug("No xmplaylist record timestamp <= play timestamp $play_ts, falling back to latest record");','                    # Do not publish a future cut when all records are ahead of playback.\n                    $callback->() if $callback;\n                    return;');
 text=replace(text,'            next_update_delay => $next_update_delay,','            track_start => $selected_timestamp,\n            next_update_delay => $next_update_delay,');
 text=replace(text,'    open(my $fh, \'<\', $pdt_file) or do {','    my $modified = (stat($pdt_file))[9];\n    return unless defined $modified && time() - $modified <= 60;\n    open(my $fh, \'<\', $pdt_file) or do {');
 return text;
});
for(const {file,before,after} of edits){fs.writeFileSync(file+'.before-metadata-timing-'+Date.now(),before);fs.writeFileSync(file,after);console.log('Patched '+path.basename(file));}
if(!edits.length)console.log('Timing patch already installed');

"use strict";
// Reuse the same idle, in-flight abort, process isolation and exclusive lock.
const path=require('node:path');
const {prepare}=require('./preprocess.cjs');
const args=process.argv.slice(2),scan=args[0]==='scan';
if(scan)args.shift();
prepare(args,{worker:path.join(__dirname,'preprocessing/curated.py'),workerArgs:scan?['--scan']:[]})
 .then(r=>console.log(JSON.stringify(r,null,2)))
 .catch(e=>{console.error(e.message);process.exitCode=1;});

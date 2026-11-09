const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist');fs.mkdirSync(out,{recursive:true});
for(const file of ['index.html','style.css','runtime.js','engine.js','architectures.js','examples.js','app.js','icon.svg','manifest.webmanifest','sw.js'])fs.copyFileSync(path.join(root,file),path.join(out,file));
console.log('Built dependency-free static site: '+out);

const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch'),{RunController}=require('../execution');
const machine=(source='main:\nret',config={})=>new E.Machine(E.compile(source),config);
const reg=(expression='rax',format='signed')=>({name:'count',kind:'register',expression,format});
const mem=(expression,format='signed',size=4,mode='follow')=>({name:'local',kind:'memory',expression,format,size,mode});
const read=(m,d)=>W.sample(m,W.normalize(d));
const advance=(m,t)=>{m.step();t.capture();};

test('register aliases preserve exact 64-bit values and signed widths',()=>{
 const m=machine('main:\nmovabsq $0x800000000000ff80,%rax\nret');m.step();
 assert.equal(read(m,reg('RAX','unsigned')).display,'9223372036854841216');
 assert.equal(read(m,reg('%al')).display,'-128');
 assert.equal(read(m,reg('ah')).display,'-1');
 assert.equal(read(m,reg('eax','hex')).display,'0x0000ff80');
 assert.equal(read(m,reg('ax','unsigned')).display,'65408');
});
test('memory supports little-endian integers, raw bytes and UTF-8 text',()=>{
 const m=machine('.data\nnumber: .quad -2\nmessage: .asciz "你好"\n.text\nmain:\nret');
 assert.equal(read(m,mem('number','signed',8)).display,'-2');
 assert.equal(read(m,mem('number','unsigned',8)).display,'18446744073709551614');
 assert.equal(read(m,mem('number','hex',2)).display,'0xfffe');
 assert.equal(read(m,mem('number','bytes',3)).display,'fe ff ff');
 assert.equal(read(m,mem('message','text',7)).display,'"你好"');
});
test('address expressions evaluate symbols, bases and scaled indices without CPU read events',()=>{
 const m=machine('.data\na: .quad 123\nb: .quad 456\n.text\nmain:\nret',{registers:{rbx:'0x600000',rcx:'1'}});
 assert.equal(read(m,mem('a+8','unsigned',8)).display,'456');
 assert.equal(read(m,mem('(%rbx,%rcx,8)','unsigned',8)).display,'456');
 assert.equal(read(m,mem('0x600000','unsigned',8)).display,'123');
});
test('fixed stack watch retains its address when frame pointer changes',()=>{
 const m=machine('main:\npushq %rbp\nmovq %rsp,%rbp\nsubq $16,%rsp\nmovl $7,-8(%rbp)\nsubq $8,%rbp\nret');
 for(let i=0;i<4;i++)m.step();
 const t=new W.Tracker(m),fixed=t.add(mem('-8(%rbp)','signed',4,'fixed')),follow=t.add(mem('-8(%rbp)'));
 const address=fixed.current.address;advance(m,t);
 assert.equal(fixed.current.address,address);assert.equal(fixed.current.display,'7');assert.equal(fixed.records.length,0);
 assert.notEqual(follow.current.address,address);assert.equal(follow.current.display,'0');assert.equal(follow.records.length,1);
 const restored=new W.Tracker(m,JSON.parse(JSON.stringify(t.definitions())));assert.equal(restored.items[0].current.address,address);
});
test('unmapped, unreadable and partially mapped watches never mutate the machine',()=>{
 const m=machine('main:\nmovq $1,%rax\nret');m.step();
 const before=m.snapshot(),memory=[...m.memory],history=m.history.slice();
 assert.equal(read(m,mem('0x1')).available,false);
 assert.equal(read(m,mem('0xffffffffffffffff','bytes',2)).available,false);
 const boundary=m.regions.find(r=>r.name==='栈');
 assert.equal(read(m,mem(E.hex(boundary.end-1n),'bytes',2)).available,false);
 assert.equal(read(m,mem('missing_symbol')).available,false);
 assert.deepEqual(m.snapshot(),before);assert.deepEqual([...m.memory],memory);assert.deepEqual(m.history,history);
 const region=m.regionAt(m.regs.rsp);region.readable=false;
 assert.match(read(m,mem(E.hex(m.regs.rsp))).error,/不可读/);
});
test('watching below the stack does not invoke automatic stack growth',()=>{
 const m=machine('main:\nret',{runtime:'linux'}),before=m.regions.map(r=>({...r}));
 const low=m.regions.find(r=>r.name==='栈').start;
 assert.equal(read(m,mem(E.hex(low-8n),'unsigned',8)).available,false);
 assert.deepEqual(m.regions,before);
});
test('fast run captures intermediate changes and stops before a breakpoint',()=>{
 const m=machine('main:\nmovq $1,%rax\nmovq $2,%rax\nmovq $2,%rax\nmovq $3,%rax\nret'),t=new W.Tracker(m,[reg()]);
 const breakpoint=m.program.instructions[3].address,runner=new RunController(m,new Set([breakpoint.toString()]),()=>t.capture());
 let reason;do{reason=runner.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.equal(m.rip,breakpoint);
 assert.deepEqual(t.items[0].records.map(r=>[r.step,r.before.display,r.after.display]),[[1,'0','1'],[2,'1','2']]);
 assert.equal(t.items[0].records[1].instruction,'movq $2,%rax');
 runner.begin();while(!runner.advance());assert.equal(m.status,'halted');assert.equal(t.items[0].current.display,'3');
});
test('rewind removes future changes and re-execution creates no duplicates',()=>{
 const m=machine('main:\nmovq $1,%rax\nmovq $2,%rax\nret'),t=new W.Tracker(m,[reg()]);
 advance(m,t);advance(m,t);m.back();t.rewind();
 assert.equal(t.items[0].current.display,'1');assert.equal(t.items[0].records.length,1);
 advance(m,t);assert.equal(t.items[0].records.length,2);
 m.back();t.rewind();m.back();t.rewind();assert.equal(t.items[0].current.display,'0');assert.equal(t.items[0].records.length,0);
});
test('atomic faults and undoing faults do not create phantom records',()=>{
 const m=machine('main:\nmovq $1,%rax\nmovq $5,0x1\nret'),t=new W.Tracker(m,[reg(),mem('0x1')]);
 advance(m,t);advance(m,t);assert.equal(m.status,'fault');assert.equal(m.steps,1);
 assert.equal(t.items[0].records.length,1);assert.equal(t.items[1].records.length,0);
 m.back();t.rewind();assert.equal(t.items[0].records.length,1);assert.equal(t.items[0].current.display,'1');
});
test('adding midway establishes a baseline, rename retains history and rebind clears it',()=>{
 const m=machine('main:\nmovq $1,%rax\nmovq $2,%rax\nret');m.step();
 const t=new W.Tracker(m),item=t.add(reg());assert.equal(item.startStep,1);assert.equal(item.records.length,0);
 advance(m,t);t.update(item.def.id,{...item.def,name:'结果'});assert.equal(item.records.length,1);
 t.update(item.def.id,{...item.def,expression:'eax'});assert.equal(item.records.length,0);assert.equal(item.current.display,'2');
 m.back();t.rewind();m.back();t.rewind();assert.equal(item.startStep,0);assert.equal(item.current.display,'0');
 t.remove(item.def.id);assert.equal(t.items.length,0);
});
test('recent history is bounded and rewinding works after truncation',()=>{
 const m=machine('main:\nincq %rax\njmp main'),t=new W.Tracker(m,[reg()]);
 for(let i=0;i<420;i++)advance(m,t);
 assert.equal(t.items[0].records.length,W.LIMIT);assert.equal(t.items[0].records[0].step,21);
 for(let i=0;i<5;i++){m.back();t.rewind();}
 assert.equal(t.items[0].current.display,'208');assert.ok(t.items[0].records.every(r=>r.step<=m.steps));
});
test('availability and address changes are recorded even when numeric value is identical',()=>{
 const m=machine('main:\nmovq %rsp,%rbp\nsubq $8,%rbp\nsubq $8,%rbp\nret'),t=new W.Tracker(m,[mem('-8(%rbp)')]);
 assert.equal(t.items[0].current.available,false);advance(m,t);advance(m,t);
 assert.equal(t.items[0].records.length,2);assert.equal(t.items[0].records[1].before.display,t.items[0].records[1].after.display);
 assert.notEqual(t.items[0].records[1].before.location,t.items[0].records[1].after.location);
});
test('definitions round-trip as JSON without execution records and old configs need no watches',()=>{
 const m=machine(),t=new W.Tracker(m,[reg(),mem(E.hex(m.regs.rsp),'hex',8,'fixed')]);
 assert.equal(new W.Tracker(m,undefined).items.length,0);
 const data=JSON.parse(JSON.stringify(t.definitions()));assert.equal(data[0].records,undefined);
 assert.deepEqual(new W.Tracker(m,data).definitions(),data);
});
test('invalid definitions are rejected without affecting execution',()=>{
 const m=machine(),t=new W.Tracker(m);
 for(const def of [{...reg(),name:''},reg('constructor'),reg('rax','bytes'),mem('$12'),mem('(%rip)'),mem('0x1','signed',3),mem('0x1','bytes',65),mem('0x1\nret'),mem('(%rax,%rcx,3)'),mem('0x1','signed',4,'fixed')])assert.throws(()=>t.add(def));
 assert.equal(t.items.length,0);assert.equal(m.steps,0);assert.equal(m.status,'ready');
 for(let i=0;i<W.MAX_WATCHES;i++)t.add(reg());assert.throws(()=>t.add(reg()),/最多/);
 assert.equal(new Set(t.items.map(x=>x.def.id)).size,W.MAX_WATCHES);
});

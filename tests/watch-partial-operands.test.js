const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch');
const watch=(name,size=4,expression=name)=>({name,kind:'memory',expression,size,format:'hex'});
function setup(code,defs,data='input: .quad target\ni: .long 1\ntarget: .byte 65,66,67'){
 const m=new E.Machine(E.compile('.data\n'+data+'\n.text\nmain:\n'+code+'\nhlt')),t=new W.Tracker(m,defs);
 const step=()=>{m.step();t.capture();assert.notEqual(m.status,'fault',m.error);};
 const view=(name,id)=>t.registerCopies(id).find(c=>c.register===name&&c.calculated);
 return {m,t,step,view,run:()=>{while(m.status==='ready')step();}};
}
const pointerLoads='movl i,%eax\nmovslq %eax,%rdx\nmovq input,%rax\naddq %rdx,%rax';
test('a 4-byte watch survives a 64-bit pointer addition and subsequent dereference',()=>{
 const {t,step,view}=setup(pointerLoads+'\nmovzbl (%rax),%eax',[watch('input'),watch('i')]);
 for(let n=0;n<4;n++)step();const id=t.items[0].def.id;
 assert.equal(view('RAX',id).label,'零扩展64(input) + 符号扩展64(i)');
 assert.match(view('RAX',id).inputs,/部分字节参与 64 位读取/);
 assert.equal(t.latestOperation(id).summary,'RAX 中加了 符号扩展64(i)');
 step();assert.equal(view('EAX',id).label,'零扩展32(*(零扩展64(input) + 符号扩展64(i)))');assert.equal(view('EAX',id).value,'0x00000042');
});
test('an 8-byte pointer retains its full identity without inferred padding',()=>{
 const {view,run}=setup(pointerLoads,[watch('input',8),watch('i')]);run();
 assert.equal(view('RAX').label,'input + 符号扩展64(i)');assert.doesNotMatch(view('RAX').inputs,/部分字节/);
});
test('nonzero untracked high bits are captured explicitly, never assumed to be zero',()=>{
 const {view,run,t}=setup('movq input,%rax\naddq $1,%rax',[watch('input')],'input: .quad 0x1234567800000005');run();
 assert.equal(view('RAX').label,'拼接64(位[32:64]=0x12345678，位[0:32]=input) + 1');
 assert.equal(view('RAX').value,'0x1234567800000006');assert.equal(t.latestOperation(t.items[0].def.id).after,view('RAX').value);
});
test('two adjacent watched ranges remain distinct parts of a wider value',()=>{
 const {view,run,t}=setup('movq low,%rax\naddq $1,%rax',[watch('low'),watch('high')],'low: .long 3\nhigh: .long 2');run();
 assert.equal(view('RAX').label,'拼接64(位[32:64]=high，位[0:32]=low) + 1');assert.equal(view('RAX').value,'0x0000000200000004');
 assert.ok(t.items.every(item=>t.latestOperation(item.def.id)));
});
test('a high-byte association preserves the untracked low byte and other registers do not match by value',()=>{
 const {view,run,t}=setup('movw $0x1234,%ax\nmovb x,%ah\naddw $1,%ax\nmovq $3,%rbx\naddq $1,%rbx',[watch('x',1)],'x: .byte 3');run();
 assert.equal(view('AX').label,'拼接16(位[8:16]=x，位[0:8]=0x34) + 1');assert.equal(view('AX').value,'0x0335');assert.equal(view('RBX'),undefined);
 assert.equal(t.latestOperation(t.items[0].def.id).target,'AX');
});
test('direct memory operands and register bindings also preserve partial-width provenance',()=>{
 const a=setup('movq $1,%rax\naddq input,%rax',[watch('input')],'input: .quad 5');a.run();assert.equal(a.view('RAX').label,'1 + 零扩展64(input)');assert.equal(a.t.latestOperation(a.t.items[0].def.id),null);
 const b=setup('movq $0x100000005,%rax\naddq $1,%rax',[{name:'x',kind:'register',expression:'eax',format:'hex'}]);b.run();
 assert.equal(b.view('RAX').label,'拼接64(位[32:64]=0x00000001，位[0:32]=x) + 1');assert.equal(b.t.latestOperation(b.t.items[0].def.id).after,'0x0000000100000006');
});
test('negative indices, copying, source changes and rewind retain actual values',()=>{
 const {m,t,view,step}=setup(pointerLoads+'\nmovq %rax,%rbx\nmovl $99,i\nmovq $0,%rax',[watch('input'),watch('i')],'input: .quad 0x100000000\ni: .long -1');
 for(let n=0;n<6;n++)step();assert.equal(view('RBX').value,'0x00000000ffffffff');assert.equal(view('RBX').stale,true);
 assert.match(view('RBX').inputs,/i = 0xffffffff/);step();assert.equal(view('RAX'),undefined);
 m.back();t.rewind();assert.equal(view('RAX').value,'0x00000000ffffffff');
 while(m.steps>3){m.back();t.rewind();}assert.equal(t.latestOperation(t.items[0].def.id),null);
 step();assert.equal(view('RAX').value,'0x00000000ffffffff');
});
test('overwriting the tracked bytes clears their partial association before wider arithmetic',()=>{
 const {t,run}=setup('movq input,%rax\nmovl $7,%eax\naddq $1,%rax',[watch('input')]);run();
 assert.deepEqual(t.registerCopies(),[]);assert.equal(t.latestOperation(t.items[0].def.id),null);
});

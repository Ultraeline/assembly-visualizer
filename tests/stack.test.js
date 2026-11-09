const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),S=require('../stack'),{RunController}=require('../execution');
const create=(source,config={})=>new E.Machine(E.compile(source),config);
const steps=(m,n)=>{for(let i=0;i<n;i++){m.step();assert.notEqual(m.status,'fault',m.error);}return m;};
const newest=m=>m.stackSpaces.items.at(-1);

test('imported suffix-free SUB from the user disassembly captures RAX at execution',()=>{
 const m=create('0000000000400a69 <phase>:\n 400a69: 48 29 c4 sub %rax,%rsp\n 400a6c: 90 nop\n 400a6d: f4 hlt',{registers:{rax:'0x80'}}),top=m.regs.rsp;
 steps(m,1);assert.equal(newest(m).start,top-128n);assert.equal(newest(m).end,top);assert.equal(newest(m).address,0x400a69n);assert.equal(newest(m).kind,'dynamic');
 m.back();assert.equal(m.stackSpaces.items.length,0);steps(m,1);assert.equal(newest(m).id,1);
});

test('dynamic allocation captures actual size and fixed bounds without clearing memory',()=>{
 const m=create('main:\nmovq $96,%rax\nsubq %rax,%rsp\nmovq $1,%rax\ncall f\naddq $96,%rsp\nret\nf:\nmovb $65,(%rsp)\nret');
 const top=m.regs.rsp;m.memory.set(top-96n,0x42);steps(m,2);
 const s=newest(m);assert.equal(s.kind,'dynamic');assert.equal(s.start,top-96n);assert.equal(s.end,top);assert.equal(s.step,2);assert.equal(S.page(m,s).bytes[0].value,0x42);
 steps(m,2);assert.equal(m.stackSpaces.items.length,1);assert.equal(newest(m).start,s.start);assert.equal(newest(m).end,s.end);
});
test('PUSH, CALL, MOV and zero or wrapping SUB are not inferred as allocations',()=>{
 const m=create('main:\npushq %rbp\nmovq %rsp,%rbp\ncall f\nleave\nret\nf:\nret');
 while(m.status==='ready')m.step();assert.equal(m.stackSpaces.items.length,0);
 const zero=create('main:\nsubq $0,%rsp\nsubq $-8,%rsp\nret');steps(zero,2);assert.equal(zero.stackSpaces.items.length,0);
 const wrap=create('main:\nsubq $32,%rsp\nhlt',{harness:false,registers:{rsp:'16'}});steps(wrap,1);assert.equal(wrap.stackSpaces.items.length,0);
 const mov=create('main:\nmovq %rax,%rsp\nhlt');steps(mov,1);assert.equal(mov.stackSpaces.items.length,0);
});
test('SUB immediate, ADD negative, RSP-based LEA and AND alignment are classified',()=>{
 const m=create('main:\nsubq $8,%rsp\naddq $-8,%rsp\nleaq -8(%rsp),%rsp\nandq $-0x10,%rsp\nhlt');steps(m,4);
 assert.deepEqual(m.stackSpaces.items.map(s=>[s.kind,s.end-s.start]),[['constant',8n],['constant',8n],['constant',8n],['alignment',8n]]);
 assert.equal(m.status,'ready');
});
test('paging covers the entire region and cannot mutate or grow mappings',()=>{
 const m=create('main:\nmovq $20000,%rax\nsubq %rax,%rsp\nhlt',{runtime:'linux'});steps(m,2);
 const s=newest(m),snapshot=m.snapshot(),memory=[...m.memory];
 const first=S.page(m,s);assert.equal(first.bytes.length,64);assert.ok(first.bytes.every(b=>b.value===null));
 const last=S.page(m,s,19968n);assert.equal(last.bytes.length,32);assert.equal(last.end,s.end);assert.equal(last.hasNext,false);
 assert.equal(S.page(m,s,999999n).offset,19968n);assert.equal(S.page(m,s,-1n).offset,0n);
 assert.deepEqual(m.snapshot(),snapshot);assert.deepEqual([...m.memory],memory);
});
test('nested calls retain caller allocation and record writes from the callee',()=>{
 const m=create('main:\nmovq $96,%rax\nsubq %rax,%rsp\nmovq %rsp,%rdi\ncall f\naddq $96,%rsp\nret\nf:\nsubq $16,%rsp\nmovb $65,(%rdi)\nmovb $66,64(%rdi)\naddq $16,%rsp\nret');
 steps(m,9);const [caller,callee]=m.stackSpaces.items;
 assert.equal(caller.status,'active');assert.equal(callee.status,'released');assert.notEqual(caller.frameId,callee.frameId);
 assert.deepEqual(caller.changes.map(c=>[c.step,c.samples[0].address-caller.start,c.samples[0].after]),[[6,0n,65],[7,64n,66]]);
 assert.equal(S.page(m,caller,64n).bytes[0].value,66);
 steps(m,1);assert.equal(m.stackSpaces.items[0].status,'released');
});
test('partial release, MOV restoration, LEAVE and undo restore allocation lifetimes',()=>{
 const m=create('main:\npushq %rbp\nmovq %rsp,%rbp\nsubq $96,%rsp\naddq $32,%rsp\nmovq %rbp,%rsp\nleave\nret');steps(m,3);const start=newest(m).start,state=m.stackSpaces;
 steps(m,1);assert.equal(newest(m).status,'partial');assert.equal(newest(m).liveStart,start+32n);assert.equal(S.page(m,newest(m)).bytes.filter(b=>b.released).length,32);
 steps(m,1);assert.equal(newest(m).status,'released');m.back();assert.equal(newest(m).status,'partial');m.back();assert.strictEqual(m.stackSpaces,state);
 steps(m,3);assert.equal(newest(m).status,'released');
});
test('released memory can be reused without modifying old records and rewind restores bytes',()=>{
 const m=create('main:\nsubq $8,%rsp\nmovb $65,(%rsp)\naddq $8,%rsp\nsubq $8,%rsp\nmovb $66,(%rsp)\nhlt');steps(m,3);const old=newest(m);
 steps(m,2);assert.equal(m.stackSpaces.items.length,2);assert.equal(old.changes.length,1);assert.equal(old.changes[0].samples[0].after,65);
 assert.equal(newest(m).changes[0].samples[0].before,65);assert.equal(S.page(m,old).bytes[0].value,66);
 m.back();assert.equal(newest(m).changes.length,0);assert.equal(S.page(m,old).bytes[0].value,65);
 m.back();assert.equal(m.stackSpaces.items.length,1);m.back();assert.equal(newest(m).status,'active');
});
test('faulting writes leave space history unchanged and undo removes allocation',()=>{
 const m=create('main:\nsubq $8,%rsp\nmovq $7,0x1\nret');steps(m,1);const before=m.stackSpaces;
 m.step();assert.equal(m.status,'fault');assert.strictEqual(m.stackSpaces,before);m.back();assert.strictEqual(m.stackSpaces,before);m.back();assert.equal(m.stackSpaces.items.length,0);
});
test('runtime memset is one change event with a bounded preview of the full write count',()=>{
 const m=create('main:\nsubq $128,%rsp\nmovq %rsp,%rdi\nmovq $65,%rsi\nmovq $128,%rdx\ncall memset\naddq $128,%rsp\nret');steps(m,6);
 const s=newest(m);assert.equal(s.changes.length,1);assert.equal(s.changes[0].count,128);assert.equal(s.changes[0].samples.length,16);assert.equal(S.page(m,s,64n).bytes[63].value,65);
});
test('fast run records changes and stops before a breakpoint without losing intermediate writes',()=>{
 const m=create('main:\nmovq $8,%rax\nsubq %rax,%rsp\nmovb $1,(%rsp)\nmovb $2,(%rsp)\naddq $8,%rsp\nret');
 const target=m.program.instructions[4].address,r=new RunController(m,new Set([target.toString()]));let reason;do{reason=r.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.equal(newest(m).status,'active');assert.deepEqual(newest(m).changes.map(c=>c.samples[0].after),[1,2]);
});
test('loop allocations are distinct and both retained lists are bounded',()=>{
 const m=create('main:\nsubq $8,%rsp\nmovb $1,(%rsp)\naddq $8,%rsp\njmp main');steps(m,280);
 assert.equal(m.stackSpaces.serial,70);assert.equal(m.stackSpaces.items.length,S.MAX_SPACES);assert.equal(m.stackSpaces.items[0].id,7);
 const n=create('main:\nsubq $8,%rsp\nloop:\nincb (%rsp)\njmp loop');steps(n,241);
 assert.equal(newest(n).changes.length,S.MAX_CHANGES);assert.equal(newest(n).changes.at(-1).samples[0].after,120);
 for(let i=0;i<4;i++)n.back();assert.equal(newest(n).changes.at(-1).samples[0].after,118);
});
test('no-op writes do not add history and writes after partial release ignore the released bytes',()=>{
 const m=create('main:\nsubq $16,%rsp\nmovq %rsp,%rdi\nmovb $0,(%rsp)\naddq $8,%rsp\nmovb $65,(%rdi)\nmovb $66,(%rsp)\nhlt');steps(m,6);
 const s=newest(m);assert.equal(s.changes.length,1);assert.equal(s.changes[0].samples[0].address,s.start+8n);
});

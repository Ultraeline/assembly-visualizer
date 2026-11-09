const {test}=require('node:test');
const assert=require('node:assert/strict');
const D=require('../decoder'),E=require('../engine'),{RunController}=require('../execution');
const decode=(hex,address=0x1000n)=>{const bytes=Buffer.from(hex.replaceAll(' ',''),'hex');return D.decode(address,a=>bytes[Number(a-address)]);};
test('known encodings decode immediate widths, signs, REX, high bytes and SIB',()=>{
  for(const [bytes,text]of [
    ['48 c7 04 25 00 30 60 00 ff ff ff ff','movq $-0x1, 0x603000'],
    ['bf 78 56 34 12','movl $0x12345678, %edi'],
    ['48 83 ec 80','subq $-0x80, %rsp'],['6a ff','pushq $-0x1'],
    ['68 00 00 00 80','pushq $-0x80000000'],['b4 12','movb $0x12, %ah'],
    ['40 b4 12','movb $0x12, %spl'],['41 b0 ff','movb $0xff, %r8b'],
    ['66 b8 34 12','movw $0x1234, %ax'],
    ['48 b8 88 77 66 55 44 33 22 11','movq $0x1122334455667788, %rax'],
    ['4f 8d 4c a5 f0','leaq -0x10(%r13,%r12,4), %r9'],
    ['48 8d 05 f9 ff ff ff','leaq -0x7(%rip), %rax'],
    ['41 54','pushq %r12'],['41 5c','popq %r12'],
    ['ff d0','call *%rax'],['ff 24 24','jmp *0x0(%rsp)'],
    ['f3 c3','rep ret'],['f3 90','pause'],['0f 1f 44 00 00','nop'],
    ['c2 10 00','ret $0x10']
  ]){const d=decode(bytes);assert.equal(d.text,text,bytes);assert.equal(d.length,bytes.split(' ').length);}
  assert.equal(decode('75 fe').text,'jne 0x1000');
  assert.equal(decode('e8 fb ff ff ff').text,'call 0x1000');
  assert.equal(decode('0f 84 fa ff ff ff').text,'je 0x1000');
});
test('unsupported, invalid and truncated encodings fail without guessing',()=>{
  for(const bytes of ['0f 0b','67 8b 00','f0 90','48 c7 c8 00 00 00 00','8d c0','0f 1f c8','48 b8 00'])assert.throws(()=>decode(bytes),/无法解码/);
  assert.throws(()=>decode(''),/未映射/);
});
function dynamicMachine(bytes){
  return new E.Machine(E.compile('main:\nmovq $0x3000,%rax\npushq %rax\nret'),{regions:[{address:'0x3000',size:64,hex:bytes}]});
}
test('PUSH/RET enters memory code, preserves outer frame, and returns to the harness',()=>{
  const m=dynamicMachine('b8 2a 00 00 00 c3');m.step();m.step();m.step();
  assert.equal(m.frames.length,1);assert.equal(m.rip,0x3000n);
  assert.deepEqual(m.dynamicInstructions().map(i=>i.text),['movl $0x2a, %eax','ret']);
  m.step();assert.equal(m.regs.rax,42n);assert.equal(m.lastEvent.decoded,true);
  m.back();assert.equal(m.rip,0x3000n);m.step();m.step();
  assert.equal(m.status,'halted',m.error);assert.equal(m.regs.rax,42n);
});
test('written code is decoded again on execution and undo, with atomic fetch faults',()=>{
  const m=dynamicMachine('c6 05 01 00 00 00 2a b8 01 00 00 00 c3');
  m.step();m.step();m.step();const before=m.snapshot();m.step();
  assert.equal(m.instructionAt(0x3007n).text,'movl $0x2a, %eax');
  m.back();assert.deepEqual(m.snapshot(),before);assert.equal(m.instructionAt(0x3007n).text,'movl $0x1, %eax');
  m.step();m.step();m.step();assert.equal(m.status,'halted');assert.equal(m.regs.rax,42n);
  const bad=dynamicMachine('0f 0b');bad.step();bad.step();bad.step();const regs={...bad.regs};bad.step();
  assert.equal(bad.status,'fault');assert.deepEqual(bad.regs,regs);assert.equal(bad.rip,0x3000n);bad.back();assert.equal(bad.status,'ready');
  bad.regions=bad.regions.filter(r=>r.start!==0x3000n);bad.step();assert.match(bad.error,/未映射/);
});
test('modified imported instruction uses current bytes and never executes unreadable bytes',()=>{
  const p=E.compile('main:\nmovl $1,%eax\nret'),m=new E.Machine(p);
  m.memory.set(p.symbols.main+1n,42);m.step();assert.equal(m.regs.rax,42n);assert.equal(m.lastEvent.decoded,true);
  const n=dynamicMachine('90');n.step();n.step();n.step();n.regionAt(0x3000n).readable=false;n.step();assert.equal(n.status,'fault');assert.match(n.error,/不可读/);
});
test('continue after repeated byte overwrites reaches a breakpoint and then the actual result',()=>{
  const p=E.compile('main:\nmovb $0,(%rsp)\nmovb $0,1(%rsp)\nmovq $0x3000,(%rsp)\nret');
  const m=new E.Machine(p,{regions:[{address:'0x3000',size:16,hex:'b8 2a 00 00 00 f4'}]}),breakpoints=new Set(['12288']),r=new RunController(m,breakpoints);
  assert.equal(r.advance(),'warning');assert.equal(m.steps,1);
  r.begin();let reason;for(let i=0;i<20;i++){reason=r.advance();if(reason)break;}
  assert.equal(reason,'breakpoint');assert.equal(m.rip,0x3000n);assert.equal(m.steps,4);
  assert.ok(m.history.some(h=>h.snapshot.lastEvent?.warnings.length));
  r.begin();assert.equal(r.advance(),null);assert.equal(m.regs.rax,42n);assert.equal(r.advance(),'halted');
  const again=new E.Machine(p),rr=new RunController(again);assert.equal(rr.advance(),'warning');again.back();rr.resetWarnings();rr.begin();assert.equal(rr.advance(),'warning');
});
test('breakpoints in loops stop before executing, including the resumed starting address',()=>{
  const m=new E.Machine(E.compile('main:\naddq $1,%rax\njmp main')),r=new RunController(m,new Set([m.rip.toString()]));
  assert.equal(r.advance(),null);assert.equal(r.advance(),null);assert.equal(r.advance(),'breakpoint');assert.equal(m.regs.rax,1n);
  r.begin();assert.equal(r.advance(),null);assert.equal(m.regs.rax,2n);
});
test('printf renders pointers, null and literal percent, and rewinds output',()=>{
  const m=new E.Machine(E.compile('.data\nfmt: .asciz "%p @ %p %%\\n"\n.text\nmain:\nmovq $fmt,%rdi\nmovq $0x3000,%rsi\nxorq %rdx,%rdx\ncall printf\nret'));
  for(let i=0;i<4;i++)m.step();m.step();assert.equal(m.output,'0x3000 @ (nil) %\n');assert.equal(m.regs.rax,17n);
  m.back();assert.equal(m.output,'');m.step();assert.equal(m.output,'0x3000 @ (nil) %\n');
});

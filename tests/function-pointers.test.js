const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine');
const create=(code,config={})=>new E.Machine(E.compile(code),config);

test('source function declarations, direct CALL targets and entry names are indexed',()=>{
 const m=create('.type hidden, @function\n.text\nmain:\ncall called\nret\ncalled:\nret\nhidden:\nret\nloop:\nnop\njmp loop');
 for(const name of ['main','called','hidden'])assert.deepEqual(m.functionNamesAt(m.program.symbols[name]),[name]);
 assert.deepEqual(m.functionNamesAt(m.program.symbols.loop),[]);
 assert.deepEqual(m.functionNamesAt(m.program.symbols.called+1n),['hidden']);
});
test('disassembly headers identify functions and PLT names but exclude interior and local labels',()=>{
 const m=create('0000000000400000 <main>:\n 400000: 90 nop\n0000000000400001 <main+0x1>:\n 400001: c3 ret\n0000000000400010 <puts@plt>:\n 400010: c3 ret\n0000000000400020 <.Lbranch>:\n 400020: c3 ret');
 assert.deepEqual(m.functionNamesAt(0x400000n),['main']);assert.deepEqual(m.functionNamesAt(0x400010n),['puts@plt']);
 assert.deepEqual(m.functionNamesAt(0x400001n),[]);assert.deepEqual(m.functionNamesAt(0x400020n),[]);
});
test('same-address function aliases are retained without duplicate names or data symbols',()=>{
 const m=create('.data\nobject: .quad 0\n.type object, @function\n.text\n.type win, @function\n.type win_alias, %function\nmain:\nret\nwin:\nwin_alias:\nret');
 assert.deepEqual(m.functionNamesAt(m.program.symbols.win),['win','win_alias']);assert.deepEqual(m.functionNamesAt(m.program.symbols.object),[]);
});
test('an eight-byte little-endian stack value shows its exact function and updates through overwrite and undo',()=>{
 const m=create('.type win, @function\nmain:\nleaq win(%rip),%rax\npushq %rax\nmovq $main,(%rsp)\nmovq $0,(%rsp)\nret\nwin:\nret');
 m.step();m.step();const at=m.regs.rsp;assert.deepEqual(m.functionPointerAt(at),{value:m.program.symbols.win,names:['win']});
 m.step();assert.deepEqual(m.functionPointerAt(at).names,['main']);m.step();assert.equal(m.functionPointerAt(at),null);
 m.back();assert.deepEqual(m.functionPointerAt(at).names,['main']);m.back();assert.deepEqual(m.functionPointerAt(at).names,['win']);
});
test('function-pointer inspection is exact, read-only and requires all eight readable bytes',()=>{
 const m=create('main:\npushq $main\nret');m.step();const at=m.regs.rsp,before=m.snapshot(),memory=[...m.memory],history=m.history.slice();
 assert.deepEqual(m.functionPointerAt(at).names,['main']);assert.equal(m.functionPointerAt(0x1n),null);
 assert.deepEqual(m.snapshot(),before);assert.deepEqual([...m.memory],memory);assert.deepEqual(m.history,history);
 m.addRegion(0x900000n,4,'partial',true);E.bytesLE(m.program.symbols.main,4).forEach((b,i)=>m.memory.set(0x900000n+BigInt(i),b));assert.equal(m.functionPointerAt(0x900000n),null);
 m.regionAt(at).readable=false;assert.equal(m.functionPointerAt(at),null);
});
test('library entry addresses are named but internal runtime continuations are not functions',()=>{
 const m=create('main:\nmovq $printf,%rax\npushq %rax\nret');m.step();m.step();assert.deepEqual(m.functionPointerAt(m.regs.rsp).names,['printf']);
 m.externalMap.set(0x777777n,'[libc startup continuation]');assert.deepEqual(m.functionNamesAt(0x777777n),[]);
});
test('function addresses above Number precision remain exact',()=>{
 const m=new E.Machine(E.compile('main:\nret',{codeBase:'0x20000000000001'}));
 m.push(m.program.symbols.main);assert.equal(m.functionPointerAt(m.regs.rsp).value,0x20000000000001n);assert.deepEqual(m.functionNamesAt(0x20000000000000n),[]);
});

(function(root){
  'use strict';
  const MAX_SPACES=64,MAX_CHANGES=100,PREVIEW_BYTES=16,PAGE_SIZE=64;
  const hex=n=>'0x'+n.toString(16);
  const initial=()=>({serial:0,items:[]});
  function allocationKind(ins){
    if(!ins||ins.bits!==64||ins.args?.at(-1)?.reg!=='rsp')return null;
    if(ins.op==='sub'||ins.op==='add')return ins.args[0].kind==='imm'?'constant':'dynamic';
    if(ins.op==='lea'&&ins.args[0].base==='rsp')return ins.args[0].index?'dynamic':'constant';
    if(ins.op==='and'&&ins.args[0].kind==='imm'){
      // Only a contiguous low-bit mask is stack alignment, not arbitrary AND.
      const expr=ins.args[0].expr;
      if(!/^-?(?:0x[\da-f]+|\d+)$/i.test(expr))return null;
      const magnitude=expr.replace(/^-/,'');
      let value=BigInt(/^0[0-7]+$/.test(magnitude)?'0o'+magnitude.slice(1):magnitude);if(expr.startsWith('-'))value=-value;
      const mask=BigInt.asUintN(64,value),removed=BigInt.asUintN(64,~mask);
      if(mask!==0n&&removed>0n&&(removed&(removed+1n))===0n)return 'alignment';
    }
    return null;
  }
  function changeRecord(space,event,step){
    const samples=[];let count=0;
    for(const write of event.writes){
      if(write.kind!=='mem')continue;
      const from=write.address>space.liveStart?write.address:space.liveStart;
      const to=write.address+BigInt(write.after.length)<space.end?write.address+BigInt(write.after.length):space.end;
      for(let at=from;at<to;at++){
        const i=Number(at-write.address);
        if(write.before[i]===write.after[i])continue;
        count++;
        if(samples.length<PREVIEW_BYTES)samples.push({address:at,before:write.before[i],after:write.after[i]});
      }
    }
    return count?{step,address:event.address,instruction:event.instruction,count,samples}:null;
  }
  function advance(state,machine,before,ins){
    const event=machine.event,sp=machine.regs.rsp,oldSp=before.regs.rsp;
    const frames=new Set(machine.frames.map(f=>f.id));
    let changed=false;
    let items=state.items.map(space=>{
      if(space.status==='released')return space;
      let next=space;
      const record=changeRecord(space,event,machine.steps);
      if(record)next={...next,changes:[...space.changes,record].slice(-MAX_CHANGES)};
      const returned=!frames.has(space.frameId);
      const liveStart=returned?space.end:sp>oldSp&&sp>space.liveStart?(sp<space.end?sp:space.end):space.liveStart;
      if(liveStart!==space.liveStart)next={...next,liveStart,status:liveStart===space.end?'released':'partial',releaseStep:machine.steps,releaseInstruction:event.instruction};
      if(next!==space)changed=true;
      return next;
    });
    let serial=state.serial;
    const kind=allocationKind(ins);
    if(kind&&sp<oldSp){
      const frame=before.frames.at(-1);
      const space={id:++serial,start:sp,end:oldSp,liveStart:sp,kind,status:'active',frameId:frame?.id,frameName:frame?.name||'未知栈帧',step:machine.steps,address:event.address,instruction:event.instruction,changes:[]};
      items=[...items,space].slice(-MAX_SPACES);changed=true;
      event.stackAllocation={start:sp,end:oldSp,kind};
    }
    return changed?{serial,items}:state;
  }
  function page(machine,space,offset=0n){
    const size=space.end-space.start;
    offset=offset<0n?0n:offset>=size?((size-1n)/BigInt(PAGE_SIZE))*BigInt(PAGE_SIZE):offset;
    const start=space.start+offset,end=start+BigInt(PAGE_SIZE)<space.end?start+BigInt(PAGE_SIZE):space.end;
    const bytes=[];
    for(let at=start;at<end;at++){
      const region=machine.regionAt(at);
      bytes.push({address:at,value:region&&region.readable!==false?machine.memory.get(at)??0:null,released:at<space.liveStart});
    }
    return {offset,start,end,bytes,hasPrevious:offset>0n,hasNext:end<space.end};
  }
  const api={initial,advance,page,MAX_SPACES,MAX_CHANGES,PAGE_SIZE,hex};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensStack=api;
})(typeof globalThis!=='undefined'?globalThis:this);

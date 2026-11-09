(function(root){
  'use strict';
  class RunController {
    constructor(machine,breakpoints=new Set(),onStep=()=>{}){this.machine=machine;this.breakpoints=breakpoints;this.onStep=onStep;this.resetWarnings();this.begin();}
    resetWarnings(){this.warningAcknowledged=false;}
    begin(){this.first=true;}
    advance(){
      const m=this.machine;
      if(m.status!=='ready')return m.status;
      if(!this.first&&this.breakpoints.has(m.rip.toString()))return 'breakpoint';
      this.first=false;m.step();this.onStep(m);
      if(m.status!=='ready')return m.status;
      if(m.lastEvent?.warnings.length&&!this.warningAcknowledged){this.warningAcknowledged=true;return 'warning';}
      return null;
    }
  }
  const api={RunController};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensExecution=api;
})(typeof globalThis!=='undefined'?globalThis:this);

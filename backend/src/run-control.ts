import type { DatabaseService } from "./database.service";

/** Durable cancellation: the cancel request may reach a different server instance. */
export class RunControl{
  private readonly controller=new AbortController();
  private timer:ReturnType<typeof setInterval>|undefined;
  private checking=false;
  readonly signal=this.controller.signal;
  constructor(private readonly db:DatabaseService,private readonly id:string,private readonly userId:string){}
  async check(){
    const row=await this.db.one<{status:string}>("SELECT status FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[this.id,this.userId]);
    if(row?.status==="cancel_requested")this.controller.abort();
  }
  async start(){
    await this.check();
    this.timer=setInterval(()=>{
      if(this.checking||this.signal.aborted)return;
      this.checking=true;
      void this.check().catch(()=>{ /* A transient DB failure is not a cancellation. */ }).finally(()=>{this.checking=false;});
    },400);
    this.timer.unref();
  }
  stop(){if(this.timer)clearInterval(this.timer);}
}

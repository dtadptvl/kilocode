import type {Plugin} from "@kilocode/plugin"
import{bridgeQueries,close,queries,rank,render,type Trace}from"./core.js"

const ZeroMem:Plugin=async({client,directory})=>{
  const cache=new Map<string,{updated:number;rows:Trace[]}>()
  return{"experimental.chat.messages.transform":async(_input,output)=>{
    const current=[...output.messages].reverse().find(m=>m.info.role==="user")
    if(!current)return
    const text=current.parts.filter((p:any)=>p.type==="text"&&!p.synthetic&&!p.ignored).map((p:any)=>p.text).join("\n").trim()
    if(!queries(text).length)return
    if(current.parts.some((p:any)=>p.type==="text"&&p.synthetic&&String(p.text).startsWith("<kilo_zero_mem")))return

    const listed=await client.session.list({query:{directory}})
    const sessions=(listed.data??[]).filter(s=>s.id!==current.info.sessionID).slice(0,12)
    const traces:Trace[]=[]
    const by=new Map<string,Trace[]>()

    for(const session of sessions){
      let hit=cache.get(session.id)
      if(!hit||hit.updated!==session.time.updated){
        const res=await client.session.messages({path:{id:session.id},query:{directory,limit:200}})
        const rows:Trace[]=[]
        for(const message of res.data??[])for(const part of message.parts){
          if(part.type!=="text"||part.synthetic||part.ignored||!part.text?.trim())continue
          rows.push({sessionID:session.id,partID:part.id,role:message.info.role,text:part.text,updated:message.info.time.created})
        }
        hit={updated:session.time.updated,rows}
        cache.set(session.id,hit)
      }
      by.set(session.id,hit.rows)
      traces.push(...hit.rows)
    }

    let seeds=rank(text,traces,6)
    const bridges=bridgeQueries(text,seeds)
    if(bridges.length){
      const extra=bridges.flatMap(q=>rank(q,traces,4))
      const unique=new Map<string,(typeof seeds)[number]>()
      for(const seed of[...seeds,...extra]){
        const key=seed.sessionID+":"+seed.partID
        const old=unique.get(key)
        if(!old||seed.score>old.score)unique.set(key,seed)
      }
      seeds=[...unique.values()].sort((a,b)=>b.score-a.score||b.updated-a.updated).slice(0,8)
    }

    const evidence=render(close(seeds,by))
    if(!evidence)return
    current.parts.push({id:"zero_mem_"+Date.now(),sessionID:current.info.sessionID,messageID:current.info.id,type:"text",text:evidence,synthetic:true}as any)
  }}
}

export default ZeroMem
export{ZeroMem}

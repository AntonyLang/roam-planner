import type {AxiosInstance} from 'axios'

export function parseSseBlock(block:string){
  let kind='message',id='',parts:string[]=[]
  for(const line of block.replace(/\r/g,'').split('\n')){
    if(line.startsWith('event:'))kind=line.slice(6).trim()
    else if(line.startsWith('id:'))id=line.slice(3).trim()
    else if(line.startsWith('data:'))parts.push(line.slice(5).trimStart())
  }
  return parts.length?{kind,id,data:JSON.parse(parts.join('\n'))}:undefined
}

export async function readSessionEvents(api:AxiosInstance,url:string,signal:AbortSignal,onEvent:(data:any)=>void){
  // The fetch adapter preserves the configured authentication/interceptors and exposes the real stream.
  const {data}=await api.get<ReadableStream<Uint8Array>>(url,{adapter:'fetch',responseType:'stream',timeout:0,signal})
  if(!data?.getReader)throw new Error('Streaming transport is unavailable')
  const reader=data.getReader(),decoder=new TextDecoder()
  let buffer=''
  try{
    while(!signal.aborted){
      const result=await reader.read()
      if(result.done)break
      buffer+=decoder.decode(result.value,{stream:true})
      buffer=buffer.replace(/\r\n/g,'\n')
      let boundary:number
      while((boundary=buffer.indexOf('\n\n'))>=0){
        const event=parseSseBlock(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2)
        if(event)onEvent(event.data)
      }
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}

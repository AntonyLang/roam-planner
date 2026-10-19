import {useEffect,useState} from 'react'
import {apiClient} from '../../api/client'

type Stay={name:string;dateRange:string;notes?:string;ref?:string}
export default function AssistantConfirmations({tripId,stays,unknowns,onFocus}:{tripId:number;stays:Stay[];unknowns:string[];onFocus:(ref:string)=>void}){
  const [confirmed,setConfirmed]=useState<string[]>([])
  const [error,setError]=useState('')
  useEffect(()=>{
    const controller=new AbortController();setConfirmed([])
    apiClient.get(`/agent/trips/${tripId}/confirmations`,{signal:controller.signal}).then(({data})=>setConfirmed(data.keys))
      .catch(()=>{if(!controller.signal.aborted)setError('确认状态读取失败，请重试。')})
    return()=>controller.abort()
  },[tripId])
  const confirm=async(key:string)=>{
    setConfirmed(values=>[...values,key]);setError('')
    try{await apiClient.post(`/agent/trips/${tripId}/confirmations`,{key})}
    catch{setConfirmed(values=>values.filter(value=>value!==key));setError('确认未保存，请重试。')}
  }
  const cards=[...stays.map(stay=>({key:JSON.stringify(['stay',stay.name,stay.dateRange,stay.notes??'']),title:stay.name,subtitle:stay.dateRange,text:stay.notes??'',ref:stay.ref,kind:'住宿建议 · 未预订'})),
    ...unknowns.map(text=>({key:JSON.stringify(['unknown',text]),title:'待确认与限制',subtitle:'',text,ref:undefined,kind:'出行提醒'}))].filter(card=>!confirmed.includes(card.key))
  return <div className="assistant-confirmations">{cards.map(card=><article key={card.key} className="assistant-confirmation"><small>{card.kind}</small><strong>{card.ref?<button onClick={()=>onFocus(card.ref!)}>{card.title}</button>:card.title}</strong>{card.subtitle&&<span>{card.subtitle}</span>}<p>{card.text}</p><button className="assistant-confirm" onClick={()=>void confirm(card.key)}>已确认</button></article>)}{error&&<p role="alert">{error}</p>}</div>
}

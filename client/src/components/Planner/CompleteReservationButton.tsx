import {useState} from 'react'
import {reservationsApi} from '../../api/client'
import {useTripStore} from '../../store/tripStore'
import {useToast} from '../shared/Toast'
import type {Reservation} from '../../types'

export default function CompleteReservationButton({tripId,reservation}:{tripId:number;reservation:Reservation}){
  const [saving,setSaving]=useState(false)
  const toast=useToast()
  if(reservation.status==='confirmed')return <span style={{fontSize:12,color:'#34846e',whiteSpace:'nowrap'}}>✓ 已完成</span>
  return <button type="button" disabled={saving} aria-label={`完成预订：${reservation.title}`} onClick={async event=>{
    event.stopPropagation();setSaving(true)
    try{
      const {reservation:updated}=await reservationsApi.update(tripId,reservation.id,{status:'confirmed'})
      if(useTripStore.getState().trip?.id===tripId)useTripStore.setState(state=>({reservations:state.reservations.map(row=>row.id===reservation.id?updated:row)}))
    }catch{toast.error('预订状态未保存，请重试。')}
    finally{setSaving(false)}
  }} style={{border:'1px solid #34846e50',borderRadius:7,padding:'5px 9px',background:'#34846e0d',color:'#28735f',fontSize:12,whiteSpace:'nowrap',cursor:'pointer'}}>{saving?'保存中…':'已完成'}</button>
}

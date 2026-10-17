import React,{useState} from 'react'
export type SelectedAnswer={question_id:string;option_id?:string|null;text:string}
export default function AgentQuestionCard({pending,active,busy,onAnswer}:{pending:any;active:boolean;busy:boolean;onAnswer:(text:string,choice?:string,answers?:SelectedAnswer[])=>Promise<boolean>}){
  const structured=Array.isArray(pending.questions)&&pending.questions.length>0
  const questions:any[]=structured?pending.questions:[{id:'confirmation',title:'',options:(pending.choices??[]).map((id:string)=>({id,label:id==='approve'?'同意':id==='decline'?'不同意':id}))}]
  const [values,setValues]=useState<Record<string,{option?:string;custom?:string}>>({})
  const valid=questions.every(q=>values[q.id]?.option==='custom'?!!values[q.id]?.custom?.trim():q.options?.some((o:any)=>o.id===values[q.id]?.option))
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();if(!valid||!active||busy)return
    const answers:SelectedAnswer[]=questions.map(q=>{const v=values[q.id],custom=v.option==='custom';return {question_id:q.id,option_id:custom?null:v.option,text:custom?v.custom!.trim():q.options.find((o:any)=>o.id===v.option).label}})
    const text=answers.map((a,i)=>`${questions[i].title?questions[i].title+'：':''}${a.text}`).join('\n')
    const choice=!structured&&answers[0].option_id&&['approve','decline'].includes(answers[0].option_id)?answers[0].option_id:undefined
    await onAnswer(text,choice,structured?answers:undefined)
  }
  return <form className="assistant-question-card" onSubmit={submit}>
    <div className="assistant-question-heading">{pending.question}</div>
    {active?questions.map(q=><fieldset key={q.id} disabled={!active||busy}>
      {q.title&&<legend>{q.title}</legend>}
      {(q.options??[]).map((o:any)=><label className="assistant-choice" key={o.id}>
        <input type="radio" name={`${pending.decision_id}:${q.id}`} value={o.id} checked={values[q.id]?.option===o.id} onChange={()=>setValues(v=>({...v,[q.id]:{...v[q.id],option:o.id}}))}/><span>{o.label}{o.description&&<small>{o.description}</small>}</span>
      </label>)}
      <label className="assistant-choice"><input type="radio" name={`${pending.decision_id}:${q.id}`} checked={values[q.id]?.option==='custom'} onChange={()=>setValues(v=>({...v,[q.id]:{...v[q.id],option:'custom'}}))}/><span>自己输入</span></label>
      <textarea aria-label={`${q.title||'这项问题'}自己输入`} placeholder="填写你的想法…" maxLength={5000} value={values[q.id]?.custom??''} onChange={e=>setValues(v=>({...v,[q.id]:{option:'custom',custom:e.target.value}}))}/>
    </fieldset>):<div className="assistant-question-history">{questions.map(q=><div key={q.id}>{q.title&&<p>{q.title}</p>}{q.options?.length>0&&<small>候选：{q.options.map((o:any)=>o.label).join(' / ')} · 可自行输入</small>}</div>)}<small>这轮问题已结束，回答保留在下方对话中。</small></div>}
    {active&&<button type="submit" disabled={busy||!valid}>提交回答</button>}
  </form>
}

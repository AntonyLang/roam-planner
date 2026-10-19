import {fireEvent,render,screen,waitFor} from '../../../tests/helpers/render'
import {expect,it,vi} from 'vitest'
import {useTripStore} from '../../store/tripStore'
import CompleteReservationButton from './CompleteReservationButton'
const api=vi.hoisted(()=>({update:vi.fn()}))
vi.mock('../../api/client',async original=>({...await original<any>(),reservationsApi:{update:api.update}}))
it('writes confirmed status and updates the visible booking without opening its edit form',async()=>{
  const reservation={id:99,title:'汉庭双床房',status:'pending'} as any
  useTripStore.setState({trip:{id:1} as any,reservations:[reservation]})
  api.update.mockResolvedValue({reservation:{...reservation,status:'confirmed'}})
  const view=render(<CompleteReservationButton tripId={1} reservation={reservation}/>)
  fireEvent.click(screen.getByRole('button',{name:'完成预订：汉庭双床房'}))
  await waitFor(()=>expect(useTripStore.getState().reservations[0].status).toBe('confirmed'))
  expect(api.update).toHaveBeenCalledWith(1,99,{status:'confirmed'})
  view.rerender(<CompleteReservationButton tripId={1} reservation={useTripStore.getState().reservations[0]}/>)
  expect(screen.getByText('✓ 已完成')).toBeVisible()
  expect(screen.queryByRole('button')).toBeNull()
})

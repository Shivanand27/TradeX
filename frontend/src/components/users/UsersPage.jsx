import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getUsers, createUser, updateUser, deleteUser } from '../../lib/api'
import toast from 'react-hot-toast'
import { useTheme } from '../../store'

const PLANS = ['PRO','BASIC','SIGNALS','TRIAL']
const STATUS = ['active','inactive','pending']

function Badge({ val }) {
  const colors = { active:'#00e676', inactive:'#ff3b4e', pending:'#f5a523', PRO:'#00d4ff', BASIC:'#9d7cf4', SIGNALS:'#f5a523', TRIAL:'#6a8099' }
  const c = colors[val] || '#6a8099'
  return <span style={{ fontSize:9, padding:'2px 7px', borderRadius:2, background:`${c}18`, color:c, border:`1px solid ${c}30`, fontFamily:'"IBM Plex Mono",monospace', textTransform:'uppercase' }}>{val}</span>
}

function AddUserModal({ onClose, onSave }) {
  const [form, setForm] = useState({ full_name:'', email:'', plan:'PRO', payment_ref:'', amount:'', valid_until:'' })
  const upd = k => e => setForm(f=>({...f,[k]:e.target.value}))
  const inp = { background:'#14191f', border:'1px solid #1f2830', color:'#c8d8e8', fontSize:11, padding:'5px 8px', fontFamily:'"IBM Plex Mono",monospace', width:'100%', outline:'none', borderRadius:2 }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(6,8,9,.85)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ width:480, background:'#0a0d10', border:'1px solid #1f2830', borderRadius:4, overflow:'hidden' }}>
        <div style={{ background:'#ff8c00', padding:'10px 14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ color:'#000', fontWeight:700, fontSize:12, letterSpacing:.5 }}>ADD NEW USER</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#000', fontSize:14, cursor:'pointer', fontWeight:700 }}>✕</button>
        </div>
        <div style={{ padding:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {[['Full Name','full_name','text'],['Email','email','email'],['Payment Ref','payment_ref','text'],['Amount (₹)','amount','number']].map(([l,k,t])=>(
            <div key={k}><div style={{ fontSize:9, color:'#334455', marginBottom:3, letterSpacing:.4 }}>{l.toUpperCase()}</div><input type={t} value={form[k]} onChange={upd(k)} style={inp} /></div>
          ))}
          <div><div style={{ fontSize:9, color:'#334455', marginBottom:3 }}>PLAN</div>
            <select value={form.plan} onChange={upd('plan')} style={{ ...inp }}>
              {PLANS.map(p=><option key={p}>{p}</option>)}
            </select>
          </div>
          <div><div style={{ fontSize:9, color:'#334455', marginBottom:3 }}>VALID UNTIL</div><input type="date" value={form.valid_until} onChange={upd('valid_until')} style={inp} /></div>
        </div>
        <div style={{ padding:'0 16px 16px', display:'flex', gap:8 }}>
          <button onClick={()=>onSave(form)} style={{ background:'#ff8c00', color:'#000', border:'none', padding:'7px 18px', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>CREATE USER & SEND EMAIL</button>
          <button onClick={onClose} style={{ background:'#14191f', color:'#6a8099', border:'1px solid #1f2830', padding:'7px 14px', fontSize:10, cursor:'pointer', fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>CANCEL</button>
        </div>
      </div>
    </div>
  )
}

export default function UsersPage() {
  const [showAdd, setShowAdd] = useState(false)
  const [search,  setSearch]  = useState('')
  const qc = useQueryClient()

  const { data } = useQuery({ queryKey:['users'], queryFn:getUsers, retry:1 })
  const users = (data?.users || MOCK_USERS).filter(u =>
    !search || u.full_name?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase())
  )

  const createMut = useMutation({
    mutationFn: createUser,
    onSuccess: () => { qc.invalidateQueries(['users']); setShowAdd(false); toast.success('User created & welcome email sent') },
    onError:   () => toast.error('Create failed')
  })
  const updateMut = useMutation({
    mutationFn: ({id,...d}) => updateUser(id,d),
    onSuccess: () => qc.invalidateQueries(['users'])
  })
  const deleteMut = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => { qc.invalidateQueries(['users']); toast.success('User removed') }
  })

  const TH = { padding:'7px 12px', fontSize:8, color:'#334455', letterSpacing:.5, textTransform:'uppercase', borderBottom:'1px solid #1f2830', textAlign:'left', fontFamily:'"IBM Plex Mono",monospace', whiteSpace:'nowrap' }
  const TD = { padding:'9px 12px', fontSize:11, borderBottom:'1px solid rgba(31,40,48,.6)', verticalAlign:'middle' }

  const t = useTheme()
  return (
    <div style={{ flex:1, overflowY:'auto', padding:16, background:t.bg }}>
      {showAdd && <AddUserModal onClose={()=>setShowAdd(false)} onSave={d=>createMut.mutate(d)} />}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:600, color:'#ff8c00', letterSpacing:.5 }}>USER MANAGEMENT {'<GO>'}</div>
          <div style={{ fontSize:10, color:'#334455', marginTop:2 }}>Add users after offline payment. Each user configures their own broker API keys.</div>
        </div>
        <button onClick={()=>setShowAdd(true)} style={{ background:'#ff8c00', color:'#000', border:'none', padding:'7px 16px', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>+ ADD USER</button>
      </div>

      <div style={{ background:'#0a0d10', border:'1px solid #1f2830', borderRadius:3, overflow:'hidden' }}>
        <div style={{ display:'flex', alignItems:'center', background:'#0f1317', borderBottom:'1px solid #1f2830', padding:'0 12px', height:28, gap:10 }}>
          <span style={{ fontSize:10, color:'#ff8c00', letterSpacing:.4 }}>REGISTERED USERS ({users.length})</span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search users..."
            style={{ marginLeft:'auto', background:'#14191f', border:'1px solid #1f2830', color:'#c8d8e8', fontSize:10, padding:'3px 8px', width:180, outline:'none', fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }} />
        </div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', minWidth:800 }}>
            <thead>
              <tr>
                {['User','Email','Plan','Status','Groww','Delta','Bot','Valid Until','Actions'].map(h=><th key={h} style={TH}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {users.map(u=>(
                <tr key={u.id} onMouseEnter={e=>e.currentTarget.style.background='#0f1317'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <td style={TD}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ width:24, height:24, borderRadius:'50%', background:'#3d8ef8', display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, color:'#fff', flexShrink:0 }}>
                        {u.full_name?.split(' ').map(n=>n[0]).join('').slice(0,2)}
                      </div>
                      <span style={{ fontWeight:500, color:'#c8d8e8' }}>{u.full_name}</span>
                    </div>
                  </td>
                  <td style={{ ...TD, color:'#6a8099' }}>{u.email}</td>
                  <td style={TD}><Badge val={u.plan} /></td>
                  <td style={TD}><Badge val={u.status} /></td>
                  <td style={{ ...TD, fontFamily:'"IBM Plex Mono",monospace', fontSize:9, color: u.groww_connected?'#00e676':'#334455' }}>{u.groww_connected?'✓ Connected':'— Not set'}</td>
                  <td style={{ ...TD, fontFamily:'"IBM Plex Mono",monospace', fontSize:9, color: u.delta_connected?'#00e676':u.delta_paper?'#f5a523':'#334455' }}>{u.delta_connected?(u.delta_paper?'✓ Testnet':'✓ Live'):'— Not set'}</td>
                  <td style={TD}><Badge val={u.bot_enabled?'ON':'OFF'} /></td>
                  <td style={{ ...TD, color:'#334455', fontFamily:'"IBM Plex Mono",monospace', fontSize:9 }}>{u.valid_until}</td>
                  <td style={TD}>
                    <button style={{ background:'#14191f', border:'1px solid #1f2830', color:'#6a8099', fontSize:9, padding:'2px 8px', cursor:'pointer', marginRight:4, fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>EDIT</button>
                    <button onClick={()=>updateMut.mutate({ id:u.id, status: u.status==='active'?'inactive':'active' })}
                      style={{ background:'#14191f', border:'1px solid #1f2830', color: u.status==='active'?'#ff3b4e':'#00e676', fontSize:9, padding:'2px 8px', cursor:'pointer', marginRight:4, fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>
                      {u.status==='active'?'PAUSE':'ACTIVATE'}
                    </button>
                    <button onClick={()=>{ if(confirm(`Remove ${u.full_name}?`)) deleteMut.mutate(u.id) }}
                      style={{ background:'rgba(255,59,78,.1)', border:'1px solid rgba(255,59,78,.3)', color:'#ff3b4e', fontSize:9, padding:'2px 8px', cursor:'pointer', fontFamily:'"IBM Plex Mono",monospace', borderRadius:2 }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const MOCK_USERS = [
  { id:'1', full_name:'Arjun Reddy',  email:'arjun@gmail.com',    plan:'PRO',     status:'active',   groww_connected:true,  delta_connected:true,  delta_paper:false, bot_enabled:true,  valid_until:'31-Dec-2025' },
  { id:'2', full_name:'Priya Mehta',  email:'priya@hotmail.com',  plan:'BASIC',   status:'active',   groww_connected:true,  delta_connected:false, delta_paper:true,  bot_enabled:false, valid_until:'30-Nov-2025' },
  { id:'3', full_name:'Suresh Kumar', email:'suresh@yahoo.in',    plan:'PRO',     status:'pending',  groww_connected:false, delta_connected:true,  delta_paper:true,  bot_enabled:false, valid_until:'07-days trial' },
  { id:'4', full_name:'Deepa Varma',  email:'deepa@gmail.com',    plan:'SIGNALS', status:'inactive', groww_connected:false, delta_connected:false, delta_paper:true,  bot_enabled:false, valid_until:'Expired' },
]
